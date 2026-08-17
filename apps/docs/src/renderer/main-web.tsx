/**
 * Web entry — bootstraps the docs renderer inside the editor-service iframe.
 *
 * Sequence:
 *   1. iframe loads this module.
 *   2. We immediately fire `app-ready` at the host SDK (parent window).
 *   3. The SDK validates our origin and replies with `init` carrying the
 *      signed editor config.
 *   4. We construct a web-side DesktopApi implementation (createDesktopApi)
 *      and assign it to `window.desktop` so the renderer (unchanged from
 *      desktop) finds the bridge it expects.
 *   5. We dynamically import the existing `./main.tsx`, which runs the
 *      renderer's normal bootstrap (read lang/theme from window.desktop,
 *      mount <App/>).
 *
 * The renderer code (apps/docs/src/renderer/main.tsx + App.tsx + …) does
 * not change between desktop and web — only this entry module and the
 * window.desktop implementation differ.
 */

import type { EditorConfigRoot } from '@prismoffice/editor-contract'
import type { HostMessage } from '@prismoffice/sdk-shared'
import { createDesktopApi } from '@prismoffice/web-runtime'

interface InitPayload {
  config: EditorConfigRoot
}

window.parent.postMessage({ type: 'app-ready' }, '*')

window.addEventListener('message', async (event: MessageEvent) => {
  if (event.source !== window.parent) return
  const msg = event.data as HostMessage | undefined
  if (!msg || msg.type !== 'init') return
  const { config } = msg as unknown as InitPayload
  window.desktop = createDesktopApi({ config })
  // Web-port marker read by the renderer to hide desktop-only chrome (AI dock).
  window.__prismofficeWeb = true
  // Dynamically import so window.desktop is set BEFORE the renderer boots.
  await import('./main')
})
