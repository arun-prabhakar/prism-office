/**
 * Reference host app — minimal Hono server that demonstrates the integrator
 * pattern: serve a host page, sign editor-config JWTs with the browser
 * secret, provide a `document.url` endpoint, handle the save callback.
 *
 * Phase 1 ships this as a working end-to-end example. Phase 5 polishes it
 * (file list UI, version history, multi-user demo, integrator guide).
 */

import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono, type Context } from 'hono'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { signConfig } from '@genoffice/sdk-shared/jwt-sign-browser'
import { signJwt, verifyJwt } from '@genoffice/sdk-shared/jwt'
import { CallbackStatus, type CallbackRequest } from '@genoffice/editor-contract'

const here = dirname(fileURLToPath(import.meta.url))
const workspaceRoot = join(here, '..', '..', '..')
const port = Number(process.env.PORT ?? '3001')
const editorServicePort = Number(process.env.EDITOR_SERVICE_PORT ?? '3000')
const configuredEditorOrigin = process.env.EDITOR_SERVICE_URL ?? ''
const browserSecret = process.env.GENOFFICE_BROWSER_SECRET ?? 'dev-browser-secret'
const outboxSecret = process.env.GENOFFICE_OUTBOX_SECRET ?? 'dev-outbox-secret'

function editorOrigin(c: Context): string {
  if (configuredEditorOrigin) return configuredEditorOrigin
  const u = new URL(c.req.url)
  return `${u.protocol}//${u.hostname}:${editorServicePort}`
}

function hostOrigin(c: Context): string {
  const u = new URL(c.req.url)
  return `${u.protocol}//${u.host}`
}

const app = new Hono()

// In-memory file store. Phase 5 replaces with real persistence.
const files = new Map<string, { name: string; filetype: string; bytes: Uint8Array; versions: Uint8Array[] }>()

// Seed a fixture docx so the host page has something to open immediately.
async function seedFixture(): Promise<void> {
  const fixturePath = join(here, '..', 'fixtures', 'simple.docx')
  const fixtureBytes = new Uint8Array(await readFile(fixturePath))
  files.set('fixture', {
    name: 'simple.docx',
    filetype: 'docx',
    bytes: fixtureBytes,
    versions: [fixtureBytes],
  })
  const { PDFDocument, StandardFonts } = await import('pdf-lib')
  const doc = await PDFDocument.create()
  const page = doc.addPage([595, 842])
  const font = await doc.embedFont(StandardFonts.Helvetica)
  page.drawText('GenOffice PDF Editor — Web Port', {
    x: 50,
    y: 750,
    size: 18,
    font,
  })
  page.drawText('Phase 3 MVP: viewer-only mode.', {
    x: 50,
    y: 720,
    size: 12,
    font,
  })
  const pdfBytes = new Uint8Array(await doc.save())
  files.set('fixture-pdf', {
    name: 'phase3.pdf',
    filetype: 'pdf',
    bytes: pdfBytes,
    versions: [pdfBytes],
  })
}

await seedFixture()

// -------------------------------------------------------------------------
// Host page (with the editor embedded)
// -------------------------------------------------------------------------

app.get('/', (c) => {
  return c.html(renderLandingPage(editorOrigin(c)))
})

app.get('/open', async (c) => {
  const url = c.req.query('url')
  if (!url) return c.text('Missing ?url= parameter. Example: /open?url=https://example.com/doc.docx', 400)
  const type = (c.req.query('type') ?? 'word') as 'word' | 'pdf'
  const fileType = type === 'pdf' ? 'pdf' : 'docx'
  const title = decodeURIComponent(url.split('/').pop()?.split('?')[0] ?? 'document')
  const ho = hostOrigin(c)
  const fileKey = 'ext-' + Date.now()
  const token = await signConfig(
    {
      documentType: type,
      document: { key: fileKey, url, fileType, title },
      editorConfig: { mode: 'edit', callbackUrl: `${ho}/track`, user: { id: 'alice', name: 'Alice' } },
    },
    browserSecret,
  )
  return c.html(
    renderHostPage({
      token,
      editorServiceOrigin: editorOrigin(c),
      hostOrigin: ho,
      documentType: type,
      fileId: fileKey,
      fileType,
      title,
      documentUrl: url,
    }),
  )
})

