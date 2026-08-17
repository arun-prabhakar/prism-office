/**
 * Browser shim for node:fs — readFileSync is backed by a pre-populated Map
 * of bytes fetched at Worker startup. All other fs functions are stubs that
 * let font-locate.ts compile and degrade gracefully (no system fonts).
 */

const prefetched = new Map<string, Uint8Array>()

export function setPrefetched(name: string, bytes: Uint8Array): void {
  prefetched.set(name, bytes)
}

export function readFileSync(path: string): Uint8Array {
  const name = path.split('/').pop() ?? path
  const bytes = prefetched.get(name)
  if (!bytes) throw new Error(`fs shim: file not prefetched: ${name}`)
  return bytes
}

export function existsSync(): boolean {
  return false
}
export function readdirSync(): string[] {
  return []
}
export function statSync(): { isFile: () => boolean; isDirectory: () => boolean; size: number } {
  return { isFile: () => false, isDirectory: () => false, size: 0 }
}
export function openSync(): number {
  return -1
}
export function closeSync(): void {}
export function readSync(): number {
  return 0
}
export function mkdirSync(): void {}
export function writeFileSync(): void {}
