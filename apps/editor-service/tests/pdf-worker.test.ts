/**
 * Spike 2: prove pdfium runs in a Worker.
 *
 * The desktop app currently runs pdfium in the Electron main process. The
 * editor service needs it in a Worker (browser Web Worker or Node Worker
 * Thread) so the runtime doesn't block on heavy pdfium ops. This spike proves
 * the pattern end-to-end: spawn Worker → load pdfium.wasm → open a PDF →
 * read page count → close.
 *
 * Browser port (Phase 3) is the same flow with `fetch('/wasm/pdfium.wasm')`
 * instead of `readFileSync(...)`.
 */

import { PDFDocument, StandardFonts } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { PdfWorkerClient } from '../src/pdf-worker/client'

async function makePdf(text: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const page = doc.addPage([595, 842])
  const font = await doc.embedFont(StandardFonts.Helvetica)
  page.drawText(text, { x: 50, y: 700, size: 14, font })
  return new Uint8Array(await doc.save({ useObjectStreams: false }))
}

describe('pdfium worker (spike 2)', () => {
  it('loads pdfium in a worker and reports the page count', async () => {
    const client = new PdfWorkerClient()
    try {
      const bytes = await makePdf('hello pdfium worker')
      const result = await client.loadDocument(bytes)
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.pageCount).toBe(1)
      }
    } finally {
      await client.terminate()
    }
  }, 60_000)

  it('handles multiple sequential loads', async () => {
    const client = new PdfWorkerClient()
    try {
      const a = await makePdf('first')
      const b = await makePdf('second\nthird')

      const r1 = await client.loadDocument(a)
      expect(r1.ok).toBe(true)

      const r2 = await client.loadDocument(b)
      expect(r2.ok).toBe(true)
      if (r2.ok) expect(r2.pageCount).toBe(1)
    } finally {
      await client.terminate()
    }
  }, 60_000)

  it('returns an error result for non-PDF bytes', async () => {
    const client = new PdfWorkerClient()
    try {
      const garbage = new Uint8Array([0x00, 0x01, 0x02, 0x03])
      const result = await client.loadDocument(garbage)
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toMatch(/pdfium|open/i)
      }
    } finally {
      await client.terminate()
    }
  }, 60_000)
})
