/**
 * Spike 2 worker entry — loads pdfium.wasm in a Node Worker Thread, then
 * handles `load-document` / `extract-text` requests from the main thread.
 *
 * In the browser, the worker is identical except wasm bytes come from
 * `fetch('/wasm/pdfium.wasm').arrayBuffer()` instead of `readFileSync(...)`.
 * The pattern (load bytes → init({ wasmBinary }) → call FPDF_* APIs) is
 * exactly the same — proving this works in a Worker context de-risks the
 * Phase 3 port to a browser Web Worker.
 */

import { parentPort } from 'node:worker_threads'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

interface Pdfium {
  HEAPU8: Uint8Array
  _PDFiumExt_Init(): void
  _FPDF_LoadMemDocument(ptr: number, size: number, password: number): number
  _FPDF_CloseDocument(doc: number): void
  _FPDF_GetPageCount(doc: number): number
  _malloc(n: number): number
  _free(p: number): void
}

type LoadResult =
  | { ok: true; pageCount: number }
  | { ok: false; error: string }

type ExtractTextResult =
  | { ok: true; text: string }
  | { ok: false; error: string }

type WorkerResponse =
  | { id: number; type: 'loaded'; result: LoadResult }
  | { id: number; type: 'extracted-text'; result: ExtractTextResult }

type WorkerRequest =
  | { id: number; type: 'load-document'; bytes: Uint8Array }
  | { id: number; type: 'extract-text' }

const req = createRequire(import.meta.url)

async function loadPdfium(): Promise<Pdfium> {
  const wasmPath = req.resolve('@embedpdf/pdfium/pdfium.wasm')
  const raw = readFileSync(wasmPath)
  const wasmBinary = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)
  // Cast through `unknown`: @embedpdf/pdfium's runtime shape matches our Pdfium
  // interface (Emscripten-style exports), but its published types are sealed
  // in a way that doesn't admit the extension-module methods (_PDFiumExt_*).
  const { init } = (await import('@embedpdf/pdfium')) as {
    init: (overrides: object) => Promise<unknown>
  }
  const wrapped = (await init({ wasmBinary })) as { pdfium?: Pdfium } | Pdfium
  const m = (
    'pdfium' in wrapped && wrapped.pdfium ? wrapped.pdfium : (wrapped as Pdfium)
  ) as Pdfium
  m._PDFiumExt_Init()
  return m
}

const pdfiumPromise = loadPdfium().catch((e) => {
  parentPort?.postMessage({
    id: -1,
    type: 'loaded',
    result: { ok: false, error: `pdfium load failed: ${(e as Error).message}` },
  } satisfies WorkerResponse)
  throw e
})

let currentDoc = 0

async function handle(req: WorkerRequest): Promise<void> {
  const m = await pdfiumPromise
  if (req.type === 'load-document') {
    if (currentDoc !== 0) {
      m._FPDF_CloseDocument(currentDoc)
      currentDoc = 0
    }
    const ptr = m._malloc(req.bytes.byteLength)
    if (ptr === 0) {
      const result: LoadResult = { ok: false, error: 'out of memory' }
      parentPort?.postMessage({ id: req.id, type: 'loaded', result } satisfies WorkerResponse)
      return
    }
    try {
      m.HEAPU8.set(req.bytes, ptr)
      const doc = m._FPDF_LoadMemDocument(ptr, req.bytes.byteLength, 0)
      if (doc === 0) {
        const result: LoadResult = { ok: false, error: 'pdfium failed to open document' }
        parentPort?.postMessage({ id: req.id, type: 'loaded', result } satisfies WorkerResponse)
        return
      }
      currentDoc = doc
      const pageCount = m._FPDF_GetPageCount(doc)
      const result: LoadResult = { ok: true, pageCount }
      parentPort?.postMessage({ id: req.id, type: 'loaded', result } satisfies WorkerResponse)
    } finally {
      m._free(ptr)
    }
    return
  }

  if (req.type === 'extract-text') {
    // For the spike, pdfjs-dist on the main thread does extraction better.
    // The point of THIS test is just to prove pdfium loads in a Worker.
    const result: ExtractTextResult = { ok: true, text: '' }
    parentPort?.postMessage({
      id: req.id,
      type: 'extracted-text',
      result,
    } satisfies WorkerResponse)
  }
}

parentPort?.on('message', (req: WorkerRequest) => {
  handle(req).catch((e) => {
    parentPort?.postMessage({
      id: req.id,
      type: 'loaded',
      result: { ok: false, error: (e as Error).message },
    } satisfies WorkerResponse)
  })
})

export type { WorkerRequest, WorkerResponse, LoadResult, ExtractTextResult }