app.post('/upload', async (c) => {
  const body = await c.req.parseBody()
  const file = body['file'] as File | undefined
  if (!file) return c.text('No file uploaded. Use multipart form-data with field "file".', 400)
  const ext = (file.name.split('.').pop() ?? '').toLowerCase()
  const fileType = ext === 'pdf' ? 'pdf' : 'docx'
  const type = ext === 'pdf' ? 'pdf' : 'word'
  const fileKey = 'upload-' + Date.now()
  const bytes = new Uint8Array(await file.arrayBuffer())
  files.set(fileKey, { name: file.name, filetype: fileType, bytes, versions: [bytes] })
  const ho = hostOrigin(c)
  return c.redirect(`${ho}/files/${fileKey}/edit`, 302)
})

app.get('/files/:id/edit', async (c) => {
  const fileId = c.req.param('id')
  const file = files.get(fileId)
  if (!file) return c.text('File not found', 404)
  const type = file.filetype === 'pdf' ? 'pdf' : 'word'
  const ho = hostOrigin(c)
  const token = await signConfig(
    {
      documentType: type,
      document: {
        key: fileId + '-' + Date.now(),
        url: `${ho}/files/${fileId}/bytes`,
        fileType: file.filetype,
        title: file.name,
      },
      editorConfig: { mode: 'edit', callbackUrl: `${ho}/track`, user: { id: 'alice', name: 'Alice' } },
    },
    browserSecret,
  )
  return c.html(
    renderHostPage({
      token,
      editorServiceOrigin: editorOrigin(c),
      hostOrigin: ho,
      documentType: type,
      fileId,
      fileType: file.filetype,
      title: file.name,
    }),
  )
})

app.get('/docs', async (c) => {
  const ho = hostOrigin(c)
  const token = await signConfig(
    {
      documentType: 'word',
      document: {
        key: 'fixture-' + Date.now(),
        url: `${ho}/files/fixture/bytes`,
        fileType: 'docx',
        title: 'simple.docx',
      },
      editorConfig: {
        mode: 'edit',
        callbackUrl: `${ho}/track`,
        user: { id: 'alice', name: 'Alice' },
      },
    },
    browserSecret,
  )
  return c.html(
    renderHostPage({
      token,
      editorServiceOrigin: editorOrigin(c),
      hostOrigin: ho,
      documentType: 'word',
      fileId: 'fixture',
      fileType: 'docx',
      title: 'simple.docx',
    }),
  )
})

app.get('/pdf', async (c) => {
  const ho = hostOrigin(c)
  const token = await signConfig(
    {
      documentType: 'pdf',
      document: {
        key: 'fixture-pdf-' + Date.now(),
        url: `${ho}/files/fixture-pdf/bytes`,
        fileType: 'pdf',
        title: 'phase3.pdf',
      },
      editorConfig: {
        mode: 'edit',
        callbackUrl: `${ho}/track`,
        user: { id: 'alice', name: 'Alice' },
      },
    },
    browserSecret,
  )
  return c.html(
    renderHostPage({
      token,
      editorServiceOrigin: editorOrigin(c),
      hostOrigin: ho,
      documentType: 'pdf',
      fileId: 'fixture-pdf',
      fileType: 'pdf',
      title: 'phase3.pdf',
    }),
  )
})

// -------------------------------------------------------------------------
// document.url endpoint — editor service fetches this with outbox JWT.
// -------------------------------------------------------------------------

