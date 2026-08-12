/**
 * Browser-side implementation of the pdf renderer's `PdfApi` contract.
 *
 * Phase 3 MVP: viewer-only. All text/image edit ops return empty/null stubs
 * (Phase 3.1 will port pdfium into a Web Worker for real editing). Viewer
 * ops (readFile, save without edits, language/theme) are functional.
 *
 * Shape mirrors apps/pdf/src/shared/ipc `PdfApi` 1:1 — the renderer code
 * does not change between desktop and web.
 */

import type { Lang } from '@genoffice/i18n'
import type {
  AiSettings,
  AiStreamChunk,
  AiStreamRequest,
} from '@genoffice/ai-provider'
import type {
  ExtractPagesRequest,
  ExtractPagesResult,
  ImageEditFailure,
  ImageSearchResponse,
  InsertPdfRequest,
  InsertPdfResult,
  ExportImagesRequest,
  ExportImagesResult,
  PageImageRef,
  PagePreviewRequest,
  PdfApi,
  SavePdfRequest,
  SavePdfResult,
  TextEditFailure,
  TextEditInput,
  TextEditValidation,
  UiTheme,
  ValidateTextEditsRequest,
} from '@genoffice/pdf/shared/ipc'
import type { EditorConfigRoot } from '@genoffice/editor-contract'

interface PdfWebRuntimeOpts {
  config: EditorConfigRoot
  postSdkEvent?: (name: string, data?: unknown) => void
  pdfWorker?: {
    applyTextEdits(bytes: Uint8Array, edits: TextEditInput[]): Promise<{ bytes: ArrayBuffer; skipped: TextEditFailure[] }>
    validateTextEdits(bytes: Uint8Array, edits: TextEditInput[]): Promise<TextEditValidation[]>
    saveDocument(bytes: Uint8Array, request: SavePdfRequest): Promise<{ bytes: ArrayBuffer; skippedTextEdits?: TextEditFailure[]; skippedImageEdits?: ImageEditFailure[] }>
  }
}

