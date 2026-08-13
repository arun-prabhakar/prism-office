/**
 * In-browser xlsx engine for the sheets web port — Phase 1 (view-only).
 *
 * Parses .xlsx bytes with SheetJS and produces the {@link WorkbookFile} and
 * {@link WorkbookRangeResult} shapes the sheets renderer expects (defined in
 * `@prismoffice/sheets/shared/desktop-api`). Phase 1 covers cell values +
 * formulas + sheet dimensions + merges + row/column sizes — enough for the
 * Univer grid to mount and display a workbook read-only.
 *
 * Deliberately NOT covered yet (later phases):
 *   - cell style / number-format mapping (styles[], dxfStyles[] stay empty)
 *   - conditional formatting, data validation, tables, pivot tables, sparklines
 *   - formula recalculation — cells render their last cached file values;
 *     editing a formula does NOT re-evaluate dependents (a JS formula engine
 *     or the wasm sidecar is the follow-up)
 *   - save (serialize edits back to .xlsx)
 *
 * Large/streamed workbooks will eventually route through the wasm sidecar
 * instead of this JS path; this module targets small workbooks opened fully
 * in-browser.
 */

import * as XLSX from 'xlsx'
import type { CellObject, WorkBook, WorkSheet } from 'xlsx'
import type { EditorConfigRoot } from '@prismoffice/editor-contract'
import type {
  WorkbookFile,
  WorkbookRangeRequest,
  WorkbookRangeResult,
} from '@prismoffice/sheets/shared/desktop-api'

interface CachedWorkbook {
  book: WorkBook
  /** sheetId (=== sheet name) -> worksheet */
  sheets: Map<string, WorkSheet>
}

const sessions = new Map<string, CachedWorkbook>()

/** crypto.randomUUID in modern browser iframes; UUIDv4-shaped fallback otherwise. */
function newSessionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  const hex = Array.from({ length: 16 }, () => Math.floor(Math.random() * 256))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 19)}-${hex.slice(20, 32)}`
}

/** SHA-256 of the original bytes; 64 hex chars (schema requires length 64). */
async function sha256Hex(data: ArrayBuffer): Promise<string> {
  if (crypto?.subtle) {
    const digest = await crypto.subtle.digest('SHA-256', data)
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
  }
  return '0'.repeat(64)
}

function sheetDimensions(ws: WorkSheet): { rows: number; cols: number } {
  const ref = ws['!ref']
  if (!ref) return { rows: 1, cols: 1 }
  const r = XLSX.utils.decode_range(ref)
  return {
    rows: Math.max(1, r.e.r - r.s.r + 1),
    cols: Math.max(1, r.e.c - r.s.c + 1),
  }
}

/** Map a SheetJS cell to the renderer's cell-scalar union (`string|number|boolean|null`). */
function cellScalar(cell: CellObject): string | number | boolean | null {
  switch (cell.t) {
    case 's': // shared string (formula string results fall through to default)
      return typeof cell.v === 'string' ? cell.v : String(cell.v ?? '')
    case 'n':
      return typeof cell.v === 'number' ? cell.v : Number(cell.v ?? 0)
    case 'b':
      return typeof cell.v === 'boolean' ? cell.v : Boolean(cell.v)
    case 'e': // error → surface the error code as a string value
      return cell.w ?? (typeof cell.v === 'string' ? cell.v : '#ERROR')
    case 'z': // stub / blank → no value record
      return ''
    default:
      return cell.v == null ? '' : String(cell.v)
  }
}

/**
 * Parse .xlsx bytes and register a session. The returned {@link WorkbookFile}
 * is schema-valid against `workbookFileSchema` (sheets metadata filled,
 * styles/dxf/visuals/definedNames empty for Phase 1).
 */
export async function openWorkbook(bytes: ArrayBuffer, name: string): Promise<WorkbookFile> {
  const book = XLSX.read(bytes, { type: 'array' })
  const sessionId = newSessionId()
  const sheets = new Map<string, WorkSheet>()

  const sheetMeta = book.SheetNames.map((sheetName) => {
    const ws = book.Sheets[sheetName]
    sheets.set(sheetName, ws)
    const { rows, cols } = sheetDimensions(ws)
    return {
      id: sheetName,
      name: sheetName,
      rowCount: rows,
      columnCount: cols,
      columnWidths: [],
      defaultRowHeight: null,
      defaultColumnWidth: null,
      freeze: null,
      hidden: false,
      tabColor: null,
      showGridLines: true,
      tables: [],
      comments: [],
      pivotRanges: [],
      pivotTables: [],
      sparklines: [],
    }
  })

  sessions.set(sessionId, { book, sheets })

  return {
    sessionId,
    name,
    sha256: await sha256Hex(bytes),
    entryCount: 0,
    sheets: sheetMeta,
    styles: [],
    dxfStyles: [],
    visuals: [],
    definedNames: [],
    readOnly: false,
  }
}

/**
 * Read a rectangular range of cells for a previously-opened session. Returns
 * cell values + formulas; all advanced surfaces (merges, conditional rules,
 * data validation, …) are empty in Phase 1.
 */
export function readRange(request: WorkbookRangeRequest): WorkbookRangeResult {
  const session = sessions.get(request.sessionId)
  if (!session) throw new Error(`sheets-xlsx: unknown sessionId ${request.sessionId}`)
  const ws = session.sheets.get(request.sheetId)
  if (!ws) throw new Error(`sheets-xlsx: unknown sheetId ${request.sheetId}`)

  const { startRow, endRow, startColumn, endColumn } = request.range
  const cells: WorkbookRangeResult['cells'] = []
  for (let r = startRow; r <= endRow; r++) {
    for (let c = startColumn; c <= endColumn; c++) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })] as CellObject | undefined
      if (!cell || cell.t === 'z') continue
      const value = cellScalar(cell)
      if (value === '' && !cell.f) continue // blank, no formula → skip
      cells.push({
        row: r,
        column: c,
        value,
        ...(cell.f ? { formula: `=${cell.f}` } : {}),
      })
    }
  }

  return {
    cells,
    rows: [],
    merges: ws['!merges']?.map((m) => ({
      startRow: m.s.r,
      startColumn: m.s.c,
      endRow: m.e.r,
      endColumn: m.e.c,
    })) ?? [],
    hyperlinks: [],
    conditionalRules: [],
    autoFilter: null,
    dataValidations: [],
    sheetProtection: null,
    indexedThroughRow: endRow,
    indexingComplete: true,
  }
}

/**
 * Strip function-valued fields from the editor config so it survives
 * `JSON.stringify` when POSTing to `/fetch-document` (functions can't cross
 * the wire and aren't part of the signed payload). Mirrors the SDK's
 * `sanitizeConfigForClone` / docs-api's `sanitizedConfigForSave`.
 */
export function sanitizeConfigForFetch(config: EditorConfigRoot): EditorConfigRoot {
  function strip(value: unknown): unknown {
    if (typeof value === 'function') return undefined
    if (Array.isArray(value)) return value.map(strip)
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        const s = strip(v)
        if (s !== undefined) out[k] = s
      }
      return out
    }
    return value
  }
  return strip(config) as EditorConfigRoot
}
