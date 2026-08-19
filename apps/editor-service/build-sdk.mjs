// Bundle the SDK into a single IIFE file at static/sdk/prismoffice.js so the
// editor service can serve it at /sdk/prismoffice.js
// pattern: <script src="https://EDITOR_SERVICE_URL/sdk/prismoffice.js">).
//
// Output is a single file with no imports — safe to drop into any host page.
// The SDK registers window.PrismOfficeAPI as a side effect of import, so we
// don't need a globalName.

import { build } from 'esbuild'
import { mkdir, rm, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const workspaceRoot = join(here, '..', '..')
const outDir = join(here, 'static', 'sdk')
const outFile = join(outDir, 'prismoffice.js')

await rm(outDir, { recursive: true, force: true })
await mkdir(outDir, { recursive: true })

await build({
  entryPoints: [join(workspaceRoot, 'packages', 'sdk-shared', 'src', 'index.ts')],
  bundle: true,
  format: 'iife',
  outfile: outFile,
  target: 'es2022',
  platform: 'browser',
  legalComments: 'none',
  banner: {
    js: '/* PrismOffice editor SDK — bundle of @prismoffice/sdk-shared. Registers window.PrismOfficeAPI. */',
  },
})

const size = (await readFile(outFile)).byteLength
console.log(`bundled SDK -> ${outFile} (${size} bytes)`)
