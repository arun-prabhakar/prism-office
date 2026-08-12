# Installation

PrismOffice is a self-hosted editor **service** that you embed into your own
web app via an iframe + JavaScript SDK. There are two parts to a working
setup:

1. **The editor service** — the stateless Node/Hono server you run (this guide).
2. **Your host app** — the page that loads the SDK and embeds the editor
   ([Embedding](#embedding-the-editor-in-your-app) below).

This guide covers running the service three ways (Docker, Docker Compose,
bare Node), every configuration knob, and the minimum code to embed the
editor and wire up saves.

---

## Prerequisites

- **To run the service:** either Docker, or Node.js 22+.
- **A host application** that can serve documents over HTTPS and receive save
  callbacks. The editor service fetches documents from a URL **you** provide,
  so your app must be able to serve the file and accept a POST back on save.
- **Two shared secrets** — random hex strings used to sign/verify the editor
  config JWT (browser ↔ service) and the service ↔ host callbacks. Generate
  them once and keep them stable:

  ```bash
  openssl rand -hex 32   # PRISMOFFICE_BROWSER_SECRET
  openssl rand -hex 32   # PRISMOFFICE_OUTBOX_SECRET
  ```

---

## Option A — Docker (recommended)

The Dockerfile builds a lean `node:22-alpine` image containing the editor
service, the prebuilt SDK bundle, and the docs/PDF editor SPA bundles.

```bash
# Build
docker build -t prismoffice -f apps/editor-service/Dockerfile .

# Run
docker run -d --name prismoffice -p 3000:3000 \
  -e PRISMOFFICE_BROWSER_SECRET=<your-browser-secret> \
  -e PRISMOFFICE_OUTBOX_SECRET=<your-outbox-secret> \
  -e PRISMOFFICE_INBOX_SECRET=<optional-host-to-service-secret> \
  prismoffice
```

The service listens on `0.0.0.0:3000`. Put it behind your own TLS-terminating
reverse proxy (nginx, Caddy, your cloud load balancer) before exposing it —
the container itself serves plain HTTP.

Verify it is up:

```bash
curl http://localhost:3000/health
# {"ok":true,"version":"0.1.0","browserJwt":true,"outboxJwt":true}
```

## Option B — Docker Compose

```yaml
# docker-compose.yml
services:
  prismoffice:
    build:
      context: .
      dockerfile: apps/editor-service/Dockerfile
    ports:
      - "3000:3000"
    environment:
      PRISMOFFICE_BROWSER_SECRET: ${PRISMOFFICE_BROWSER_SECRET}
      PRISMOFFICE_OUTBOX_SECRET: ${PRISMOFFICE_OUTBOX_SECRET}
      # PRISMOFFICE_INBOX_SECRET: ${PRISMOFFICE_INBOX_SECRET}
      # PRISMOFFICE_GSK_KEY: ${PRISMOFFICE_GSK_KEY}   # optional AI proxy key
    restart: unless-stopped
```

```bash
export PRISMOFFICE_BROWSER_SECRET=$(openssl rand -hex 32)
export PRISMOFFICE_OUTBOX_SECRET=$(openssl rand -hex 32)
docker compose up -d
```

## Option C — Bare Node

Useful for development, or when you want to run without containers.

```bash
# 1. Install dependencies (skips the Electron download — not needed for the web service)
PRISMOFFICE_SKIP_ELECTRON=1 npm install

# 2. Build the SDK bundle and the editor SPA bundles
npm run build:sdk -w @genoffice/editor-service
npm run build:web -w @genoffice/docs
npm run build:web -w @genoffice/pdf

# 3. Run the service
export PORT=3000
export PRISMOFFICE_BROWSER_SECRET=$(openssl rand -hex 32)
export PRISMOFFICE_OUTBOX_SECRET=$(openssl rand -hex 32)
npx tsx apps/editor-service/src/server.ts
```

---

## Configuration

All configuration is via environment variables. There are no config files.

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `PORT` | no | `3000` | Port the service listens on. |
| `PRISMOFFICE_BROWSER_SECRET` | **yes** | — | HS256 secret used to **verify** the editor config JWT the iframe receives. Your host app signs the config with this same secret. |
| `PRISMOFFICE_OUTBOX_SECRET` | **yes** | — | HS256 secret used to **sign** service → host requests: save callbacks (`callbackUrl`) and document fetches. Your host verifies these with the same secret. |
| `PRISMOFFICE_INBOX_SECRET` | no | — | HS256 secret validating host → service requests (reserved for future server-side commands). |
| `SAVED_URL_TTL_SEC` | no | `60` | How long a `/saved/<id>` temp URL stays valid, in seconds. |
| `PRISMOFFICE_GSK_KEY` | no | — | Optional operator AI key. If set, the `/ai/*` proxy endpoints become available to the editor. Omit to ship an editor-only deployment. |

The two secrets are mandatory in any non-dev deployment. In dev the service
falls back to permissive placeholders and logs a warning — never rely on that
in production.

---

## Embedding the editor in your app

Embedding is three steps: load the SDK, build a signed config, and construct
the editor into a placeholder element.

### 1. Load the SDK

```html
<script src="https://editor.internal/sdk/genoffice.js"></script>
```

This registers `window.PrismOfficeAPI` with a single constructor,
`DocEditor(placeholderId, config)`.

### 2. Build and sign the config

The config tells the iframe **which** document to open, **what** the user may
do, and **where** to send saves. Because it carries document/ callback URLs,
it must be signed with `PRISMOFFICE_BROWSER_SECRET` so a tampered token can't
redirect a save or point the editor at the wrong file.

```js
// server-side, in your host app (NEVER expose the secret to the browser)
import { signConfig } from '@genoffice/sdk-shared/jwt-sign-browser'

const config = {
  documentType: 'word',                       // 'word' | 'pdf'
  document: {
    key: 'doc-' + fileId,                     // opaque, stable per file version
    url: 'https://your-app.com/files/' + fileId + '.docx',
    fileType: 'docx',
    title: 'Report.docx',
  },
  editorConfig: {
    mode: 'edit',                             // 'edit' | 'view'
    callbackUrl: 'https://your-app.com/track', // save/status callbacks land here
    user: { id: userId, name: userName },
    customization: { autosave: true },
  },
  events: {                                   // optional initial event hooks
    onDocumentReady: () => {},
  },
}

const token = await signConfig(config, process.env.PRISMOFFICE_BROWSER_SECRET)
// hand `config` + `token` to the browser page that will host the iframe
```

### 3. Construct the editor

```html
<div id="placeholder"></div>
<script>
  const editor = new PrismOfficeAPI.DocEditor('placeholder', {
    ...config,
    token,                                    // the JWT from step 2
    events: {
      onDocumentReady: () => console.log('document loaded'),
      onDocumentStateChange: (e) => console.log('dirty:', e.data),
      onError: (e) => console.error('editor error', e.data),
    },
  })
</script>
```

The SDK inserts an iframe that loads the editor SPA from the service, hands it
the signed config over a postMessage handshake (origin-checked), and surfaces
events back to your page. When the user saves, the iframe POSTs the new bytes
to the service, which forwards them to your `callbackUrl`.

### The save callback

`callbackUrl` receives POSTs like:

```json
{ "status": "save", "key": "doc-123", "url": "https://editor.internal/saved/<id>" }
```

Your host app fetches the updated bytes from `url` (the request is signed with
`PRISMOFFICE_OUTBOX_SECRET`, which you verify), stores the file, and responds
`{ "error": 0 }`. Full status/callback details are in the
[API reference](apps/editor-service/docs/api-reference.md).

---

## Reference host (runnable example)

`apps/reference-host` is a minimal integrator that does all of the above —
signs a config, renders the host page, embeds the editor, and prints events.
Run it alongside the editor service to see a working integration end to end:

```bash
# terminal 1 — editor service
npx tsx apps/editor-service/src/server.ts     # :3000

# terminal 2 — reference host
npx tsx apps/reference-host/src/server.ts     # :3001

# open
open http://localhost:3001/
```

The reference host's `EDITOR_SERVICE_PORT` / `EDITOR_SERVICE_URL` env vars let
you point it at a remote editor service. Copy its server code as the starting
point for your own integration.

---

## Verification checklist

- [ ] `GET /health` returns `{"ok":true,...}`.
- [ ] `GET /sdk/genoffice.js` returns the SDK bundle (defines
      `window.PrismOfficeAPI`).
- [ ] A document opened through the reference host fires `onDocumentReady`.
- [ ] After editing, the save callback reaches your `callbackUrl` and the
      fetched bytes open cleanly in Microsoft Word / a PDF reader.
- [ ] `PRISMOFFICE_BROWSER_SECRET` and `PRISMOFFICE_OUTBOX_SECRET` are set to
      strong, stable values (not the dev placeholders) in production.

---

## Scaling and operations

- **Stateless.** The editor service holds a document only for the duration of
  a session, in memory. Any replica can serve any request — put as many as you
  like behind a load balancer. Sticky sessions are not required.
- **TLS.** Terminate HTTPS at your reverse proxy; the container serves HTTP.
- **CORS / framing.** The editor iframe is served from the editor service
  origin and communicates with your host page via `postMessage`, so your host
  app and the editor service can be on different origins. Make sure your
  content-security-policy allows the editor service origin to be framed.
- **AI (optional).** Set `PRISMOFFICE_GSK_KEY` only if you want the editor's AI
  features. Without it, the service is a pure editor with no outbound model
  calls.
