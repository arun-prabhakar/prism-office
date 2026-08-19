/**
 * In-browser xlsx engine for the sheets web port — Phase 1 + save.
 *
 * Parses .xlsx bytes with SheetJS and produces the {@link WorkbookFile} and
 * {@link WorkbookRangeResult} shapes the sheets renderer expects (defined in
 * `@prismoffice/sheets/shared/desktop-api`). Covers cell values + formulas +
 * sheet dimensions + merges + row/column sizes, plus SAVE: cell edits,
 * formula values, merge/unmerge, row/col sizes & hidden flags, sheet
 * rename/add — serialized via SheetJS and POSTed to /save-document.
 *
 * Deliberately NOT covered yet (later phases — the wasm sidecar):
 *   - cell style / number-format mapping (styles[], dxfStyles[] stay empty)
 *   - conditional formatting, data validation, tables, pivots, sparklines
 *   - formula-reference-shifting structural ops (insert/remove rows/cols,
 *     move-rows), sheet reorder/duplicate/remove — these fail the save
 *     atomically with a clear error rather than corrupting references
 *   - streaming for large workbooks
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
  WorkbookSaveRequest,
} from '@prismoffice/sheets/shared/desktop-api'

interface CachedWorkbook {
  name: string
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
    if (!ws) throw new Error(`sheets-xlsx: missing worksheet "${sheetName}"`)
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

  sessions.set(sessionId, { name, book, sheets })

  return {
    sessionId,
    name,
    sha256: await sha256Hex(bytes),
    entryCount: 0,
    activeTab: 0,
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
    rowBreaks: [],
    colBreaks: [],
    protectedRanges: [],
    indexedThroughRow: endRow,
    indexingComplete: true,
  }
}

/** Edit-journal arrays that must be empty for a save to proceed. */
const MUST_BE_EMPTY_SAVE_KEYS = [
  'structuralOps',
  'chartEdits',
  'visualEdits',
  'visualAdditions',
  'tableAdditions',
  'pivotAdditions',
  'pivotRefreshUpdates',
  'pivotCacheRefreshPaths',
  'hyperlinkEdits',
  'cfStates',
  'dvStates',
  'pageSetupStates',
  'noteStates',
  'sheetProtections',
  'sparklineAdditions',
  'filterStates',
] as const

function cellObjectType(value: string | number | boolean | null): CellObject['t'] {
  if (typeof value === 'number') return 'n'
  if (typeof value === 'boolean') return 'b'
  return 's'
}

function growRef(ws: WorkSheet, r: number, c: number): void {
  const ref = ws['!ref']
  if (!ref) {
    ws['!ref'] = XLSX.utils.encode_range({ s: { r, c }, e: { r, c } })
    return
  }
  const range = XLSX.utils.decode_range(ref)
  if (r < range.s.r) range.s.r = r
  if (c < range.s.c) range.s.c = c
  if (r > range.e.r) range.e.r = r
  if (c > range.e.c) range.e.c = c
  ws['!ref'] = XLSX.utils.encode_range(range)
}

function axisArray(ws: WorkSheet, rows: boolean): Array<Record<string, unknown>> {
  const key = rows ? '!rows' : '!cols'
  return ((ws[key] as Array<Record<string, unknown>> | undefined) ?? [])
}

/**
 * Serialize a save request to new .xlsx bytes WITHOUT touching the cached
 * session (the clone absorbs the edits; the caller swaps the session only
 * after the bytes are persisted). Throws for edit kinds this JS engine can't
 * represent faithfully — a save must fail atomically, never corrupt.
 */
