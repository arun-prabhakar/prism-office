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
const browserSecret = process.env.PRISMOFFICE_BROWSER_SECRET ?? 'dev-browser-secret'
const outboxSecret = process.env.PRISMOFFICE_OUTBOX_SECRET ?? 'dev-outbox-secret'

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
  page.drawText('PrismOffice PDF Editor — Web Port', {
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
  const mode = (c.req.query('mode') ?? 'edit') as 'edit' | 'view'
  const theme = c.req.query('theme') ?? 'light'
  const fileType = type === 'pdf' ? 'pdf' : 'docx'
  const title = decodeURIComponent(url.split('/').pop()?.split('?')[0] ?? 'document')
  const ho = hostOrigin(c)

  try {
    const controller = new AbortController()
    const to = setTimeout(() => controller.abort(), 10_000)
    const probe = await fetch(url, { method: 'HEAD', signal: controller.signal })
    clearTimeout(to)
    if (!probe.ok && probe.status !== 405) {
      return c.html(renderErrorPage(title, url, `HTTP ${probe.status}${probe.statusText ? ' ' + probe.statusText : ''}`))
    }
    const ct = probe.headers.get('content-type') ?? ''
    if (ct && /^(text\/|image\/|video\/|audio\/)/.test(ct)) {
      return c.html(renderErrorPage(title, url, `Expected a .${fileType} file but got ${ct}`))
    }
  } catch (e) {
    const msg = (e as Error).name === 'AbortError'
      ? 'Timed out (10s)'
      : (e as Error).message
    return c.html(renderErrorPage(title, url, msg))
  }

  const fileKey = 'ext-' + Date.now()
  const token = await signConfig(
    {
      documentType: type,
      document: { key: fileKey, url, fileType, title },
      editorConfig: { mode, callbackUrl: `${ho}/track`, user: { id: 'alice', name: 'Alice' }, customization: { uiTheme: theme } },
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
      mode,
      theme,
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
  const mode = (c.req.query('mode') ?? 'edit') as 'edit' | 'view'
  const theme = c.req.query('theme') ?? 'light'
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
        mode,
        callbackUrl: `${ho}/track`,
        user: { id: 'alice', name: 'Alice' },
        customization: { uiTheme: theme },
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
      mode,
      theme,
    }),
  )
})

app.get('/pdf', async (c) => {
  const mode = (c.req.query('mode') ?? 'edit') as 'edit' | 'view'
  const theme = c.req.query('theme') ?? 'light'
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
        mode,
        callbackUrl: `${ho}/track`,
        user: { id: 'alice', name: 'Alice' },
        customization: { uiTheme: theme },
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
      mode,
      theme,
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
  console.log(`prismoffice reference-host listening on 0.0.0.0:${info.port}`)
  console.log(`  editor service port: ${editorServicePort}`)
  console.log(`  open: http://<your-server-ip>:${info.port}/`)
})

