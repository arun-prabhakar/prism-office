/**
 * Browser-side implementation of the sheets renderer's `DesktopApi` contract.
 *
 * Shape mirrors apps/sheets/src/shared/desktop-api `DesktopApi` 1:1 — the
 * renderer code is unchanged between desktop and web; only this bridge and
 * the entry HTML differ.
 *
 * PHASE 1 STATUS (no xlsx engine in-browser yet): the Rust sidecar does not
 * run, so every method that needs to parse/stream/recalc/save an xlsx throws
 * a clear "not supported on the web port (yet)" error. The boot-critical
 * methods (language, theme, "no queued workbook") are real so the renderer
 * mounts its chrome and Univer canvas. Opening a document will follow once
 * the in-browser xlsx path (small workbooks) or the wasm sidecar (large/
 * streamed workbooks) lands — see the sheets web-port plan.
 */

import type { DesktopApi, UiTheme } from '@prismoffice/sheets/shared/desktop-api'
import type { EditorConfigRoot } from '@prismoffice/editor-contract'

type Lang = 'zh' | 'en' | 'ja' | 'ko' | 'fr' | 'de' | 'es' | 'th' | 'id' | 'ru' | 'ar'

interface SheetsWebRuntimeOpts {
  config: EditorConfigRoot
}

const unsupported = (name: string): never => {
  throw new Error(`sheets-api.${name}: not supported on the web port (yet)`)
}

export function createSheetsApi(opts: SheetsWebRuntimeOpts): DesktopApi {
  const { config } = opts

  const lang = (config.editorConfig?.lang as Lang | undefined) ?? 'en'
  const theme = ((config.editorConfig as { customization?: { uiTheme?: UiTheme } })
    ?.customization?.uiTheme ?? 'light') as UiTheme

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
      return false
    },

    // --- xlsx engine surface: stubbed until the in-browser/wasm backend lands ---
    async selectWorkbook() {
      return unsupported('selectWorkbook')
    },
    async readWorkbookRange() {
      return unsupported('readWorkbookRange')
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

    // --- AI panel: stubbed (mirror of docs-api.ts to follow) ---
    async getAiSettings() {
      return unsupported('getAiSettings')
    },
    async setAiSettings() {
      return unsupported('setAiSettings')
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
    async aiGskStatus() {
      return unsupported('aiGskStatus')
    },
    async aiGskLogin() {
      return unsupported('aiGskLogin')
    },
    async webSearch() {
      return unsupported('webSearch')
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
