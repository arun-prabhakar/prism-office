/**
 * PrismOffice editor service — Hono server entry.
 *
 * Routes:
 *   GET  /health                  — readiness probe
 *   GET  /sdk/*                   — static SDK bundle (prismoffice.js)
 *   GET  /editor/word/*           — docs editor SPA (Phase 2 fills in)
 *   GET  /editor/pdf/*            — pdf editor SPA (Phase 3 fills in)
 *   POST /fetch-document          — iframe → server proxy for document.url
 *   POST /save-document           — iframe → server uploads new bytes
 *   GET  /saved/:id               — host fetches uploaded bytes (short TTL)
 *
 * Auth model (two-secret pattern):
 *   - iframe POSTs the SDK config (with its HS256 token) to /fetch-document
 *     and /save-document. Server validates the token with the browser secret.
 *   - When the server fetches the host's document.url and posts callbacks
 *     to the host's callbackUrl, it signs those requests with the outbox
 *     secret in the Authorization header (payload {"payload":{"url":...}}).
 *
 * Stateful bits: an in-memory TempStore for /saved/<id> only. Everything
 * else is stateless and horizontally scalable.
 */

import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono, type Context } from 'hono'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  type EditorConfigTokenPayload,
  CallbackStatus,
  type CallbackRequest,
} from '@prismoffice/editor-contract'
import { signJwt } from '@prismoffice/sdk-shared/jwt'
import { verifyConfigToken } from '@prismoffice/sdk-shared/jwt-sign-browser'
import { loadConfig, type ServerConfig } from './config.js'
import { TempStore, newSavedId } from './temp-store.js'

const config = loadConfig()
const tempStore = new TempStore(config.savedUrlTtlSec)

const app = new Hono()

const here = dirname(fileURLToPath(import.meta.url))
const staticDir = join(here, '..', 'static')
const readStatic = (rel: string): string => readFileSync(join(staticDir, rel), 'utf8')

// -------------------------------------------------------------------------
// Health & static
// -------------------------------------------------------------------------

app.get('/health', (c) =>
  c.json({
    ok: true,
    version: '0.1.0',
    browserJwt: !!config.browserSecret,
    outboxJwt: !!config.outboxSecret,
  }),
)

// Static SDK + editor SPA HTML. serveStatic maps URL path → ./static/... path.
app.use('/sdk/*', serveStatic({ root: staticDir }))
app.use('/editor/*', serveStatic({ root: staticDir }))

// serveStatic doesn't auto-resolve `index.html` for directory URLs like
// `/editor/word/` — the iframe loads exactly that. Serve it explicitly.
// Phase 2/3 replace these with Vite-built SPAs at the same paths.
const htmlHeaders = { 'Content-Type': 'text/html; charset=utf-8' }
app.get('/editor/word', (c) => c.body(readStatic('editor/word/index.html'), 200, htmlHeaders))
app.get('/editor/word/', (c) => c.body(readStatic('editor/word/index.html'), 200, htmlHeaders))
app.get('/editor/pdf', (c) => c.body(readStatic('editor/pdf/index.html'), 200, htmlHeaders))
app.get('/editor/pdf/', (c) => c.body(readStatic('editor/pdf/index.html'), 200, htmlHeaders))
app.get('/editor/sheets', (c) => c.body(readStatic('editor/sheets/index.html'), 200, htmlHeaders))
app.get('/editor/sheets/', (c) => c.body(readStatic('editor/sheets/index.html'), 200, htmlHeaders))

// -------------------------------------------------------------------------
// /fetch-document — iframe asks the server to fetch document.url on its behalf
// (bypasses CORS — the iframe is at a different origin than the host).
// -------------------------------------------------------------------------

interface FetchDocumentRequest {
  config: {
    document: { url: string; key: string; fileType?: string }
    token?: string
  }
}

