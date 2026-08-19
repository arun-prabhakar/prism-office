/**
 * Web entry — bootstraps the sheets renderer inside the editor-service iframe.
 *
 * Sequence (mirrors apps/docs/src/renderer/main-web.tsx):
 *   1. iframe loads this module.
 *   2. We immediately fire `app-ready` at the host SDK (parent window).
 *   3. The SDK validates our origin and replies with `init` carrying the
 *      signed editor config.
 *   4. We construct a web-side DesktopApi implementation (createSheetsApi)
 *      and assign it to `window.desktopApi` so the renderer (unchanged from
 *      desktop) finds the bridge it expects.
 *   5. We dynamically import the existing `./main.tsx`, which runs the
 *      renderer's normal bootstrap (read lang/theme from window.desktopApi,
 *      mount <App/>).
 *
 * The renderer code (apps/sheets/src/renderer/main.tsx + App.tsx + …) does
 * not change between desktop and web — only this entry module and the
 * window.desktopApi implementation differ.
 *
 * NOTE (Phase 1): the xlsx Rust sidecar does not run in this build. The
 * web-runtime sheets-api returns degraded responses for workbook read/recalc/
 * save until the wasm backend lands; small workbooks will be opened fully
 * in-browser in a follow-up.
 */

import type { EditorConfigRoot } from '@prismoffice/editor-contract'
import type { HostMessage } from '@prismoffice/sdk-shared'
import { createSheetsApi } from '@prismoffice/web-runtime'

interface InitPayload {
  config: EditorConfigRoot
}

window.parent.postMessage({ type: 'app-ready' }, '*')

window.addEventListener('message', async (event: MessageEvent) => {
  if (event.source !== window.parent) return
  const msg = event.data as HostMessage | undefined
  if (!msg || msg.type !== 'init') return
  const { config } = msg as unknown as InitPayload
  // env.d.ts declares `readonly desktopApi`; Object.assign respects the
  // runtime bridge contract without fighting the readonly type.
  Object.assign(window, { desktopApi: createSheetsApi({ config }) })
  // Web-port marker read by the renderer to hide desktop-only chrome (AI dock).
  ;(window as Record<string, unknown>).__prismofficeWeb = true
  // Dynamically import so window.desktopApi is set BEFORE the renderer boots.
  await import('./main')
})
