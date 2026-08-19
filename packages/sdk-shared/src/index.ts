/**
 * @prismoffice/sdk-shared
 *
 * The PrismOffice editor SDK, served to integrators at `/sdk/prismoffice.js`.
 *
 *     <script src="https://EDITOR_SERVICE_URL/sdk/prismoffice.js"></script>
 *     <script>
 *       const editor = new PrismOfficeAPI.DocEditor("placeholder", {
 *         documentType: "word",
 *         document: { key, url, fileType, ... },
 *         editorConfig: { callbackUrl, user, ... },
 *         events: { onDocumentReady: () => {...} },
 *         token: "<HS256 over the config, signed with browser secret>",
 *       })
 *     </script>
 *
 * The SDK:
 *   1. Validates required config fields.
 *   2. Derives the editor service origin from its own <script> src (so the
 *      same SDK script works for any deployment without configuration).
 *   3. Creates an iframe pointing at /editor/<documentType>.
 *   4. Replaces the placeholder element with the iframe.
 *   5. postMessages the signed config to the iframe once it's ready.
 *   6. Dispatches iframe events to the host's `events.*` callbacks.
 *   7. Exposes method calls (downloadAs, refreshHistory, ...) that postMessage
 *      to the iframe.
 */

import type {
  EditorConfigRoot,
  EditorUser,
  HistoryData,
  HistoryEntry,
  InsertImagePayload,
} from '@prismoffice/editor-contract'
import {
  type HostMessage,
  type IframeMessage,
  isIframeMessage,
  PROTOCOL_VERSION,
} from './postmessage-protocol'

export class DocEditor {
  /** Resolved editor-service origin (derived from the SDK <script> src). */
  readonly editorOrigin: string

  private readonly config: EditorConfigRoot
  private readonly placeholderId: string
  private readonly iframe: HTMLIFrameElement
  private readonly messageListener: (e: MessageEvent) => void
  private iframeReady = false
  private destroyed = false
  private methodCounter = 0
  private readonly pendingMethods = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >()

  constructor(placeholderId: string, config: EditorConfigRoot) {
    this.placeholderId = placeholderId
    this.config = config

    // Required-parameter validation.
    const errors = validateConfig(config)
    if (errors.length > 0) {
      const msg = `PrismOffice DocEditor: invalid config — ${errors.join('; ')}`
      if (typeof window !== 'undefined' && typeof window.alert === 'function') {
        window.alert(msg)
      }
      throw new Error(msg)
    }

    this.editorOrigin = resolveEditorOrigin()

    const placeholder = document.getElementById(placeholderId)
    if (!placeholder) {
      throw new Error(`PrismOffice DocEditor: placeholder "#${placeholderId}" not found`)
    }

    this.iframe = createIframe(this.editorOrigin, config)
    placeholder.parentNode?.replaceChild(this.iframe, placeholder)

    this.messageListener = (e: MessageEvent) => this.onMessage(e)
    window.addEventListener('message', this.messageListener)
  }

  // -----------------------------------------------------------------------
  // Public methods (paired with the request-events).
  // -----------------------------------------------------------------------

  /** Tear down: remove iframe, remove listener, reject pending calls. */
  destroyEditor(): void {
    if (this.destroyed) return
    this.destroyed = true
    window.removeEventListener('message', this.messageListener)
    this.postMessage({ type: 'destroy' })
    this.iframe.parentNode?.removeChild(this.iframe)
    for (const { reject } of this.pendingMethods.values()) {
      reject(new Error('editor destroyed'))
    }
    this.pendingMethods.clear()
  }

  /** Trigger a download of the current doc via `onDownloadAs`. */
  downloadAs(): Promise<unknown> {
    return this.callMethod('downloadAs', [])
  }

  /** Respond to `onRequestInsertImage` with the chosen image. */
  insertImage(payload: InsertImagePayload): Promise<unknown> {
    return this.callMethod('insertImage', [payload])
  }

  /** Respond to `onRequestHistory` with the version list. */
  refreshHistory(history: {
    currentVersion: number
    history: HistoryEntry[]
  }): Promise<unknown> {
    return this.callMethod('refreshHistory', [history])
  }

  /** Respond to `onRequestHistoryData` with the version's bytes URL. */
  setHistoryData(data: HistoryData): Promise<unknown> {
    return this.callMethod('setHistoryData', [data])
  }

  /** Respond to `onMakeActionLink` (v1.1). */
  setActionLink(_url: string): void {
    /* v1.1 */
  }

  /** (v2 collab) set users for @-mentions. Harmless in v1. */
  setUsers(_users: EditorUser[]): void {
    /* v2 */
  }

  /** Respond to `onRequestRefreshFile` / `onOutdatedVersion`. */
  refreshFile(file: { url: string; key: string }): Promise<unknown> {
    return this.callMethod('refreshFile', [file])
  }

