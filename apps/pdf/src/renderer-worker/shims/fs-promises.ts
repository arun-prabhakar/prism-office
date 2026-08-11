export async function readFile(): Promise<Uint8Array> {
  throw new Error('node:fs/promises not available in browser Worker')
}
export async function writeFile(): Promise<void> {}
export async function rename(): Promise<void> {}
export async function rm(): Promise<void> {}