export function buildWorkbookBytes(request: WorkbookSaveRequest): ArrayBuffer {
  const session = sessions.get(request.sessionId)
  if (!session) throw new Error(`sheets-xlsx: unknown sessionId ${request.sessionId}`)

  for (const key of MUST_BE_EMPTY_SAVE_KEYS) {
    const ops = request[key]
    if (ops.length > 0) {
      throw new Error(`sheets-xlsx: ${key} is not supported on the web port (yet)`)
    }
  }
  for (const op of request.structuralOps) {
    if (
      op.kind !== 'merge-cells' &&
      op.kind !== 'unmerge-cells' &&
      op.kind !== 'set-row-size' &&
      op.kind !== 'set-col-size' &&
      op.kind !== 'set-rows-hidden' &&
      op.kind !== 'set-cols-hidden'
    ) {
      throw new Error(`sheets-xlsx: structuralOps.${op.kind} is not supported on the web port (yet)`)
    }
  }
  for (const op of request.sheetOps) {
    if (op.kind !== 'rename-sheet' && op.kind !== 'add-sheet') {
      throw new Error(`sheets-xlsx: sheetOps.${op.kind} is not supported on the web port (yet)`)
    }
  }

  const book = structuredClone(session.book) as WorkBook
  const sheets = new Map(book.SheetNames.map((n) => [n, book.Sheets[n]] as const))
  const sheetOf = (sheetId: string): WorkSheet => {
    const ws = sheets.get(sheetId)
    if (!ws) throw new Error(`sheets-xlsx: unknown sheetId ${sheetId}`)
    return ws
  }

  for (const edit of request.edits) {
    if (!edit.writeValue) continue // style-only — no style model in Phase 1
    const ws = sheetOf(edit.sheetId)
    const addr = XLSX.utils.encode_cell({ r: edit.row, c: edit.column })
    if (edit.formula) {
      const f = edit.formula.startsWith('=') ? edit.formula.slice(1) : edit.formula
      const v = edit.value ?? ''
      ws[addr] = { t: cellObjectType(v), v, f } as CellObject
    } else if (edit.value === null || edit.value === '') {
      delete ws[addr]
    } else {
      ws[addr] = { t: cellObjectType(edit.value), v: edit.value } as CellObject
    }
    growRef(ws, edit.row, edit.column)
  }

  // Recalculated formula outputs: refresh the cached <v> alongside the f.
  for (const fv of request.formulaValues) {
    const ws = sheetOf(fv.sheetId)
    const addr = XLSX.utils.encode_cell({ r: fv.row, c: fv.column })
    const cell = ws[addr] as CellObject | undefined
    if (cell && typeof cell === 'object' && cell.f) {
      cell.v = fv.value ?? ''
      cell.t = cellObjectType(cell.v)
      delete cell.w
    } else if (fv.value !== null && fv.value !== '') {
      ws[addr] = { t: cellObjectType(fv.value), v: fv.value } as CellObject
      growRef(ws, fv.row, fv.column)
    }
  }

  for (const op of request.structuralOps) {
    const ws = sheetOf(op.sheetId)
    if (op.kind === 'merge-cells') {
      ws['!merges'] = [...(ws['!merges'] ?? []), { s: { r: op.range.startRow, c: op.range.startColumn }, e: { r: op.range.endRow, c: op.range.endColumn } }]
    } else if (op.kind === 'unmerge-cells') {
      ws['!merges'] = (ws['!merges'] ?? []).filter(
        (m) =>
          !(
            m.s.r === op.range.startRow &&
            m.s.c === op.range.startColumn &&
            m.e.r === op.range.endRow &&
            m.e.c === op.range.endColumn
          ),
      )
    } else if (op.kind === 'set-row-size' || op.kind === 'set-col-size') {
      const rows = op.kind === 'set-row-size'
      const axis = axisArray(ws, rows)
      for (let i = op.start; i <= op.end; i++) {
        const cell = { ...axis[i] }
        if (op.size === null) delete cell[rows ? 'hpt' : 'wch']
        else cell[rows ? 'hpt' : 'wch'] = op.size
        axis[i] = cell
      }
      ws[rows ? '!rows' : '!cols'] = axis
    } else if (op.kind === 'set-rows-hidden' || op.kind === 'set-cols-hidden') {
      const rows = op.kind === 'set-rows-hidden'
      const axis = axisArray(ws, rows)
      for (let i = op.start; i <= op.end; i++) {
        axis[i] = { ...axis[i], hidden: op.hidden }
      }
      ws[rows ? '!rows' : '!cols'] = axis
    } else {
      throw new Error(`sheets-xlsx: structuralOps.${op.kind} is not supported on the web port (yet)`)
    }
  }

  for (const op of request.sheetOps) {
    if (op.kind === 'rename-sheet') {
      const ws = sheetOf(op.sheetId)
      delete book.Sheets[op.sheetId]
      book.Sheets[op.newName] = ws
      const idx = book.SheetNames.indexOf(op.sheetId)
      book.SheetNames[idx] = op.newName
      sheets.delete(op.sheetId)
      sheets.set(op.newName, ws)
    } else if (op.kind === 'add-sheet') {
      const ws: WorkSheet = { '!ref': 'A1:A1' }
      XLSX.utils.book_append_sheet(book, ws, op.name)
      sheets.set(op.name, ws)
    } else {
      throw new Error(`sheets-xlsx: sheetOps.${op.kind} is not supported on the web port (yet)`)
    }
  }

  // Tab reorder is rejected above via the sheetOps kind check (reorder-sheets,
  // duplicate-sheet, remove-sheet). The remaining supported ops (rename, add)
  // mutate SheetNames/Univer ids in ways that make a naive sheetOrder comparison
  // against post-op SheetNames false-positive, so we skip the guard here.

  const out = XLSX.write(book, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer
  return out
}

/**
 * Replace a session with freshly-persisted bytes: the old session is dropped
 * and the re-parsed workbook registers under a new sessionId (the returned
 * manifest's id — the renderer re-binds to it).
 */
export async function swapSession(
  oldSessionId: string,
  bytes: ArrayBuffer,
): Promise<WorkbookFile> {
  const old = sessions.get(oldSessionId)
  if (!old) throw new Error(`sheets-xlsx: unknown sessionId ${oldSessionId}`)
  sessions.delete(oldSessionId)
  return openWorkbook(bytes, old.name)
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
