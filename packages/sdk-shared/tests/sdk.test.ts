/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DocEditor } from '../src/index'
import type { EditorConfigRoot, HostMessage, IframeMessage } from '../src/index'

/**
 * The SDK talks to its iframe via postMessage. jsdom doesn't actually load
 * iframes, so we mock the iframe's `contentWindow` and drive the protocol
 * by hand — exactly what we need to prove the SDK's end of the protocol is
 * correct.
 *
 * Cross-origin verification (real iframe at a different origin) is covered
 * by a Playwright integration test in Phase 1, not Phase 0.
 */

interface MockedIframe {
  iframe: HTMLIFrameElement
  /** captured messages host → iframe */
  posted: HostMessage[]
  /** pretending to be the iframe: dispatch a message event back to the host */
  emit: (msg: IframeMessage) => void
}

/**
 * Capture host→iframe traffic by replacing the iframe's contentWindow with a
 * stub whose postMessage records messages. The SDK's listener then sees the
 * iframe as the source via `e.source === iframe.contentWindow`.
 *
 * Must be called AFTER `new DocEditor(...)` (so the iframe exists in the DOM).
 */
function mountIframe(docEditor: DocEditor): MockedIframe {
  const iframe = document.querySelector('iframe')!
  expect(iframe).not.toBeNull()
  const posted: HostMessage[] = []
  const fakeContentWindow = {
    postMessage: (msg: HostMessage, _origin: string) => {
      posted.push(msg)
    },
  }
  Object.defineProperty(iframe, 'contentWindow', {
    value: fakeContentWindow,
    configurable: true,
  })

  const editorOrigin = docEditor.editorOrigin
  const emit = (msg: IframeMessage): void => {
    // `window.dispatchEvent` fires the SDK's listener with our fake source.
    const event = new MessageEvent('message', {
      data: msg,
      origin: editorOrigin,
      source: fakeContentWindow as MessageEventSource,
    })
    window.dispatchEvent(event)
  }
  return { iframe, posted, emit }
}

function minimalConfig(overrides: Partial<EditorConfigRoot> = {}): EditorConfigRoot {
  return {
    documentType: 'word',
    document: {
      key: 'Khirz6zTPdfd7',
      url: 'https://host/files/abc.docx',
      fileType: 'docx',
    },
    editorConfig: {
      mode: 'edit',
      callbackUrl: 'https://host/track',
      user: { id: 'u1', name: 'Alice' },
    },
    ...overrides,
  }
}