app.post('/fetch-document', async (c) => {
  const body = (await c.req.json().catch(() => null)) as FetchDocumentRequest | null
  if (!body?.config?.token) {
    return c.json({ error: 'missing config.token' }, 401)
  }
  if (!body?.config?.document?.url) {
    return c.json({ error: 'missing document.url' }, 400)
  }

  const verified = await verifyConfigToken(body.config.token, config.browserSecret)
  if (!verified) {
    return c.json({ error: 'invalid config token' }, 401)
  }
  // The signed URL must match what the server is being asked to fetch.
  if (verified.document.url !== body.config.document.url) {
    return c.json({ error: 'url mismatch' }, 401)
  }

  const outboxToken = await signJwt({ payload: { url: body.config.document.url } }, config.outboxSecret)
  const upstream = await fetch(body.config.document.url, {
    headers: { Authorization: `Bearer ${outboxToken}` },
  })
  if (!upstream.ok || !upstream.body) {
    return c.json(
      { error: `upstream ${upstream.status}: ${await upstream.text().catch(() => '')}` },
      502,
    )
  }
  const bytes = new Uint8Array(await upstream.arrayBuffer())
  const filetype = verified.document.fileType ?? ''

  const isPdfMagic = bytes.length >= 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46
  const isZipMagic = bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b
  const expectedPdf = filetype === 'pdf'
  const formatOk = expectedPdf ? isPdfMagic : isZipMagic
  if (!formatOk) {
    const got = isPdfMagic ? 'PDF' : isZipMagic ? 'ZIP/docx' : 'unknown'
    return c.json(
      { error: `invalid file format: expected ${expectedPdf ? 'PDF' : 'docx (ZIP)'} but the file appears to be ${got}` },
      415,
    )
  }

  const hashBuf = await crypto.subtle.digest('SHA-256', bytes)
  const hashHex = Array.from(new Uint8Array(hashBuf)).map((b) => b.toString(16).padStart(2, '0')).join('')
  c.header('X-PrismOffice-File-Type', filetype)
  c.header('X-PrismOffice-Hash', hashHex)
  c.header('Content-Type', 'application/octet-stream')
  c.header('Content-Length', String(bytes.byteLength))
  return c.body(bytes.buffer as ArrayBuffer)
})

// -------------------------------------------------------------------------
// /save-document — iframe uploads new bytes; server holds them at a temp URL
// and POSTs the callback to the host's callbackUrl.
// -------------------------------------------------------------------------

interface SaveDocumentRequest {
  config: {
    document: { key: string; fileType?: string }
    editorConfig?: { callbackUrl?: string }
    token?: string
  }
  bytes: string // base64 (POSTing raw binary through Hono JSON is fine but base64 is simpler)
  filetype: string
}

