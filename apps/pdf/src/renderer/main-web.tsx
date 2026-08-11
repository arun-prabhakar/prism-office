import type { EditorConfigRoot } from '@genoffice/editor-contract'
import type { HostMessage } from '@genoffice/sdk-shared'
import { createPdfApi } from '@genoffice/web-runtime'
import { PdfWorkerClient } from '../renderer-worker/client'

window.parent.postMessage({ type: 'app-ready' }, '*')

window.addEventListener('message', async (event: MessageEvent) => {
  if (event.source !== window.parent) return
  const msg = event.data as HostMessage | undefined
  if (!msg || msg.type !== 'init') return
  const { config } = event.data as unknown as { config: EditorConfigRoot }
  let pdfWorker: PdfWorkerClient | undefined
  try {
    pdfWorker = new PdfWorkerClient()
  } catch {
    /* Worker unsupported — degrade to viewer-only mode */
  }
  window.pdfApi = createPdfApi({ config, pdfWorker })
  await import('./main.tsx')
})
