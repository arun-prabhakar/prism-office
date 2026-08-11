/**
 * Browser Web Worker for real PDF text editing (Phase 3.1).
 *
 * Loads pdfium.wasm + hb-subset.wasm via fetch, then routes edit operations
 * to the UNCHANGED desktop code (apps/pdf/src/main/text-edit.ts etc.) through
 * Vite resolve.alias shims that replace node:fs readFileSync with prefetched
 * bytes.
 *
 * The Worker is created by apps/pdf/src/renderer/main-web.tsx and wrapped by
 * apps/pdf/src/renderer-worker/client.ts.
 */

import { Buffer } from 'buffer'
import { setPrefetched } from './shims/fs'

// text-edit.ts calls Buffer.from(...) for UTF-16 encoding; the `buffer` npm
// package provides a browser-compatible Buffer.
;(globalThis as Record<string, unknown>).Buffer = Buffer

// Prefetch wasm bytes before importing the edit modules (which call
// readFileSync at operation time, not module-load time).
const PDFIUM_URL = new URL('../../../../node_modules/@embedpdf/pdfium/pdfium.wasm', import.meta.url).href

async function prefetch(): Promise<void> {
  const [pdfiumRes] = await Promise.all([fetch(PDFIUM_URL)])
  if (!pdfiumRes.ok) throw new Error(`failed to fetch pdfium.wasm: ${pdfiumRes.status}`)
  const pdfiumBytes = new Uint8Array(await pdfiumRes.arrayBuffer())
  setPrefetched('pdfium.wasm', pdfiumBytes)

  // hb-subset.wasm — try harfbuzzjs ≤0.10 path first, then ≥1.x
  try {
    const hbRes = await fetch(
      new URL('../../../../node_modules/harfbuzzjs/hb-subset.wasm', import.meta.url).href,
    )
    if (hbRes.ok) {
      setPrefetched('hb-subset.wasm', new Uint8Array(await hbRes.arrayBuffer()))
    }
  } catch {
    /* font subsetting degrades gracefully without hb-subset */
  }
}

// Type-only imports — the actual modules are imported after prefetch.
import type { TextEditInput, TextEditValidation, SavePdfRequest, TextEditFailure } from '../shared/ipc'

interface WorkerRequest {
  id: number
  op: 'applyTextEdits' | 'validateTextEdits' | 'saveDocument'
  bytes?: ArrayBuffer
  edits?: TextEditInput[]
  request?: SavePdfRequest
}

interface WorkerResponse {
  id: number
  ok: boolean
  result?: unknown
  error?: string
}

let ready = false
const pendingResolvers = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

async function ensureReady(): Promise<void> {
  if (ready) return
  await prefetch()
  ready = true
}

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const req = e.data
  if (!req?.id || !req?.op) return

  try {
    await ensureReady()

    // Dynamic imports so the edit modules load AFTER the fs shim is populated.
    const textEdit = await import('../main/text-edit')

    if (req.op === 'applyTextEdits') {
      const bytes = new Uint8Array(req.bytes!)
      const result = await textEdit.applyTextEdits(bytes, req.edits ?? [])
      const transfer = result.bytes.buffer
      ;(self as unknown as Worker).postMessage(
        { id: req.id, ok: true, result: { skipped: result.skipped, bytes: transfer } },
        [transfer],
      )
      return
    }

    if (req.op === 'validateTextEdits') {
      const bytes = new Uint8Array(req.bytes!)
      const result = await textEdit.validateTextEdits(bytes, req.edits ?? [])
      ;(self as unknown as Worker).postMessage({ id: req.id, ok: true, result })
      return
    }

    if (req.op === 'saveDocument') {
      const bytes = new Uint8Array(req.bytes!)
      const saveMod = await import('../main/save-pdf')
      const result = await saveMod.applySaveRequest(bytes, req.request!)
      const transfer = result.bytes.buffer
      ;(self as unknown as Worker).postMessage(
        {
          id: req.id,
          ok: true,
          result: {
            skippedTextEdits: result.skippedTextEdits,
            skippedImageEdits: result.skippedImageEdits,
            bytes: transfer,
          },
        },
        [transfer],
      )
      return
    }
  } catch (err) {
    const response: WorkerResponse = {
      id: req.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }
    ;(self as unknown as Worker).postMessage(response)
  }
}

// Signal ready state (the prefetch + module load happens on the first request).
;(self as unknown as Worker).postMessage({ id: 0, ok: true, result: 'worker-booted' })