function renderLandingPage(editorServiceOrigin: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>PrismOffice Reference Host</title>
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
    <h1>PrismOffice Editor</h1>
    <p class="sub">Self-hosted document editor</p>
    <div class="editors">
      <a class="card" href="/docs">
        <div class="icon">📄</div>
        <div class="name">Sample Doc</div>
        <div class="desc">.docx — edit</div>
      </a>
      <a class="card" href="/docs?mode=view">
        <div class="icon">👁</div>
        <div class="name">Sample Doc</div>
        <div class="desc">.docx — view</div>
      </a>
      <a class="card" href="/pdf">
        <div class="icon">📋</div>
        <div class="name">Sample PDF</div>
        <div class="desc">.pdf — edit</div>
      </a>
      <a class="card" href="/pdf?mode=view">
        <div class="icon">👁</div>
        <div class="name">Sample PDF</div>
        <div class="desc">.pdf — view</div>
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

function renderErrorPage(title: string, url: string, reason: string): string {
  const safeReason = reason.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const safeTitle = title.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  const safeUrl = url.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Unable to open — ${safeTitle}</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; font: 14px/1.6 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f7f7f7; color: #111; }
    .container { max-width: 480px; margin: 80px auto; text-align: center; }
    .icon { font-size: 48px; margin-bottom: 12px; }
    h1 { font-size: 20px; margin: 0 0 8px; }
    .reason { color: #c00; margin-bottom: 16px; font-family: ui-monospace, monospace; font-size: 13px; }
    .url-box { font-family: ui-monospace, monospace; font-size: 12px; color: #888; background: #fff; padding: 8px 12px; border-radius: 4px; border: 1px solid #e0e0e0; word-break: break-all; margin-bottom: 24px; }
    a { color: #0066cc; text-decoration: none; }
    .back { display: inline-block; padding: 8px 20px; border: 1px solid #888; border-radius: 4px; color: #111; }
    .back:hover { background: #eee; }
  </style>
</head>
<body>
  <div class="container">
    <div class="icon">⚠</div>
    <h1>Unable to open document</h1>
    <p class="reason">${safeReason}</p>
    <div class="url-box">${safeTitle}<br/>${safeUrl}</div>
    <a class="back" href="/">← Back to home</a>
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
  mode?: 'edit' | 'view'
  theme?: string
}): string {
  const { token, editorServiceOrigin, hostOrigin, documentType, fileId, fileType, title } = args
  const mode = args.mode ?? 'edit'
  const theme = args.theme ?? 'light'
  const docUrl = args.documentUrl ?? `${hostOrigin}/files/${fileId}/bytes`
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>PrismOffice Reference Host</title>
  <style>
    body { margin: 0; font: 14px/1.4 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
    header { padding: 8px 16px; border-bottom: 1px solid #ddd; background: #f7f7f7; }
    h1 { font-size: 14px; margin: 0; }
    main { padding: 16px; height: calc(100vh - 80px); box-sizing: border-box; }
    #events { font-family: ui-monospace, monospace; font-size: 12px; max-height: 30%; overflow: auto; background: #fafafa; padding: 8px; border-radius: 4px; margin-top: 12px; white-space: pre-wrap; }
    #doc-error { display: flex; align-items: center; justify-content: center; width: 100%; height: 60%; background: #fff; border: 1px solid #e8e8e8; border-radius: 4px; }
    #doc-error .inner { text-align: center; padding: 24px; }
    #doc-error .ei { font-size: 36px; margin-bottom: 8px; }
    #doc-error .et { font-size: 15px; font-weight: 600; color: #333; margin-bottom: 4px; }
    #doc-error .ed { font-size: 12px; color: #999; font-family: ui-monospace, monospace; max-width: 400px; word-break: break-word; }
  </style>
</head>
<body>
  <header>
    <h1>PrismOffice Reference Host — ${documentType}</h1>
  </header>
  <main>
    <div id="placeholder" style="width:100%;height:60%;"></div>
    <div id="events">events will appear here</div>
  </main>
  <script src="${editorServiceOrigin}/sdk/genoffice.js" data-editor-origin="${editorServiceOrigin}"></script>
  <script>
    const eventsEl = document.getElementById('events')
    const logEvent = (msg) => { eventsEl.textContent += '\\n' + msg }
    let docReady = false
    const showDocError = (msg) => {
      if (document.getElementById('doc-error')) return
      const main = document.querySelector('main')
      if (!main) return
      const el = document.createElement('div')
      el.id = 'doc-error'
      const safe = String(msg).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      el.innerHTML = '<div class="inner"><div class="ei">⚠</div><div class="et">Unable to open document</div><div class="ed">' + safe + '</div></div>'
      const ph = document.getElementById('placeholder')
      if (ph) ph.style.display = 'none'
      main.insertBefore(el, main.firstChild)
    }
    window.addEventListener('load', () => {
      logEvent('SDK loaded: PrismOfficeAPI = ' + (typeof window.PrismOfficeAPI))
      const config = {
        documentType: ${JSON.stringify(documentType)},
        document: {
          key: ${JSON.stringify(fileId)} + '-' + Date.now(),
          url: '${docUrl}',
          fileType: ${JSON.stringify(fileType)},
          title: ${JSON.stringify(title)},
        },
        editorConfig: {
          mode: '${mode}',
          callbackUrl: '${hostOrigin}/track',
          user: { id: 'alice', name: 'Alice' },
          customization: { uiTheme: '${theme}' },
        },
        events: {
          onAppReady: () => logEvent('event: onAppReady'),
          onDocumentReady: () => { docReady = true; logEvent('event: onDocumentReady') },
          onDocumentStateChange: (e) => logEvent('event: onDocumentStateChange dirty=' + e.data),
          onError: (e) => {
            logEvent('event: onError ' + JSON.stringify(e.data))
            const d = e.data || {}
            showDocError(d.errorDescription || d.message || JSON.stringify(d))
          },
        },
        token: ${JSON.stringify(token)},
      }
      logEvent('instantiating DocEditor (editor origin ${editorServiceOrigin})')
      window.editor = new window.PrismOfficeAPI.DocEditor('placeholder', config)
      setTimeout(() => {
        if (!docReady) showDocError('Document did not load within 30 seconds. The URL may be unreachable or the file may be invalid.')
      }, 30000)
    })
  </script>
</body>
</html>
  `
}

export { app }
