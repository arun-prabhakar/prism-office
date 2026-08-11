import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { join } from 'node:path'
import { renameSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const outDir = join(here, '..', 'editor-service', 'static', 'editor', 'word')

/**
 * Vite names the built HTML after the input file. Our input is
 * `index.web.html` (to coexist with the desktop electron `index.html` in the
 * same source dir), but the editor service serves `/editor/word/index.html`.
 * Rename the output after the bundle closes so the two stay in sync.
 */
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

/**
 * Web build of the docs renderer.
 *
 * Input: apps/docs/src/renderer/index.web.html
 *   (the web entry — waits for SDK init postMessage, sets window.desktop,
 *    then dynamically imports ./main.tsx).
 * Output: apps/editor-service/static/editor/word/
 *   served by the editor service at /editor/word/.
 *
 * The renderer source (apps/docs/src/renderer/**) is unchanged between this
 * web build and the desktop electron-vite build. Only the entry HTML and the
 * window.desktop implementation differ.
 */
export default defineConfig({
  plugins: [react(), renameIndexWebToIndex()],
  root: join(here, 'src', 'renderer'),
  base: '/editor/word/',
  resolve: {
    preserveSymlinks: false,
  },
  build: {
    outDir,
    emptyOutDir: true,
    rollupOptions: {
      input: join(here, 'src', 'renderer', 'index.web.html'),
    },
    sourcemap: true,
  },
  optimizeDeps: { exclude: ['@genoffice/docs'] },
})
