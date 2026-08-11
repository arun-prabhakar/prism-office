/**
 * Spike 2 main-thread client. Spawns the pdfium Worker, exposes a typed API
 * to the rest of the editor service. Same shape as a browser
 * `new Worker(new URL('./worker.ts', import.meta.url))` — proving the
 * isolation pattern works for either runtime.
 */

import { Worker } from 'node:worker_threads'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  ExtractTextResult,
  LoadResult,
  WorkerRequest,
  WorkerResponse,
} from './worker'

const here = dirname(fileURLToPath(import.meta.url))

/** Distributive Omit — without this, Omit<Union, K> collapses to a single
 *    shape and the discriminated union is lost. */
type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never
type WorkerRequestWithoutId = DistributiveOmit<WorkerRequest, 'id'>

export class PdfWorkerClient {
  private readonly worker: Worker
  private nextId = 1
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; type: WorkerResponse['type'] }
  >()

  constructor() {
    this.worker = new Worker(join(here, 'worker.ts'))
    this.worker.on('message', (msg: WorkerResponse) => this.onMessage(msg))
    this.worker.on('error', (e) => {
      for (const { reject } of this.pending.values()) reject(new Error(`worker error: ${e.message}`))
      this.pending.clear()
    })
  }

  async loadDocument(bytes: Uint8Array): Promise<LoadResult> {
    return this.request<LoadResult>('loaded', { type: 'load-document', bytes })
  }

  async extractText(): Promise<ExtractTextResult> {
    return this.request<ExtractTextResult>('extracted-text', { type: 'extract-text' })
  }

  async terminate(): Promise<void> {
    await this.worker.terminate()
    for (const { reject } of this.pending.values()) {
      reject(new Error('worker terminated'))
    }
    this.pending.clear()
  }

  private request<T>(
    responseType: WorkerResponse['type'],
    req: WorkerRequestWithoutId,
  ): Promise<T> {
    const id = this.nextId++
    const fullReq = { id, ...req } as WorkerRequest
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
        type: responseType,
      })
      this.worker.postMessage(fullReq)
    })
  }

  private onMessage(msg: WorkerResponse): void {
    if (msg.id === -1) {
      // Worker-side pdfium load failure surfaced before any request.
      return
    }
    const pending = this.pending.get(msg.id)
    if (!pending) return
    this.pending.delete(msg.id)
    if (msg.type !== pending.type) {
      pending.reject(new Error(`unexpected response type: ${msg.type}`))
      return
    }
    // Resolve with the discriminated-union result so callers can pattern-match
    // `{ok:false}` rather than try/catch. Genuine worker errors (crash,
    // disconnect) still go through reject.
    pending.resolve(msg.result)
  }
}
