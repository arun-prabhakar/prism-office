/**
 * Browser-side implementation of the sheets renderer's `DesktopApi` contract.
 *
 * Shape mirrors apps/sheets/src/shared/desktop-api `DesktopApi` 1:1 — the
 * renderer code is unchanged between desktop and web; only this bridge and
 * the entry HTML differ.
 *
 * PHASE 1 STATUS: the in-browser xlsx engine (sheets-xlsx.ts, SheetJS) is
 * wired for OPEN + VIEW — `selectWorkbook` fetches the document and parses it,
 * `readWorkbookRange` serves cell values/formulas/merges for a range. The
 * Rust sidecar does not run, so recalculation, save, media/pivot/chart reads,
 * and style/conditional-formatting mapping still throw "not supported on the
 * web port (yet)" — cells render their last cached file values. Large/streamed
 * workbooks will eventually route through the wasm sidecar; this path targets
 * small workbooks opened fully in-browser.
 */

import type { DesktopApi, UiTheme } from '@prismoffice/sheets/shared/desktop-api'
import type { AiSettings, GenSparkAccountStatus } from '@prismoffice/ai-provider'
import type { EditorConfigRoot } from '@prismoffice/editor-contract'
import { openWorkbook, readRange, sanitizeConfigForFetch } from './sheets-xlsx'

type Lang = 'zh' | 'en' | 'ja' | 'ko' | 'fr' | 'de' | 'es' | 'th' | 'id' | 'ru' | 'ar'

interface SheetsWebRuntimeOpts {
  config: EditorConfigRoot
  /** Optional sink for SDK events the web client should fire at the host
   *  (onDocumentReady / onDocumentStateChange). Defaults to postMessage to
   *  window.parent. */
  postSdkEvent?: (name: string, data?: unknown) => void
}

const unsupported = (name: string): never => {
  throw new Error(`sheets-api.${name}: not supported on the web port (yet)`)
}

export function createSheetsApi(opts: SheetsWebRuntimeOpts): DesktopApi {
  const { config } = opts
  const postSdkEvent =
    opts.postSdkEvent ??
    ((name: string, data?: unknown) => {
      window.parent?.postMessage({ type: 'event', name, data }, '*')
    })

  const lang = (config.editorConfig?.lang as Lang | undefined) ?? 'en'
  const theme = ((config.editorConfig as { customization?: { uiTheme?: UiTheme } })
    ?.customization?.uiTheme ?? 'light') as UiTheme
  const aiSettings: AiSettings = {
    provider: (config.editorConfig?.customization?.ai?.model as AiSettings['provider']) ?? 'claude',
  } as AiSettings

  const noop = () => {}

  return {
    // --- boot-critical: language / theme / queued-open (real) ---
    async getLanguage() {
      return lang
    },
    onLanguageChanged() {
      return noop
    },
    async getTheme() {
      return theme
    },
    onThemeChanged() {
      return noop
    },
    onChromePressed() {
      return noop
    },
    async consumeNewBlankWorkbook() {
      return false
    },
    async hasQueuedWorkbook() {
      // The web analog of the shell-queued open: the signed config's
      // document.url is the workbook to pull at boot (App calls
      // selectWorkbook() when this resolves true).
      return !!config.document?.url
    },

    // --- xlsx engine: OPEN + VIEW wired (Phase 1); recalc/save/etc. still stubbed ---
    async selectWorkbook() {
      const url = config.document?.url
      if (!url) return null
      try {
        const res = await fetch('/fetch-document', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ config: sanitizeConfigForFetch(config) }),
        })
        if (!res.ok) {
          postSdkEvent('onError', {
            errorCode: res.status,
            errorDescription: `fetch-document ${res.status}`,
          })
          return null
        }
        const bytes = await res.arrayBuffer()
        const workbook = await openWorkbook(bytes, config.document?.title ?? 'workbook.xlsx')
        postSdkEvent('onDocumentReady')
        postSdkEvent('onDocumentStateChange', false)
        return workbook
      } catch (e) {
        postSdkEvent('onError', {
          errorCode: -1,
          errorDescription: (e as Error).message,
        })
        return null
      }
    },
    async readWorkbookRange(request) {
      return readRange(request)
    },
    async readWorkbookFormulas() {
      return unsupported('readWorkbookFormulas')
    },
    async recalcWorkbook() {
      return unsupported('recalcWorkbook')
    },
    async readWorkbookMedia() {
      return unsupported('readWorkbookMedia')
    },
    async readPivotDefinition() {
      return unsupported('readPivotDefinition')
    },
    async readLocalImage() {
      return unsupported('readLocalImage')
    },
    async captureScreenSources() {
      return unsupported('captureScreenSources')
    },
    async captureScreenSource() {
      return unsupported('captureScreenSource')
    },
    async saveWorkbookEdits() {
      return unsupported('saveWorkbookEdits')
    },
    async writeWorkbookRecovery() {
      return unsupported('writeWorkbookRecovery')
    },
    async autoRenameWorkbook() {
      return unsupported('autoRenameWorkbook')
    },
    async exportPdf() {
      return unsupported('exportPdf')
    },
    async closeWorkbook() {
      // No engine session to tear down in Phase 1; resolve cleanly.
    },

    // --- AI panel: boot-safe defaults (mirror of docs-api.ts). The sheets
    // renderer reads settings/account status during boot, so these must
    // resolve rather than throw; interactive AI calls still fail loudly. ---
    async getAiSettings(): Promise<AiSettings> {
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
    async setAiSettings() {
      /* settings are operator-configured via PRISMOFFICE_GSK_KEY */
    },
    async aiChat() {
      return unsupported('aiChat')
    },
    async aiStream() {
      return unsupported('aiStream')
    },
    async aiStreamCancel() {
      return unsupported('aiStreamCancel')
    },
    async aiGskStatus(): Promise<GenSparkAccountStatus> {
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
    async webSearch() {
      return unsupported('webSearch')
    },
    async imageSearch(query, maxResults) {
      const res = await fetch('/ai/image-search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, maxResults }),
      })
      return await res.json()
    },
    async generateImage() {
      return unsupported('generateImage')
    },
    async fetchImage(url) {
      const res = await fetch('/ai/fetch-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      })
      if (!res.ok) return null
      return await res.json()
    },
    onAiStream() {
      return noop
    },

    // --- chat attachments: stubbed (FSAccess + IndexedDB impl to follow) ---
    async pickAttachments() {
      return unsupported('pickAttachments')
    },
    async addAttachmentPaths() {
      return unsupported('addAttachmentPaths')
    },
    async addPastedImage() {
      return unsupported('addPastedImage')
    },
    async readAttachment() {
      return unsupported('readAttachment')
    },
    async readAttachmentImage() {
      return unsupported('readAttachmentImage')
    },
    getPathForFile() {
      // No absolute path on web (mirrors docs-api.ts); renderer's drop path is
      // a no-op against ''.
      return ''
    },

    // --- shell chrome: no host-side equivalents in the iframe SPA ---
    async openExternal(url) {
      window.open(url, '_blank', 'noopener')
    },
    onMenuAction() {
      return noop
    },
    onWorkbookRenamed() {
      return noop
    },
    notifyPendingEdits() {
      /* no-op */
    },
    onCloseSaveRequest() {
      return noop
    },
    reportCloseSaveResult() {
      /* no-op */
    },
  }
}