describe('DocEditor', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="placeholder"></div>'
  })

  it('rejects a config missing document.url', () => {
    const bad = minimalConfig({ document: { key: 'k', fileType: 'docx', url: '' } })
    expect(() => new DocEditor('placeholder', bad)).toThrow(/document\.url is required/)
    expect(document.getElementById('placeholder')).not.toBeNull()
  })

  it('rejects a config missing document.key', () => {
    const bad = minimalConfig({
      document: { url: 'https://h/x.docx', fileType: 'docx', key: '' },
    })
    expect(() => new DocEditor('placeholder', bad)).toThrow(/document\.key is required/)
  })

  it('rejects an invalid key charset', () => {
    const bad = minimalConfig({
      document: { url: 'https://h/x.docx', fileType: 'docx', key: 'has spaces!' },
    })
    expect(() => new DocEditor('placeholder', bad)).toThrow(/document\.key/)
  })

  it('rejects edit mode without callbackUrl', () => {
    const bad = minimalConfig({
      editorConfig: { mode: 'edit', user: { id: 'u' } },
    })
    expect(() => new DocEditor('placeholder', bad)).toThrow(/callbackUrl/)
  })

  it('throws when the placeholder element does not exist', () => {
    expect(() => new DocEditor('does-not-exist', minimalConfig())).toThrow(/placeholder/)
  })

  it('replaces the placeholder with an iframe pointing at /editor/<documentType>/', () => {
    const editor = new DocEditor('placeholder', minimalConfig())
    expect(document.getElementById('placeholder')).toBeNull()
    const iframe = document.querySelector('iframe')
    expect(iframe).not.toBeNull()
    expect(iframe?.getAttribute('src')).toContain('/editor/word/')
    editor.destroyEditor()
  })

  it('uses /editor/pdf/ when documentType is pdf', () => {
    const editor = new DocEditor(
      'placeholder',
      minimalConfig({
        documentType: 'pdf',
        document: { key: 'k', url: 'https://h/x.pdf', fileType: 'pdf' },
      }),
    )
    expect(document.querySelector('iframe')?.getAttribute('src')).toContain('/editor/pdf/')
    editor.destroyEditor()
  })

  it('sends the init message only after the iframe signals app-ready', () => {
    const editor = new DocEditor('placeholder', minimalConfig())
    const { posted, emit } = mountIframe(editor)
    expect(posted).toEqual([])
    emit({ type: 'app-ready' })
    expect(posted).toHaveLength(1)
    expect(posted[0].type).toBe('init')
    if (posted[0].type === 'init') {
      expect(posted[0].config.documentType).toBe('word')
      expect(posted[0].config.document.key).toBe('Khirz6zTPdfd7')
      expect(posted[0].protocol).toBe(1)
    }
    editor.destroyEditor()
  })

  it('dispatches onDocumentReady when the iframe fires the event', () => {
    const ready = vi.fn()
    const config = minimalConfig({ events: { onDocumentReady: ready } })
    const editor = new DocEditor('placeholder', config)
    const { emit } = mountIframe(editor)
    emit({ type: 'app-ready' })
    emit({ type: 'event', name: 'onDocumentReady' })
    expect(ready).toHaveBeenCalledTimes(1)
    expect(ready.mock.calls[0][0].target).toBe(editor)
    editor.destroyEditor()
  })

  it('dispatches onError with the payload as event.data', () => {
    const onError = vi.fn()
    const config = minimalConfig({ events: { onError } })
    const editor = new DocEditor('placeholder', config)
    const { emit } = mountIframe(editor)
    emit({ type: 'app-ready' })
    emit({
      type: 'event',
      name: 'onError',
      data: { errorCode: -1, errorDescription: 'nope' },
    })
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0][0].data).toEqual({
      errorCode: -1,
      errorDescription: 'nope',
    })
    editor.destroyEditor()
  })

  it('dispatches onDocumentStateChange with the dirty boolean', () => {
    const onDirty = vi.fn()
    const config = minimalConfig({ events: { onDocumentStateChange: onDirty } })
    const editor = new DocEditor('placeholder', config)
    const { emit } = mountIframe(editor)
    emit({ type: 'app-ready' })
    emit({ type: 'event', name: 'onDocumentStateChange', data: true })
    emit({ type: 'event', name: 'onDocumentStateChange', data: false })
    expect(onDirty.mock.calls[0][0].data).toBe(true)
    expect(onDirty.mock.calls[1][0].data).toBe(false)
    editor.destroyEditor()
  })

  it('routes method calls (downloadAs) through postMessage and resolves on response', async () => {
    const editor = new DocEditor('placeholder', minimalConfig())
    const { posted, emit } = mountIframe(editor)
    emit({ type: 'app-ready' })
    posted.length = 0

    const promise = editor.downloadAs()
    expect(posted).toHaveLength(1)
    expect(posted[0].type).toBe('method')
    if (posted[0].type === 'method') {
      expect(posted[0].method).toBe('downloadAs')
      emit({ type: 'method-response', id: posted[0].id, result: 'ok' })
    }
    await expect(promise).resolves.toBe('ok')
    editor.destroyEditor()
  })

  it('rejects method calls if the iframe returns an error', async () => {
    const editor = new DocEditor('placeholder', minimalConfig())
    const { posted, emit } = mountIframe(editor)
    emit({ type: 'app-ready' })
    posted.length = 0

    const promise = editor.downloadAs()
    if (posted[0].type === 'method') {
      emit({ type: 'method-response', id: posted[0].id, error: 'nope' })
    }
    await expect(promise).rejects.toThrow(/nope/)
    editor.destroyEditor()
  })

  it('removes the iframe from the DOM on destroyEditor', () => {
    const editor = new DocEditor('placeholder', minimalConfig())
    expect(document.querySelector('iframe')).not.toBeNull()
    editor.destroyEditor()
    expect(document.querySelector('iframe')).toBeNull()
  })

  it('ignores messages from a different origin', () => {
    const ready = vi.fn()
    const config = minimalConfig({ events: { onDocumentReady: ready } })
    const editor = new DocEditor('placeholder', config)
    mountIframe(editor)
    // Synthesize a message with the wrong origin — SDK should ignore.
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'event', name: 'onDocumentReady' },
        origin: 'https://wrong.example',
        source: null,
      }),
    )
    expect(ready).not.toHaveBeenCalled()
    editor.destroyEditor()
  })

  it('registers window.GenOfficeAPI on import', () => {
    // Static import already ran the module's global-registration side effect.
    expect(window.GenOfficeAPI).toBeDefined()
    expect(window.GenOfficeAPI?.DocEditor).toBe(DocEditor)
  })
})