  /** Programmatically request the host re-init in edit mode. */
  requestEditRights(): void {
    this.config.events?.onRequestEditRights?.call(this)
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  private async onMessage(e: MessageEvent): Promise<void> {
    if (this.destroyed) return
    if (e.source !== this.iframe.contentWindow) return
    if (e.origin !== this.editorOrigin) return
    const msg = e.data
    if (!isIframeMessage(msg)) return

    if (msg.type === 'app-ready') {
      // iframe finished loading its bundle. Send the sanitized config
      // (functions stripped — structured clone can't carry them; the iframe
      // dispatches events back by name).
      this.iframeReady = true
      this.postMessage({
        type: 'init',
        protocol: PROTOCOL_VERSION,
        config: sanitizeConfigForClone(this.config),
      })
      // The iframe's `app-ready` handshake doubles as the onAppReady event
      // surface.
      const onAppReady = this.config.events?.onAppReady as
        | (() => void)
        | undefined
      if (typeof onAppReady === 'function') onAppReady.call(this)
      return
    }

    if (msg.type === 'event') {
      // Indexing EditorEvents by keyof returns a union of distinct function
      // signatures that TS can't unify into one callable shape. Treat the
      // resolved handler as a generic (event) => void — call convention:
      // handler.call(editor, {target, data}).
      const handler = this.config.events?.[msg.name] as
        | ((event: { target: DocEditor; data: unknown }) => void)
        | undefined
      if (typeof handler === 'function') {
        handler.call(this, { target: this, data: msg.data })
      }
      return
    }

    if (msg.type === 'method-response') {
      const pending = this.pendingMethods.get(msg.id)
      if (!pending) return
      this.pendingMethods.delete(msg.id)
      if (msg.error) pending.reject(new Error(msg.error))
      else pending.resolve(msg.result)
    }
  }

  private callMethod(method: string, args: unknown[]): Promise<unknown> {
    if (this.destroyed) return Promise.reject(new Error('editor destroyed'))
    const id = `m${++this.methodCounter}`
    return new Promise((resolve, reject) => {
      this.pendingMethods.set(id, { resolve, reject })
      this.postMessage({ type: 'method', id, method, args })
    })
  }

  private postMessage(msg: HostMessage): void {
    this.iframe.contentWindow?.postMessage(msg, this.editorOrigin)
  }
}

function validateConfig(c: EditorConfigRoot): string[] {
  const errors: string[] = []
  if (!c.document?.url) errors.push('document.url is required')
  if (!c.document?.key || typeof c.document.key !== 'string') {
    errors.push('document.key is required (string)')
  }
  if (c.document?.key && !/^[0-9a-zA-Z\-_.=]{1,128}$/.test(c.document.key)) {
    errors.push('document.key must be 1-128 chars of [0-9a-zA-Z-_.=]')
  }
  if (!c.document?.fileType && !c.documentType) {
    errors.push('either document.fileType or documentType is required')
  }
  if (c.editorConfig?.mode === 'edit' && !c.editorConfig?.callbackUrl) {
    errors.push('editorConfig.callbackUrl is required for edit mode')
  }
  return errors
}

/**
 * Strip function-valued fields before postMessage-ing the config to the
 * iframe — structured clone throws on functions, and the iframe dispatches
 * events back by name (it doesn't need the host's callback references).
 */
function sanitizeConfigForClone(config: EditorConfigRoot): EditorConfigRoot {
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

// ---------------------------------------------------------------------------
// iframe creation
// ---------------------------------------------------------------------------

function createIframe(editorOrigin: string, config: EditorConfigRoot): HTMLIFrameElement {  const iframe = document.createElement('iframe')
  // The iframe URL is bare; the actual config travels by postMessage after
  // app-ready (NOT in the URL — that would leak signed tokens into referer
  // headers and browser history). documentType picks docs vs pdf editor.
  const docType = config.documentType
  iframe.src = `${editorOrigin}/editor/${docType}/`
  iframe.setAttribute('allow', 'clipboard-read; clipboard-write; fullscreen')
  iframe.setAttribute('frameborder', '0')
  iframe.style.border = '0'
  iframe.style.width = config.width ?? '100%'
  iframe.style.height = config.height ?? '100%'
  return iframe
}

// ---------------------------------------------------------------------------
// Editor origin resolution
// ---------------------------------------------------------------------------

/**
 * Derive the editor service origin from the SDK's own `<script>` src.
 *
 *   <script src="https://EDITOR_SERVICE_URL/sdk/prismoffice.js"></script>
 *
 * → editor origin is `https://EDITOR_SERVICE_URL`.
 *
 * Falls back to `window.location.origin` if the SDK was bundled (no separate
 * script tag) — useful for development when the SDK is imported as a module.
 */
function resolveEditorOrigin(): string {
  if (typeof document === 'undefined') {
    throw new Error('PrismOffice DocEditor must be constructed in a browser context')
  }
  // Prefer the explicit data-editor-origin attribute on the SDK script.
  const scripts = document.querySelectorAll<HTMLScriptElement>(
    'script[src*="/sdk/prismoffice"], script[data-prismoffice-sdk]',
  )
  for (let i = scripts.length - 1; i >= 0; i--) {
    const s = scripts[i]
    const explicit = s.getAttribute('data-editor-origin')
    if (explicit) return explicit.replace(/\/$/, '')
    const src = s.getAttribute('src')
    if (src) {
      try {
        const u = new URL(src, document.baseURI)
        return u.origin
      } catch {
        /* try next */
      }
    }
  }
  // Bundler / module-import fallback: same origin.
  return window.location.origin
}

// ---------------------------------------------------------------------------
// Global registration
// ---------------------------------------------------------------------------

declare global {
  interface Window {
    PrismOfficeAPI?: { DocEditor: typeof DocEditor }
  }
}

if (typeof window !== 'undefined') {
  window.PrismOfficeAPI = { DocEditor }
}

export { signJwt, verifyJwt } from './jwt'
export { signConfig, verifyConfigToken } from './jwt-sign-browser'
export type { HostMessage, IframeMessage } from './postmessage-protocol'
export type {
  EditorConfigRoot,
  DocumentConfig,
  EditorConfig,
  EditorEvents,
  Permissions,
  EditorUser,
  HistoryData,
  HistoryEntry,
  InsertImagePayload,
  CallbackStatus,
  CallbackRequest,
  CallbackResponse,
} from '@prismoffice/editor-contract'
