/**
 * Main-thread client for the PDF edit Worker.
 *
 * Wraps the browser Web Worker (worker.ts) with a typed Promise-based API.
 * The PdfApi web implementation (packages/web-runtime/src/pdf-api.ts) uses
 * this to route text-edit/save operations to pdfium running in the Worker.
 *
 * Bytes travel as Transferable ArrayBuffers — zero-copy.
 */

import type {
  TextEditInput,
  TextEditValidation,
  SavePdfRequest,
  TextEditFailure,
  ImageEditFailure,
} from '../shared/ipc'

interface WorkerResponse {
  id: number
  ok: boolean
  result?: unknown
  error?: string
}

interface ApplyTextEditsResult {
  bytes: ArrayBuffer
  skipped: TextEditFailure[]
}

interface SaveDocumentResult {
  bytes: ArrayBuffer
  skippedTextEdits?: TextEditFailure[]
  skippedImageEdits?: ImageEditFailure[]
}

export class PdfWorkerClient {
  private readonly worker: Worker
  private nextId = 1
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >()

  constructor() {
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
    this.worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const msg = e.data
      if (msg.id === 0) return
      const pending = this.pending.get(msg.id)
      if (!pending) return
      this.pending.delete(msg.id)
      if (msg.ok) pending.resolve(msg.result)
      else pending.reject(new Error(msg.error ?? 'unknown worker error'))
    }
    this.worker.onerror = (e) => {
      for (const { reject } of this.pending.values()) {
        reject(new Error(`worker error: ${e.message}`))
      }
      this.pending.clear()
    }
  }

  async applyTextEdits(bytes: Uint8Array, edits: TextEditInput[]): Promise<ApplyTextEditsResult> {
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    const result = await this.request<ApplyTextEditsResult>('applyTextEdits', buf, [buf], { edits })
    return result
  }

  async validateTextEdits(bytes: Uint8Array, edits: TextEditInput[]): Promise<TextEditValidation[]> {
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    return this.request<TextEditValidation[]>('validateTextEdits', buf, [buf], { edits })
  }

  async saveDocument(bytes: Uint8Array, request: SavePdfRequest): Promise<SaveDocumentResult> {
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    const result = await this.request<SaveDocumentResult>('saveDocument', buf, [buf], { request })
    return result
  }

  terminate(): void {
    this.worker.terminate()
    for (const { reject } of this.pending.values()) {
      reject(new Error('worker terminated'))
    }
    this.pending.clear()
  }

  private request<T>(
    op: string,
    bytes: ArrayBuffer,
    transfer: Transferable[],
    extra: Record<string, unknown>,
  ): Promise<T> {
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      this.worker.postMessage({ id, op, bytes, ...extra }, transfer)
    })
  }
}