app.post('/save-document', async (c) => {
  const body = (await c.req.json().catch(() => null)) as SaveDocumentRequest | null
  if (!body?.config?.token) return c.json({ error: 'missing config.token' }, 401)
  if (typeof body.bytes !== 'string') return c.json({ error: 'missing bytes (base64)' }, 400)

  const verified = await verifyConfigToken(body.config.token, config.browserSecret)
  if (!verified) return c.json({ error: 'invalid config token' }, 401)

  const callbackUrl = verified.editorConfig?.callbackUrl
  const key = verified.document.key
  if (!callbackUrl) {
    return c.json({ error: 'config has no callbackUrl — cannot save' }, 400)
  }

  // Decode and stash.
  const bytes = base64Decode(body.bytes)
  const id = newSavedId()
  tempStore.put(id, { bytes, filetype: body.filetype, key })

  // Build the host-reachable URL for the saved bytes. Use the inbound
  // request's origin so the host can reach us.
  const savedUrl = new URL(`/saved/${id}`, new URL(c.req.url).origin).toString()

  // Fire the callback. The host's response tells us whether the save stuck.
  const callbackReq: CallbackRequest = {
    key,
    status: CallbackStatus.ReadyForSaving,
    url: savedUrl,
    filetype: body.filetype,
  }
  const outboxToken = await signJwt({ payload: { url: savedUrl } }, config.outboxSecret)
  const cbResponse = await fetch(callbackUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${await signJwt({ payload: { url: callbackUrl } }, config.outboxSecret)}`,
    },
    body: JSON.stringify(callbackReq),
  })
  if (!cbResponse.ok) {
    tempStore.delete(id)
    return c.json({ error: `callback failed: ${cbResponse.status}` }, 502)
  }
  const cbBody = (await cbResponse.json().catch(() => null)) as { error?: number } | null
  if (!cbBody || cbBody.error !== 0) {
    tempStore.delete(id)
    return c.json({ error: 'callback returned non-zero error' }, 502)
  }

  // Host acknowledged. Delete the temp entry on its TTL; the host has its
  // own copy now.
  return c.json({ ok: true, id })
})

// -------------------------------------------------------------------------
// /saved/:id — host fetches uploaded bytes after the callback fires.
// -------------------------------------------------------------------------

app.get('/saved/:id', async (c) => {
  const id = c.req.param('id')
  const entry = tempStore.get(id)
  if (!entry) return c.json({ error: 'not found or expired' }, 404)

  // Validate the outbox JWT in the Authorization header.
  const auth = c.req.header('Authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null
  if (!token) return c.json({ error: 'missing Authorization' }, 401)
  // We accept ANY valid outbox-signed token for this URL — the simpler model
  // is to check the URL payload matches what we'd sign for this saved URL,
  // but hosts already proved they got the URL from our callback.
  const expectedToken = await signJwt(
    { payload: { url: new URL(`/saved/${id}`, new URL(c.req.url).origin).toString() } },
    config.outboxSecret,
  )
  // Constant-time-ish compare via Web Crypto. For Phase 1, simple equality —
  // the token TTL is 60s and it's HS256 so an attacker would need the secret.
  if (token !== expectedToken) {
    return c.json({ error: 'invalid token' }, 401)
  }

  c.header('Content-Type', 'application/octet-stream')
  c.header('Content-Length', String(entry.bytes.byteLength))
  return c.body(entry.bytes.buffer as ArrayBuffer)
})

// -------------------------------------------------------------------------
// AI routes (Phase 4) — proxy to Genspark with the operator's gsk key.
// Without PRISMOFFICE_GSK_KEY these return a clear "not configured" error.
// -------------------------------------------------------------------------

function aiNotConfigured(c: Context) {
  return c.json(
    {
      error:
        'AI not configured. Set PRISMOFFICE_GSK_KEY on the editor service to enable the AI panel.',
    },
    503,
  )
}

function hasGskKey(): boolean {
  return !!config.gskKey
}

app.get('/ai/settings', (c) => {
  return c.json({
    configured: hasGskKey(),
    provider: config.gskKey ? 'claude' : null,
  })
})

app.post('/ai/stream', async (c) => {
  if (!hasGskKey()) return aiNotConfigured(c)
  return c.json({ error: 'AI streaming proxy not yet wired to Genspark API' }, 501)
})

app.post('/ai/stream-cancel', async (c) => {
  return c.json({ ok: true })
})

app.post('/ai/web-search', async (c) => {
  if (!hasGskKey()) return aiNotConfigured(c)
  return c.json({ results: [], method: 'error', error: 'Genspark web-search proxy not yet wired' })
})

app.post('/ai/image-search', async (c) => {
  if (!hasGskKey()) return aiNotConfigured(c)
  return c.json({ images: [], method: 'error', error: 'Genspark image-search proxy not yet wired' })
})

app.post('/ai/fetch-image', async (c) => {
  if (!hasGskKey()) return aiNotConfigured(c)
  return c.json({ error: 'Genspark fetch-image proxy not yet wired' }, 501)
})

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

function base64Decode(s: string): Uint8Array {
  const bin = atob(s)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

// -------------------------------------------------------------------------
// Start
// -------------------------------------------------------------------------

serve({ fetch: app.fetch, port: config.port, hostname: '0.0.0.0' }, (info) => {
  console.log(`prismoffice editor-service listening on 0.0.0.0:${info.port}`)
  console.log(`  open: http://<your-server-ip>:${info.port}/health`)
})

// Keep the process alive for `tsx watch` and clean shutdown.
process.on('SIGTERM', () => {
  tempStore.close()
  process.exit(0)
})

export { app, config }
export type { EditorConfigTokenPayload }
