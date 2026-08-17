/**
 * Browser-side implementation of the docs renderer's `DesktopApi` contract.
 *
 * The renderer (apps/docs/src/renderer/) calls `window.desktop.X(...)` for
 * every main-process interaction. In the web iframe, we replace that bridge
 * with this client, which:
 *   - reads the editor config the host SDK postMessaged to us
 *   - calls /fetch-document and /save-document on the editor service (same
 *     origin as the iframe)
 *   - uses File System Access API for open/save/image pickers
 *   - uses IndexedDB for crash-recovery copies and attachment bytes
 *   - stubs the menu/close/telemetry surface that has no web equivalent
 *   - stubs AI calls (Phase 4 fills these in with /ai/* routes)
 *
 * Shape mirrors @prismoffice/docs/shared/ipc `DesktopApi` 1:1 — the renderer
 * code does not change between desktop and web.
 */

import type {
  AttachmentAddResult,
  AttachmentImageResult,
  AttachmentReadResult,
  AiChatRequest,
  AiChatResponse,
  AiSettings,
  AiStreamChunk,
  AiStreamRequest,
  DesktopApi,
  DocsTabInfo,
  GenSparkAccountStatus,
  MenuCommand,
  OpenFileResult,
  PickImageResult,
  UiTheme,
} from '@prismoffice/docs/shared/ipc'
import type { EditorConfigRoot } from '@prismoffice/editor-contract'
import { attachmentStore, newId, recoveryStore } from './storage.js'

type Lang = 'zh' | 'en' | 'ja' | 'ko' | 'fr' | 'de' | 'es' | 'th' | 'id' | 'ru' | 'ar'

interface WebRuntimeOpts {
  config: EditorConfigRoot
  /** Optional sink for SDK events the web client should fire at the host
   *  (onDocumentReady / onDocumentStateChange). Defaults to postMessage to
   *  window.parent. */
  postSdkEvent?: (name: string, data?: unknown) => void
}

