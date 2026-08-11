/**
 * Web Worker replacement for apps/pdf/src/main/wasm-path.ts.
 * Returns simple key strings that the fs shim (shims/fs.ts) resolves to
 * bytes prefetched at Worker startup.
 */
export function pdfiumWasmPath(): string {
  return 'pdfium.wasm'
}

export function hbSubsetWasmPath(): string {
  return 'hb-subset.wasm'
}