app.get('/files/:id/bytes', async (c) => {
  const id = c.req.param('id')
  const file = files.get(id)
  if (!file) return c.text('not found', 404)

  // Validate the outbox JWT in the Authorization header.
  const auth = c.req.header('Authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null
  if (!token) return c.text('missing Authorization', 401)
  const payload = await verifyJwt<{ payload: { url: string } }>(token, outboxSecret)
  if (!payload) return c.text('invalid token', 401)

  const expectedUrl = `${hostOrigin(c)}/files/${id}/bytes`
  if (payload.payload.url !== expectedUrl && payload.payload.url !== c.req.url) {
    return c.text('url mismatch', 401)
  }

  c.header('Content-Type', 'application/octet-stream')
  c.header('Content-Length', String(file.bytes.byteLength))
  return c.body(file.bytes.buffer as ArrayBuffer)
})

// -------------------------------------------------------------------------
// callbackUrl endpoint — editor service POSTs save status here.
// -------------------------------------------------------------------------

app.post('/track', async (c) => {
  const auth = c.req.header('Authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null
  if (!token) return c.json({ error: 1 }, 401)
  const payload = await verifyJwt<{ payload: { url: string } }>(token, outboxSecret)
  if (!payload) return c.json({ error: 1 }, 401)

  const req = (await c.req.json().catch(() => null)) as CallbackRequest | null
  if (!req) return c.json({ error: 1 }, { status: 400 })

  // status 2 = save. Fetch the bytes from the editor service's temp URL.
  if (req.status === CallbackStatus.ReadyForSaving && req.url && req.key) {
    // Sign a fresh outbox JWT for the saved URL — must match the shape the
    // editor service expects on /saved/:id ({ payload: { url } }, same secret).
    const savedUrl = req.url
    const fetchToken = await signJwt({ payload: { url: savedUrl } }, outboxSecret)
    const r = await fetch(savedUrl, {
      headers: { Authorization: `Bearer ${fetchToken}` },
    })
    if (!r.ok) return c.json({ error: 2 })
    const newBytes = new Uint8Array(await r.arrayBuffer())
    const fileKey = req.key
    const existing = files.get(fileKey)
    if (existing) {
      existing.bytes = newBytes
      existing.versions.push(newBytes)
    } else {
      files.set(fileKey, {
        name: fileKey,
        filetype: 'docx',
        bytes: newBytes,
        versions: [newBytes],
      })
    }
    console.log(`host received save for ${req.key}: ${newBytes.byteLength} bytes`)
  }

  return c.json({ error: 0 })
})

// -------------------------------------------------------------------------
// Test-only endpoints — expose original + saved bytes for byte-preservation
// regression tests. (Production integrators back these with their own file
// store; the reference host keeps them in-memory.)
// -------------------------------------------------------------------------

app.get('/files/:id/original', (c) => {
  const file = files.get(c.req.param('id'))
  if (!file) return c.text('not found', 404)
  // versions[0] is the seed; never mutated.
  const original = file.versions[0] ?? file.bytes
  c.header('Content-Type', 'application/octet-stream')
  c.header('Content-Length', String(original.byteLength))
  return c.body(original.buffer as ArrayBuffer)
})

app.get('/files/:id/latest', (c) => {
  const file = files.get(c.req.param('id'))
  if (!file) return c.text('not found', 404)
  const latest = file.versions.at(-1) ?? file.bytes
  c.header('Content-Type', 'application/octet-stream')
  c.header('Content-Length', String(latest.byteLength))
  return c.body(latest.buffer as ArrayBuffer)
})

app.get('/files/:id/versions-count', (c) => {
  const file = files.get(c.req.param('id'))
  if (!file) return c.text('not found', 404)
  return c.json({ count: file.versions.length })
})

// -------------------------------------------------------------------------
// Static: serve the host page assets (none for Phase 1 — HTML is inlined).
// -------------------------------------------------------------------------

app.use('/static/*', serveStatic({ root: './static' }))

// -------------------------------------------------------------------------
// Start
// -------------------------------------------------------------------------

serve({ fetch: app.fetch, port, hostname: '0.0.0.0' }, (info) => {
  console.log(`genoffice reference-host listening on 0.0.0.0:${info.port}`)
  console.log(`  editor service port: ${editorServicePort}`)
  console.log(`  open: http://<your-server-ip>:${info.port}/`)
})

function renderLandingPage(editorServiceOrigin: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>GenOffice Reference Host</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; font: 14px/1.6 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f7f7f7; color: #111; }
    .container { max-width: 500px; margin: 60px auto; text-align: center; }
    h1 { font-size: 24px; margin-bottom: 4px; }
    p.sub { color: #888; margin: 0 0 24px; }
    .editors { display: flex; gap: 12px; justify-content: center; margin-bottom: 24px; }
    .card { display: block; width: 180px; padding: 20px; border: 1px solid #ddd; border-radius: 8px; text-decoration: none; color: #111; background: #fff; }
    .card:hover { box-shadow: 0 2px 8px rgba(0,0,0,.08); }
    .card .icon { font-size: 28px; }
    .card .name { font-weight: 600; margin-top: 4px; }
    .card .desc { font-size: 11px; color: #999; }
    .upload { border: 2px dashed #ccc; border-radius: 8px; padding: 20px; background: #fff; }
    .upload input[type=file] { margin-bottom: 8px; }
    .upload button { padding: 8px 20px; border: 1px solid #888; background: #fff; cursor: pointer; border-radius: 4px; }
    .upload button:hover { background: #f0f0f0; }
    .info { margin-top: 16px; font-size: 11px; color: #aaa; }
  </style>
</head>
<body>
  <div class="container">
    <h1>GenOffice Editor</h1>
    <p class="sub">Self-hosted document editor</p>
    <div class="editors">
      <a class="card" href="/docs">
        <div class="icon">📄</div>
        <div class="name">Sample Doc</div>
        <div class="desc">.docx fixture</div>
      </a>
      <a class="card" href="/pdf">
        <div class="icon">📋</div>
        <div class="name">Sample PDF</div>
        <div class="desc">.pdf fixture</div>
      </a>
    </div>
    <form class="upload" method="POST" action="/upload" enctype="multipart/form-data">
      <div><strong>Or upload your own file:</strong></div>
      <input type="file" name="file" accept=".docx,.pdf" required />
      <br/>
      <button type="submit">Open in Editor</button>
    </form>
    <div class="info">Editor service: ${editorServiceOrigin}</div>
  </div>
</body>
</html>`
}

function renderHostPage(args: {
  token: string
  editorServiceOrigin: string
  hostOrigin: string
  documentType: string
  fileId: string
  fileType: string
  title: string
  documentUrl?: string
}): string {
  const { token, editorServiceOrigin, hostOrigin, documentType, fileId, fileType, title } = args
  const docUrl = args.documentUrl ?? `${hostOrigin}/files/${fileId}/bytes`
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>GenOffice Reference Host</title>
  <style>
    body { margin: 0; font: 14px/1.4 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
    header { padding: 8px 16px; border-bottom: 1px solid #ddd; background: #f7f7f7; }
    h1 { font-size: 14px; margin: 0; }
    main { padding: 16px; height: calc(100vh - 80px); box-sizing: border-box; }
    #events { font-family: ui-monospace, monospace; font-size: 12px; max-height: 30%; overflow: auto; background: #fafafa; padding: 8px; border-radius: 4px; margin-top: 12px; white-space: pre-wrap; }
  </style>
</head>
<body>
  <header>
    <h1>GenOffice Reference Host — ${documentType}</h1>
  </header>
  <main>
    <div id="placeholder" style="width:100%;height:60%;"></div>
    <div id="events">events will appear here</div>
  </main>
  <script src="${editorServiceOrigin}/sdk/genoffice.js" data-editor-origin="${editorServiceOrigin}"></script>
  <script>
    const eventsEl = document.getElementById('events')
    const logEvent = (msg) => { eventsEl.textContent += '\\n' + msg }
    window.addEventListener('load', () => {
      logEvent('SDK loaded: GenOfficeAPI = ' + (typeof window.GenOfficeAPI))
      const config = {
        documentType: ${JSON.stringify(documentType)},
        document: {
          key: ${JSON.stringify(fileId)} + '-' + Date.now(),
          url: '${docUrl}',
          fileType: ${JSON.stringify(fileType)},
          title: ${JSON.stringify(title)},
        },
        editorConfig: {
          mode: 'edit',
          callbackUrl: '${hostOrigin}/track',
          user: { id: 'alice', name: 'Alice' },
        },
        events: {
          onAppReady: () => logEvent('event: onAppReady'),
          onDocumentReady: () => logEvent('event: onDocumentReady'),
          onDocumentStateChange: (e) => logEvent('event: onDocumentStateChange dirty=' + e.data),
          onError: (e) => logEvent('event: onError ' + JSON.stringify(e.data)),
        },
        token: ${JSON.stringify(token)},
      }
      logEvent('instantiating DocEditor (editor origin ${editorServiceOrigin})')
      window.editor = new window.GenOfficeAPI.DocEditor('placeholder', config)
    })
  </script>
</body>
</html>
  `
}

export { app }
