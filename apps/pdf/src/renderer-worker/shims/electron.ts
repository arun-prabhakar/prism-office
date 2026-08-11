/**
 * Stub for electron's nativeImage — only image-edit.ts uses it, and text
 * editing doesn't touch image ops. The stub prevents a build failure when
 * Vite encounters `import { nativeImage } from 'electron'`.
 */
export const nativeImage = {
  createFromBuffer: () => ({
    toBitmap: () => new Uint8Array(0),
    toPNG: () => new Uint8Array(0),
    getSize: () => ({ width: 0, height: 0 }),
  }),
  createFromBitmap: () => ({
    toPNG: () => new Uint8Array(0),
    toJPEG: () => new Uint8Array(0),
  }),
  createFromPath: () => null,
}
