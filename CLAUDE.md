# CLAUDE.md

Guidance for AI agents and human contributors working in this repo.

## What this is

PrismOffice is a **self-hosted, embeddable document editor for the web**. An
integrator deploys the editor service in their own infrastructure, then embeds
it in their app via an `<iframe>` plus a small JavaScript SDK. Users open and
edit `.docx` and `.pdf` documents in the browser; the file never has to leave
the integrator's environment.

It is built on a byte-preserving OOXML editing engine (only the paragraphs you
touched are regenerated; everything else is kept byte-for-byte) and pdfium-based
real PDF editing, packaged as a stateless service you self-host and script from
the host page.

## Architecture

```
host app                  PrismOffice editor service            browser
─────────────             ──────────────────────────            ───────
<div id="editor">   ─┐
<script             │  loads /sdk/prismoffice.js        ┐
 src="/sdk/...js">   │                                   │
                     │  new PrismOfficeAPI.DocEditor(    │  iframe loads
                     │       'editor', signedConfig)     ├─► /editor/word/  (docs SPA)
                     │           │                        │  /editor/pdf/   (pdf SPA)
                     │           ▼                        │
                     │  iframe + postMessage handshake   │
                     │  (origin-checked, JWT-verified)   │
                     │           │                        │
 callbackUrl ◄───────┴──── /track (save / status) ───────┘
```

Pieces in this repo:

- `apps/editor-service` — the stateless [Hono](https://hono.dev/) server you deploy. Serves the SDK bundle, the editor SPAs, proxies document fetch/save between the iframe and the host app, and signs/verifies JWT config. Horizontally scalable.
- `packages/sdk-shared` — the JavaScript SDK (`PrismOfficeAPI.DocEditor`). Loaded from the editor service via a `<script>` tag; manages the iframe, origin-checks messages, exposes events and methods to the host page.
- `packages/editor-contract` — the typed config / event / callback contract shared by the SDK, service, and editor SPAs. **Source of truth** for those shapes.
- `apps/reference-host` — a minimal reference integrator (a Hono app that signs a config and embeds the editor). Copy this pattern; it is documentation-as-code.
- `apps/docs`, `apps/pdf` — the editor SPAs (the word processor and PDF editor), built as web bundles and served by the editor service at `/editor/word/` and `/editor/pdf/`.

## Security model (load-bearing — read before touching config/iframe code)

- The editor config (document URL, callback URL, permissions, user) is **JWT-signed (HS256)** with `PRISMOFFICE_BROWSER_SECRET`. The iframe honors a config only if its signature verifies, so a tampered or stolen token cannot redirect a save or point the editor at a file the user should not reach.
- **Two independent secrets:** `PRISMOFFICE_BROWSER_SECRET` signs the config the iframe accepts; `PRISMOFFICE_OUTBOX_SECRET` signs the server-to-server document-fetch and saved-bytes URLs (`Authorization: Bearer <jwt>`).
- The SDK ↔ iframe `postMessage` handshake is **origin-checked** on both sides.
- The signed config travels by `postMessage` after the iframe signals `app-ready` — **never in the iframe URL** — so it does not leak into Referer headers or browser history.
- The service is **stateless**: it fetches the document from the integrator's URL, streams it to the iframe, and POSTs saves back to the `callbackUrl`. It stores nothing and holds a document only briefly in memory per session.

Never weaken the JWT verification, the origin checks, or add a code path that accepts an unsigned config.

## Build & dev

```bash
npm install

# SDK bundle → apps/editor-service/static/sdk/prismoffice.js
npm run build:sdk -w @prismoffice/editor-service

# Editor SPA bundles → apps/editor-service/static/editor/{word,pdf}/
npm run build:web -w @prismoffice/docs
npm run build:web -w @prismoffice/pdf

# Run the editor service (port 3000) + reference host (port 3001)
npx tsx apps/editor-service/src/server.ts &
npx tsx apps/reference-host/src/server.ts

npm run typecheck    # tsc --noEmit across every workspace
npm test             # engine + service unit tests
```

The web renderers are Vite builds that output directly into the editor service's static directory. After changing renderer source, rebuild the affected app; after changing SDK source, rebuild the SDK bundle.

## Conventions

- TypeScript everywhere; no new `any` surfaces where a precise type is cheap. The contract in `packages/editor-contract` is the source of truth for config/event/callback shapes.
- English only in code, comments, commit messages, and docs.
- File-format fidelity is the core promise: for `.docx` open/save changes, include a round-trip test proving untouched content survives byte-for-byte.
- The docx editor uses Tiptap/ProseMirror; PDF editing goes through pdfium (wasm). Document content is data and must round-trip identically regardless of editor chrome state.
- Keep files focused; prefer a new module over enlarging an already-large one.