export function createPdfApi(opts: PdfWebRuntimeOpts): PdfApi {
  const { config, pdfWorker } = opts
  const postSdkEvent =
    opts.postSdkEvent ??
    ((name: string, data?: unknown) => {
      window.parent?.postMessage({ type: 'event', name, data }, '*')
    })

  const lang = (config.editorConfig?.lang as Lang | undefined) ?? 'en'
  let pendingConsumed = false
  let docBytes: ArrayBuffer | null = null

  async function fetchDocBytes(): Promise<ArrayBuffer> {
    if (docBytes) return docBytes
    const res = await fetch('/fetch-document', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config }),
    })
    if (!res.ok) {
      const errBody = await res.json().catch(() => null)
      throw new Error(errBody?.error || `fetch-document ${res.status}`)
    }
    docBytes = await res.arrayBuffer()
    return docBytes
  }

  function bytesToBase64(bytes: Uint8Array): string {
    let bin = ''
    const chunk = 0x8000
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode(...bytes.subarray(i, i + chunk))
    }
    return btoa(bin)
  }

  return {
    async consumePending(): Promise<string | null> {
      if (pendingConsumed) return null
      pendingConsumed = true
      postSdkEvent('onDocumentReady')
      return config.document.title ?? config.document.key
    },

    async readFile(_path: string): Promise<ArrayBuffer> {
      return fetchDocBytes()
    },

    async save(request: SavePdfRequest): Promise<SavePdfResult> {
      postSdkEvent('onDocumentStateChange', true)
      try {
        const originalBytes = await fetchDocBytes()
        let bytesToSave = new Uint8Array(originalBytes)
        let skippedTextEdits: TextEditFailure[] | undefined
        let skippedImageEdits: ImageEditFailure[] | undefined

        if (pdfWorker) {
          const result = await pdfWorker.saveDocument(new Uint8Array(originalBytes), request)
          bytesToSave = new Uint8Array(result.bytes)
          skippedTextEdits = result.skippedTextEdits
          skippedImageEdits = result.skippedImageEdits
        }

        const res = await fetch('/save-document', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            config,
            bytes: bytesToBase64(bytesToSave),
            filetype: 'pdf',
          }),
        })
        if (!res.ok) {
          const body = await res.json().catch(() => ({ error: 'unknown' }))
          return { ok: false, error: body.error ?? `save-document ${res.status}` }
        }
        postSdkEvent('onDocumentStateChange', false)
        return { ok: true, skippedTextEdits, skippedImageEdits }
      } catch (e) {
        return { ok: false, error: (e as Error).message }
      }
    },

    // -------------------------------------------------------------------------
    // Text/image edit ops — stubs (Phase 3.1 will port pdfium to a Worker)
    // -------------------------------------------------------------------------
    async validateTextEdits(request: ValidateTextEditsRequest): Promise<TextEditValidation[]> {
      if (!pdfWorker) return []
      try {
        const bytes = await fetchDocBytes()
        return await pdfWorker.validateTextEdits(new Uint8Array(bytes), request.edits)
      } catch {
        return []
      }
    },
    async listEditFonts(): Promise<string[]> {
      return []
    },
    async listPageImages(_path: string): Promise<PageImageRef[]> {
      return []
    },
    async pageImagePng(_request: {
      path: string
      pageIndex: number
      rect: [number, number, number, number]
    }): Promise<string | null> {
      return null
    },
    async pagePreviewPng(_request: PagePreviewRequest): Promise<string | null> {
      return null
    },

    // -------------------------------------------------------------------------
    // Page operations — stubs (Phase 3.1)
    // -------------------------------------------------------------------------
    async extractPages(_request: ExtractPagesRequest): Promise<ExtractPagesResult> {
      return { ok: true, canceled: true }
    },
    async insertPdf(_request: InsertPdfRequest): Promise<InsertPdfResult> {
      return { ok: true, canceled: true }
    },
    async exportImages(_request: ExportImagesRequest): Promise<ExportImagesResult> {
      return { ok: true, canceled: true }
    },

    // -------------------------------------------------------------------------
    // AI / network — stubs (Phase 4)
    // -------------------------------------------------------------------------
    async imageSearch(query: string, maxResults?: number): Promise<ImageSearchResponse> {
      const res = await fetch('/ai/image-search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, maxResults }),
      })
      return await res.json()
    },
    async fetchImage(url: string): Promise<{ base64: string; mime: string } | null> {
      const res = await fetch('/ai/fetch-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      })
      if (!res.ok) return null
      return await res.json()
    },
    async generateImage(op: { prompt: string; aspectRatio?: string }): Promise<{
      url?: string
      error?: string
    }> {
      if (!op?.prompt) return { error: 'no prompt' }
      return { error: 'Image generation not yet wired to Genspark API' }
    },

    // -------------------------------------------------------------------------
    // Dirty / close / saveAs — SPA owns its own chrome
    // -------------------------------------------------------------------------
    setDirty(_dirty: boolean): void {
      /* no-op */
    },
    onCloseSaveRequest(_handler: () => void): () => void {
      return () => {}
    },
    sendCloseSaveResult(_ok: boolean): void {
      /* no-op */
    },
    onSaveAsRequest(_handler: (targetPath: string) => void): () => void {
      return () => {}
    },
    sendSaveAsResult(_ok: boolean): void {
      /* no-op */
    },
    onSaveAsFlow(_handler: (inFlight: boolean) => void): () => void {
      return () => {}
    },

    // -------------------------------------------------------------------------
    // Theme / language — from config
    // -------------------------------------------------------------------------
    async getLanguage(): Promise<Lang> {
      return lang
    },
    onLanguageChanged(): () => void {
      return () => {}
    },
    async getTheme(): Promise<UiTheme> {
      return 'system'
    },
    onThemeChanged(): () => void {
      return () => {}
    },

    // -------------------------------------------------------------------------
    // AI settings / streaming — stubs (Phase 4)
    // -------------------------------------------------------------------------
    async getAiSettings(): Promise<AiSettings> {
      try {
        const res = await fetch('/ai/settings')
        if (res.ok) {
          const body = (await res.json()) as { configured: boolean; provider: string | null }
          if (body.provider) return { provider: body.provider } as unknown as AiSettings
        }
      } catch {
        /* fall through to default */
      }
      return { provider: 'claude' } as unknown as AiSettings
    },
    async aiStream(request: AiStreamRequest): Promise<void> {
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
    async aiStreamCancel(requestId: string): Promise<void> {
      await fetch('/ai/stream-cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId }),
      })
    },
    onAiStream(_handler: (chunk: AiStreamChunk) => void): () => void {
      return () => {}
    },
  }
}