export function createDesktopApi(opts: WebRuntimeOpts): DesktopApi {
  const { config } = opts
  const postSdkEvent =
    opts.postSdkEvent ??
    ((name: string, data?: unknown) => {
      window.parent?.postMessage({ type: 'event', name, data }, '*')
    })

  const lang = (config.editorConfig?.lang as Lang | undefined) ?? 'en'
  const theme = ((config.editorConfig as any)?.customization?.uiTheme ?? 'light') as UiTheme
  const aiSettings: AiSettings = {
    provider: (config.editorConfig?.customization?.ai?.model as AiSettings['provider']) ?? 'claude',
  } as AiSettings

  // Stream subscriptions for AI (Phase 4 will wire /ai/stream)
  const aiStreamHandlers = new Set<(chunk: AiStreamChunk) => void>()

  // First-call flag for consumePendingOpenDocx — the renderer treats this
  // as "the file the host queued at launch". On web, that's config.document.url.
  let pendingOpenDelivered = false

  return {
    // -------------------------------------------------------------------------
    // Theme / language — driven by config (host's editorConfig.lang)
    // -------------------------------------------------------------------------
    async getLanguage() {
      return lang
    },
    onLanguageChanged() {
      return () => {}
    },
    async getTheme() {
      return theme
    },
    onThemeChanged() {
      return () => {}
    },
    onChromePressed() {
      return () => {}
    },
    async fontMetrics(_family: string) {
      return null
    },

    // -------------------------------------------------------------------------
    // File open — FSAccess picker; no host-side path concept, so we use the
    // file name as both `path` and `name`. The hash is sha256 of the bytes.
    // -------------------------------------------------------------------------
    async openDocx(): Promise<OpenFileResult | null> {
      const picked = await pickFiles({
        multiple: false,
        types: [
          {
            description: 'Word Document',
            accept: {
              'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
                ['.docx'],
            },
          },
        ],
      })
      if (!picked || picked.length === 0) return null
      return await toOpenFileResult(picked[0])
    },
    async openDocxPath(_path: string): Promise<OpenFileResult | null> {
      return null
    },
    async consumePendingOpenDocx(): Promise<OpenFileResult | null> {
      if (pendingOpenDelivered) return null
      pendingOpenDelivered = true
      try {
        const res = await fetch('/fetch-document', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ config: sanitizedConfigForSave(config) }),
        })
        if (!res.ok) {
          const errBody = await res.json().catch(() => null)
          postSdkEvent('onError', {
            errorCode: res.status,
            errorDescription: errBody?.error || `fetch-document ${res.status}`,
          })
          return null
        }
        const data = await res.arrayBuffer()
        const hash = res.headers.get('X-PrismOffice-Hash') ?? ''
        postSdkEvent('onDocumentReady')
        postSdkEvent('onDocumentStateChange', false)
        return {
          path: config.document.title ?? config.document.key,
          name: config.document.title ?? 'document.docx',
          data,
          hash,
        }
      } catch (e) {
        postSdkEvent('onError', {
          errorCode: -1,
          errorDescription: (e as Error).message,
        })
        return null
      }
    },
    async consumeNewBlankDoc(): Promise<boolean> {
      return false
    },
    onOpenDocx() {
      return () => {}
    },
    onRenamedDocx() {
      return () => {}
    },

    // -------------------------------------------------------------------------
    // Save — POST to /save-document (same origin). The path arg is the
    // document.key we got from the SDK config; the editor service matches it
    // against the verified config payload.
    // -------------------------------------------------------------------------
    async saveDocx(path, data, _auto) {
      postSdkEvent('onDocumentStateChange', true)
      try {
        const bytes = new Uint8Array(data)
        const res = await fetch('/save-document', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            config: sanitizedConfigForSave(config),
            bytes: bytesToBase64(bytes),
            filetype: 'docx',
          }),
        })
        if (!res.ok) {
          const body = await res.json().catch(() => ({ error: 'unknown' }))
          return { ok: false, error: body.error ?? `save-document ${res.status}` }
        }
        // path is preserved as the document.key — renderer keeps using it
        void path
        postSdkEvent('onDocumentStateChange', false)
        return { ok: true }
      } catch (e) {
        return { ok: false, error: (e as Error).message }
      }
    },
    async saveDocxAs(defaultName, data) {
      const saved = await saveFilePicker(defaultName, 'Word Document', '.docx', data)
      return saved
    },
    async saveDocxNew(defaultName, data) {
      return saveFilePicker(defaultName, 'Word Document', '.docx', data)
    },
    async writeRecoveryCopy(path, data) {
      try {
        await recoveryStore.put(path, data)
        return { ok: true }
      } catch {
        return { ok: false }
      }
    },
    async getRecentFiles(): Promise<string[]> {
      return []
    },

    // -------------------------------------------------------------------------
    // Image picker
    // -------------------------------------------------------------------------
    async pickImage(): Promise<PickImageResult | null> {
      const picked = await pickFiles({
        multiple: false,
        types: [
          {
            description: 'Image',
            accept: { 'image/*': ['.png', '.jpg', '.jpeg', '.gif', '.webp'] },
          },
        ],
      })
      if (!picked || picked.length === 0) return null
      const file = picked[0]
      const buf = await file.arrayBuffer()
      const mime = (file.type || 'image/png') as PickImageResult['mime']
      return { base64: bytesToBase64(new Uint8Array(buf)), mime, name: file.name }
    },

    // -------------------------------------------------------------------------
    // PDF export / print (Phase 2: best-effort via browser print)
    // -------------------------------------------------------------------------
    async print() {
      window.print()
      return { ok: true as const }
    },
    async exportPdf(_defaultName, _w, _h, _outPath) {
      // Phase 2: trigger browser print → user picks "Save as PDF".
      // Phase 6 will add a paginated render to a real PDF via the existing
      // docx-engine + pdf-lib flow.
      window.print()
      return { ok: true }
    },
    async printPdfBuffer() {
      return { ok: false, error: 'printPdfBuffer not supported on web (yet)' }
    },
    async saveMergedPdf() {
      return { ok: false, error: 'saveMergedPdf not supported on web (yet)' }
    },

    async getAiSettings() {
      try {
        const res = await fetch('/ai/settings')
        if (res.ok) {
          const body = (await res.json()) as { configured: boolean; provider: string | null }
          if (body.provider) {
            return { provider: body.provider } as unknown as AiSettings
          }
        }
      } catch {
        /* fall through to default */
      }
      return aiSettings
    },
    async setAiSettings(_settings) {
      /* settings are operator-configured via PRISMOFFICE_GSK_KEY */
    },
    async aiChat(_request: AiChatRequest): Promise<AiChatResponse> {
      throw new Error('aiChat not supported — use aiStream')
    },
    async aiStream(request: AiStreamRequest) {
      const res = await fetch('/ai/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ request }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: 'unknown' }))
        throw new Error(body.error ?? `ai/stream ${res.status}`)
      }
    },
    async aiStreamCancel(requestId: string) {
      await fetch('/ai/stream-cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId }),
      })
    },
    async aiGskStatus(_withEmail?: boolean): Promise<GenSparkAccountStatus> {
      try {
        const res = await fetch('/ai/settings')
        if (res.ok) {
          const body = (await res.json()) as { configured: boolean }
          return { loggedIn: body.configured, email: undefined } as unknown as GenSparkAccountStatus
        }
      } catch {
        /* fall through */
      }
      return { loggedIn: false, email: undefined } as unknown as GenSparkAccountStatus
    },
    async aiGskLogin() {
      /* Web auth flow not wired in v1 — operator configures PRISMOFFICE_GSK_KEY */
    },
    async webSearch(query: string, maxResults?: number) {
      const res = await fetch('/ai/web-search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, maxResults }),
      })
      return await res.json()
    },
    async imageSearch(query: string, maxResults?: number) {
      const res = await fetch('/ai/image-search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, maxResults }),
      })
      return await res.json()
    },
    async fetchImage(url: string) {
      const res = await fetch('/ai/fetch-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      })
      if (!res.ok) return null
      return await res.json()
    },

    // -------------------------------------------------------------------------
    // Chat attachments — picked via FSAccess, bytes cached in IndexedDB
    // (browsers have no absolute paths; we synthesize opaque ids)
    // -------------------------------------------------------------------------
    async pickAttachments(): Promise<AttachmentAddResult | null> {
      const files = await pickFiles({
        multiple: true,
        types: [
          {
            description: 'Attachment',
            accept: { '*/*': [] },
          },
        ],
      })
      if (!files) return null
      return await addAttachmentFiles(files)
    },
    async addAttachmentPaths(paths: string[]): Promise<AttachmentAddResult> {
      // No host paths on web; the renderer only calls this for dropped Files
      // (which we resolve via getPathForFile below). Return them as rejected
      // so the renderer doesn't try to read non-existent paths.
      return {
        accepted: [],
        rejected: paths.map((p) => `unsupported on web: ${p}`),
      }
    },
    async addPastedImage(data, ext) {
      const id = newId('paste-')
      const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`
      await attachmentStore.put(id, {
        bytes: data,
        name: `pasted-${id}.${ext}`,
        ext,
        mime,
      })
      return {
        accepted: [
          { path: id, name: `pasted-${id}.${ext}`, ext, sizeBytes: data.byteLength },
        ],
        rejected: [],
      }
    },
    async readAttachment(path, offset, maxChars): Promise<AttachmentReadResult> {
      const att = await attachmentStore.get(path)
      if (!att) return { ok: false, error: 'attachment not found' }
      const text = new TextDecoder().decode(att.bytes).slice(offset, offset + maxChars)
      return {
        ok: true,
        name: att.name,
        totalChars: att.bytes.byteLength,
        text,
        offset,
      }
    },
    async readAttachmentImage(path): Promise<AttachmentImageResult> {
      const att = await attachmentStore.get(path)
      if (!att) return { ok: false, error: 'attachment not found' }
      return {
        ok: true,
        base64: bytesToBase64(new Uint8Array(att.bytes)),
        mime: att.mime,
      }
    },
    getPathForFile(_file: File): string {
      // No absolute path on web. AiPanel uses this to detect dropped Files
      // and immediately calls addAttachmentPaths — we override the drop
      // handler in the renderer to call addPastedImage / pickAttachments
      // instead. Returning '' makes the renderer's path-based path a no-op.
      return ''
    },

    // -------------------------------------------------------------------------
    // Tab management — single-tab in v1 web; no host-side tab model
    // -------------------------------------------------------------------------
    async openNewTab(_openPath?: string | null) {
      window.open(window.location.href, '_blank')
    },
    async listDocsTabs(): Promise<DocsTabInfo[]> {
      return []
    },
    async focusDocsTab(_id: string) {
      /* no-op */
    },

    // -------------------------------------------------------------------------
    // AI streaming subscriptions (Phase 4 wires the actual SSE)
    // -------------------------------------------------------------------------
    onAiStream(handler: (chunk: AiStreamChunk) => void): () => void {
      aiStreamHandlers.add(handler)
      return () => aiStreamHandlers.delete(handler)
    },

    // -------------------------------------------------------------------------
    // Native menu / close-guard — the iframe SPA owns its own chrome; no
    // main-process handshake. The renderer already tolerates missing handlers
    // (optional `?.`), but we still expose no-op subscriptions so React
    // effects that always subscribe don't crash.
    // -------------------------------------------------------------------------
    onMenuCommand(_handler: (command: MenuCommand, payload?: string) => void): () => void {
      return () => {}
    },
    onCloseCheck(_handler: () => void): () => void {
      return () => {}
    },
    reportCloseCheck(_state: { dirty: boolean; autoSave: boolean; filePath?: string | null }): void {
      /* no-op */
    },
    onCloseSaveRequest(_handler: () => void): () => void {
      return () => {}
    },
    reportCloseSaveResult(_ok: boolean): void {
      /* no-op */
    },
    onTeardown(_handler: () => void): () => void {
      return () => {}
    },
    reportViewMenuState(_state: { aiSidebar: boolean; darkCanvas: boolean }): void {
      /* no-op */
    },
  }
}

// ---------------------------------------------------------------------------
// Helpers — File System Access API with fallback
// ---------------------------------------------------------------------------

interface PickOpts {
  multiple?: boolean
  types?: Array<{ description: string; accept: Record<string, string[]> }>
}

async function pickFiles(opts: PickOpts): Promise<File[] | null> {
  // FSAccess API
  const w = window as Window & {
    showOpenFilePicker?: (opts: {
      multiple?: boolean
      types?: Array<{ description: string; accept: Record<string, string[]> }>
    }) => Promise<Array<{ getFile: () => Promise<File> }>>
  }
  if (typeof w.showOpenFilePicker === 'function') {
    try {
      const handles = await w.showOpenFilePicker({
        multiple: opts.multiple ?? false,
        types: opts.types,
      })
      return await Promise.all(handles.map((h) => h.getFile()))
    } catch (e) {
      if ((e as Error).name === 'AbortError') return null
    }
  }
  // <input type=file> fallback
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = opts.multiple ?? false
    if (opts.types?.[0]?.accept) {
      const exts = Object.values(opts.types[0].accept).flat()
      input.accept = exts.join(',')
    }
    input.onchange = () => {
      const files = input.files ? Array.from(input.files) : []
      if (files.length === 0) return resolve(null)
      resolve(files)
    }
    input.click()
  })
}

async function saveFilePicker(
  defaultName: string,
  description: string,
  ext: string,
  data: ArrayBuffer,
): Promise<{ ok: boolean; path?: string; error?: string }> {
  const w = window as Window & {
    showSaveFilePicker?: (opts: {
      suggestedName?: string
      types?: Array<{ description: string; accept: Record<string, string[]> }>
    }) => Promise<{ name: string; createWritable: () => Promise<{ write: (d: ArrayBuffer) => Promise<void>; close: () => Promise<void> }> }>
  }
  if (typeof w.showSaveFilePicker === 'function') {
    try {
      const handle = await w.showSaveFilePicker({
        suggestedName: defaultName.endsWith(ext) ? defaultName : defaultName + ext,
        types: [
          {
            description,
            accept: { 'application/octet-stream': [ext] },
          },
        ],
      })
      const writable = await handle.createWritable()
      await writable.write(data)
      await writable.close()
      return { ok: true, path: handle.name }
    } catch (e) {
      if ((e as Error).name === 'AbortError') return { ok: false, error: 'cancelled' }
      return { ok: false, error: (e as Error).message }
    }
  }
  // <a download> fallback
  try {
    const blob = new Blob([data], { type: 'application/octet-stream' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = defaultName.endsWith(ext) ? defaultName : defaultName + ext
    a.click()
    URL.revokeObjectURL(url)
    return { ok: true, path: a.download }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

async function toOpenFileResult(file: File): Promise<OpenFileResult> {
  const buf = await file.arrayBuffer()
  const hash = await sha256Hex(new Uint8Array(buf))
  return { path: file.name, name: file.name, data: buf, hash }
}

async function addAttachmentFiles(files: File[]): Promise<AttachmentAddResult> {
  const accepted: AttachmentAddResult['accepted'] = []
  const rejected: string[] = []
  for (const f of files) {
    const ext = (f.name.split('.').pop() ?? '').toLowerCase()
    const id = newId('att-')
    try {
      await attachmentStore.put(id, {
        bytes: await f.arrayBuffer(),
        name: f.name,
        ext,
        mime: f.type || 'application/octet-stream',
      })
      accepted.push({ path: id, name: f.name, ext, sizeBytes: f.size })
    } catch (e) {
      rejected.push(`${f.name}: ${(e as Error).message}`)
    }
  }
  return { accepted, rejected }
}

// ---------------------------------------------------------------------------
// Helpers — encoding / hashing
// ---------------------------------------------------------------------------

function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(bin)
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  if (!crypto?.subtle) return ''
  const buf = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buf).set(bytes)
  const digest = await crypto.subtle.digest('SHA-256', buf)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * The save-document route validates the config token server-side. Strip
 * functions before sending (same reason as the SDK's sanitizeConfigForClone).
 */
function sanitizedConfigForSave(config: EditorConfigRoot): EditorConfigRoot {
  function strip(value: unknown): unknown {
    if (typeof value === 'function') return undefined
    if (Array.isArray(value)) return value.map(strip)
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        const stripped = strip(v)
        if (stripped !== undefined) out[k] = stripped
      }
      return out
    }
    return value
  }
  return strip(config) as EditorConfigRoot
}
