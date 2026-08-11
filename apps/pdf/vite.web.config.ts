import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { viteStaticCopy } from 'vite-plugin-static-copy'
import { resolve, join } from 'node:path'
import { renameSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const workspaceRoot = join(here, '..', '..')
const pdfjsDir = join(workspaceRoot, 'node_modules', 'pdfjs-dist')
const shimDir = resolve(here, 'src', 'renderer-worker', 'shims')
const outDir = join(here, '..', 'editor-service', 'static', 'editor', 'pdf')

// Vite names the built HTML after the input (`index.web.html`), but the editor
// service serves `/editor/pdf/index.html`. Rename after the bundle closes.
function renameIndexWebToIndex(): Plugin {
  return {
    name: 'rename-index-web-to-index',
    closeBundle() {
      try {
        renameSync(join(outDir, 'index.web.html'), join(outDir, 'index.html'))
      } catch {
        // already renamed or missing — ignore
      }
    },
  }
}

export default defineConfig({
  plugins: [
    react(),
    renameIndexWebToIndex(),
    viteStaticCopy({
      targets: [
        { src: join(pdfjsDir, 'cmaps'), dest: 'pdfjs' },
        { src: join(pdfjsDir, 'standard_fonts'), dest: 'pdfjs' },
        { src: join(pdfjsDir, 'wasm'), dest: 'pdfjs' },
        { src: join(workspaceRoot, 'node_modules/@embedpdf/pdfium/dist/pdfium.wasm'), dest: 'wasm' },
      ],
    }),
  ],
  root: join(here, 'src', 'renderer'),
  base: '/editor/pdf/',
  resolve: {
    alias: [
      { find: /^node:fs\/promises$/, replacement: resolve(shimDir, 'fs-promises.ts') },
      { find: /^node:fs$/, replacement: resolve(shimDir, 'fs.ts') },
      { find: /^node:os$/, replacement: resolve(shimDir, 'os.ts') },
      { find: /^node:path$/, replacement: resolve(shimDir, 'path.ts') },
      { find: /^electron$/, replacement: resolve(here, 'src', 'renderer-worker', 'shims', 'electron.ts') },
      { find: './wasm-path', replacement: resolve(here, 'src', 'renderer-worker', 'wasm-path-web.ts') },
    ],
  },
  worker: {
    format: 'es',
  },
  build: {
    outDir,
    emptyOutDir: true,
    rollupOptions: {
      input: join(here, 'src', 'renderer', 'index.web.html'),
    },
    sourcemap: true,
  },
  optimizeDeps: {
    exclude: ['@genoffice/pdf'],
    include: ['buffer'],
  },
})
