# GenOffice Editor Service v1 — Embeddable Document Editor (No Collaboration)

> **Scope:** An embeddable editor for `.docx` (byte-preserving) and `.pdf` (real text/image editing). Customer's host app embeds the editor via iframe + JS SDK; saves flow back via HTTP callback. No real-time collaboration — that's v2 (see `embeddable-editor-service.md`).

**Why this is much simpler than the v2 plan:**
- No Y.js websocket server, no per-document session registry, no live render broadcast.
- The editor service is **stateless** — a static host + thin proxy + JWT validator.
- All document state lives in the iframe: parse, edit, and save all happen client-side.
- The BlockTree↔Y.Doc invertibility risk (the critical risk in v2) **does not exist here**.

**Locked constraints (same as v2):**
1. Byte-preserving docx round trip ("Word never notices").
2. Real PDF text editing (pdfium content-stream rewrites with subset-embedded fonts).
3. Self-hosted product — Docker container in customer's infra.
4. Apache-2.0 (status quo license).

**Out (deferred to v2):**
- Real-time multi-user collaboration.
- Live presence/cursors.
- Collaborative annotations.

**Architecture leaves room for v2 collab** — adding it later means adding a websocket server and Y.js room per `<key>` to the editor service. The iframe SDK and contract don't change shape.

---

## 1. Architecture

```
┌────────────────────────────────────────────────────────────────────────┐
│ Customer's Host App (their app, their origin, their users)             │
│                                                                         │
│  • User accounts, file storage, permissions                            │
│  • GET  /files/:id/bytes     (document.url — returns docx/pdf bytes)   │
│  • POST /track               (callbackUrl — receives new bytes on save)│
│  • Loads <script src="https://editor.internal/sdk/genoffice.js">       │
│  • Calls new GenOfficeAPI.DocEditor("placeholder", {config, token})    │
│                                                                         │
│  ┌────────────────────────────────────────────────────────────────┐    │
│  │ <iframe src="https://editor.internal/editor/docs?...">         │    │
│  │                                                                │    │
│  │  Editor SPA (loaded once, cached):                             │    │
│  │   1. SDK postMessages config + JWT to iframe                   │    │
│  │   2. Iframe validates JWT                                     │    │
│  │   3. Iframe calls editor service: "give me bytes for this url"│     │
│  │      (server proxies document.url with outbox JWT)             │    │
│  │   4. Iframe parses with docx-engine (client-side)              │    │
│  │   5. Tiptap renders; user edits                                │    │
│  │   6. Save: docx-engine.patch → new bytes client-side           │    │
│  │   7. Iframe POSTs new bytes to editor service                  │    │
│  │   8. Editor service relays to host's callbackUrl               │    │
│  │                                                                │    │
│  │  PDF editor same shape, but parsing/editing happens in a      │     │
│  │  Web Worker (pdfium.wasm + hb-subset.wasm resident in worker) │     │
│  └────────────────────────────────────────────────────────────────┘    │
└──────────────────┬─────────────────────────────────────────────────────┘
                   │ HTTPS (iframe loads + proxy)
                   ▼
┌────────────────────────────────────────────────────────────────────────┐
│ GenOffice Editor Service  (Docker container, customer's infra)         │
│                                                                         │
│  nginx serving static assets:                                           │
│   /sdk/genoffice.js          (the JS SDK — ~15 KB)                     │
│   /editor/docs/*             (docs editor SPA bundle)                  │
│   /editor/pdf/*              (pdf editor SPA bundle)                   │
│   /wasm/pdfium.wasm          (~10 MB, cached by browser)               │
│   /wasm/hb-subset.wasm       (~1 MB, cached)                           │
│   /fonts/*                   (bundled Carlito/Caladea/Liberation/Noto) │
│                                                                         │
│  Node.js process (Hono, ~300 LOC) — the proxy layer:                   │
│   POST /fetch-document       (iframe → server fetches document.url,    │
│                                returns bytes; JWT-validated)           │
│   POST /save-document        (iframe → server relays new bytes to      │
│                                host's callbackUrl with outbox JWT)     │
│   /ai/*  (optional)          (proxy to Genspark with operator's key)   │
│   GET  /health, /metrics                                               │
│                                                                         │
│  Config:                                                               │
│   GENOFFICE_BROWSER_SECRET  (signs iframe config)                       │
│   GENOFFICE_OUTBOX_SECRET   (signs server→host requests)                │
│   GENOFFICE_INBOX_SECRET    (validates host→server requests, if used)   │
│   GENOFFICE_GSK_KEY  (optional, for /ai/* proxy)                        │
│                                                                         │
│  No session state. No websocket server. Stateless & horizontally       │
│  scalable — put N replicas behind nginx with no special routing.       │
└────────────────────────────────────────────────────────────────────────┘
```

### Why this shape

- **Stateless editor service** = trivial ops. Customer runs one container; can run ten if they like; nginx load-balances with no shardkey/stickiness needed. No in-memory docs to lose on restart.
- **All editing client-side** = no server CPU on the hot path. Editor service bandwidth is the only cost. Customer can size the container small.
- **Thin proxy for `document.url`** = customer doesn't need to configure CORS on their host. Editor service fetches server-side and returns bytes to the iframe.
- **PDF in iframe Web Worker** = matches the SaaS plan's pattern; pdfium.wasm cached by browser after first load. (Server-side pdfium in Worker Threads is a v1.1 optimization if client perf is bad on low-end devices.)
- **JWT validation in the iframe** = the editor service can be configured to refuse serving the editor SPA without a valid token, locking it to authorized integrators.

---

## 2. SDK contract (subset of ONLYOFFICE, no collab fields)

Source of truth for shape: `.omo/plans/reference-onlyoffice-api.md`. Below is the **v1 subset** — fields and events we actually support. Anything not listed is rejected or ignored.

### 2.1 SDK loading & constructor

```html
<script src="https://editor.internal/sdk/genoffice.js"></script>
```
```js
const editor = new GenOfficeAPI.DocEditor("placeholder", {
  document: { /* §2.2 */ },
  editorConfig: { /* §2.3 */ },
  events: { /* §2.5 */ },
  token: "<jwt>",                 // HS256 with browser secret, payload = entire config
  type: "desktop",                // "desktop" | "embedded" (mobile accepted but same UI)
  documentType: "word",           // "word" | "pdf"
})
```
- `placeholder` is the **id** of a DOM element the SDK replaces with the iframe (matches ONLYOFFICE).
- Required: `document.url`, `document.fileType` OR `documentType`, `document.key`.

### 2.2 `document`

```js
document: {
  fileType: "docx",                    // "docx" | "pdf"
  key:     "<uuid-or-hash>",           // version identifier; see §2.6
  title:   "Q3 Report.docx",
  url:     "https://host/files/abc",   // server-side fetch via editor service proxy
  permissions: { /* §2.7 */ },
  info:    { owner: "Alice", folder: "Reports", uploaded: "2026-..." },
}
```

### 2.3 `editorConfig`

```js
editorConfig: {
  mode:        "edit",                 // "edit" | "view"
  lang:        "en",                   // ISO-639-1
  callbackUrl: "https://host/track",   // REQUIRED for save
  user: { id: "u1", name: "Alice", image: "https://..." },
  customization: {
    autosave: true, forcesave: false,
    logo: { /* branding */ },
    goback: { url: "https://host/files", text: "Back to files" },
    ai: { enabled: true, sidebar: true, model: "claude-sonnet" },
  },
}
```

**Dropped from ONLYOFFICE:** `coEditing`, `user.group`, `region`, `templates`, `recent`, all the deprecated URL fields (`saveAsUrl`, `fileChoiceUrl`, etc.) — replaced by events.

### 2.4 Callback protocol (identical to ONLYOFFICE, status subset)

Editor service POSTs to host's `callbackUrl`. Host replies `{"error": 0}`.

| status | v1 fires? | Meaning |
|---|---|---|
| 1 | no | being edited (collab-only — drop) |
| **2** | **yes** | ready for saving — iframe produced new bytes; `url` is on the editor service |
| 3 | yes | save error |
| 4 | yes | closed with no changes |
| 6 | yes | forcesave (explicit save while iframe still open) |
| 7 | yes | forcesave error |

So v1 callback body shape:
```json
{
  "key":     "<document.key>",
  "status":  2,
  "url":     "https://editor.internal/saved/<temp-id>",
  "filetype": "docx",
  "users":   ["u1"]
}
```
Host GETs the `url` (with outbox JWT in `Authorization`), persists bytes, replies `{"error": 0}`.

Forcesave (status 6) fires when the iframe calls `editor forcesave` or when the user clicks Save (if `customization.forcesave: true`).

### 2.5 Events (v1 subset)

| Event | Fires |
|---|---|
| `onAppReady` | iframe loaded (no doc yet) |
| `onDocumentReady` | doc parsed, editor rendered |
| `onError` | `{errorCode, errorDescription}` |
| `onWarning` | non-fatal |
| `onDocumentStateChange` | `{data: boolean}` — dirty/clean state, for "unsaved changes" warnings |
| `onRequestEditRights` | user wants to switch view → edit; host re-inits with `mode:"edit"` |
| `onRequestSaveAs` | user picked Save As; host provides new file identity |
| `onRequestRename` | user typed a new title |
| `onRequestClose` | user clicked ✕; host can navigate away |
| `onRequestHistory` → `refreshHistory(...)` | version history open (paired method) |
| `onRequestHistoryData` → `setHistoryData(...)` | user picked a version |
| `onRequestHistoryClose` | history panel closed |
| `onRequestInsertImage` → `insertImage(...)` | user picked insert-image |
| `onOutdatedVersion` / `onRequestRefreshFile` | opened stale key after save |
| `onDownloadAs` | in response to `editor.downloadAs()` |
| `onMetaChange` | `{title, favorite}` changed |

**Dropped (collab-related):** `onCollaborativeChanges`, `onRequestUsers`, `onRequestSendNotify`, `onMakeActionLink`, presence events.

### 2.6 `document.key` rules (subset)

Same as ONLYOFFICE:
1. Generate a **new key on every save.** After status-2 with `{"error":0}`, old key is stale.
2. Charset `0-9 a-z A-Z -._=`, max 128.
3. Globally unique across all customers sharing an editor service deployment.

**Without collab, the key has a simpler role:** it's purely a save-correlation identifier (which save goes with which open). The cache-room-identity role disappears. But the API contract is identical, so adding collab in v2 doesn't change the rules customers code against.

### 2.7 Permissions (v1)

```js
permissions: {
  edit: true, download: true, print: true, copy: true,
  review: true, comment: true, fillForms: true,
  aiEdit: true,   // GenOffice-specific
}
```
Dropped: `modifyFilter`, `modifyContentControl`, `commentGroups`, `reviewGroups`, `userInfoGroups`, `chat`, `protect`. Add `aiEdit` (controls AI panel visibility).

### 2.8 JWT

Two secrets in v1 (not three — no host→server command requests in scope):
- `GENOFFICE_BROWSER_SECRET` — signs iframe config (browser → editor service).
- `GENOFFICE_OUTBOX_SECRET` — signs editor-service → host requests (proxy of `document.url`, save callbacks).

`INBOX_SECRET` exists in config but is unused in v1 (no `/command` route yet). Enable when v2 adds it.

Same HS256 + payload-is-the-config shape as ONLYOFFICE. Same `Authorization: Bearer <jwt>` header pattern for server→host requests.

---

## 3. Editor internals

### 3.1 Docs editor (`.docx`)

The iframe SPA is built from `apps/docs/src/renderer/` with `window.desktop` replaced by an injected `EditorServiceClient`. The mapping is mechanical — the typed `DesktopApi` interface stays, only the implementation swaps.

**Session flow inside the iframe:**
1. SDK postMessages `{config, token}` to the iframe on init.
2. Iframe validates JWT (HS256 with browser secret baked into the SPA bundle).
3. Iframe calls `POST /fetch-document` with the config; editor service validates JWT server-side, fetches `document.url` with outbox JWT in `Authorization`, returns bytes.
4. Iframe parses bytes with `docx-engine` (pure TS, runs in browser):
   - `parse(bytes) → { blockTree, originalBytes, originalHash }`
   - Block tree drives Tiptap; `originalBytes` retained in iframe memory for the patch step.
5. User edits via Tiptap; dirty-block tracking same as desktop.
6. Save flow:
   - `docx-engine.patch({ originalBytes, dirtyBlocks }) → newBytes` (byte-preserving — same code path as desktop).
   - Iframe POSTs `newBytes` to `POST /save-document`; editor service holds bytes at a temp URL.
   - Editor service POSTs `{key, status:2, url, filetype}` to host's `callbackUrl`.
   - Host GETs the temp URL, persists, replies `{"error":0}`.
7. Iframe fires `onDocumentStateChange(false)` (clean) and waits for next edit.

**Byte-preservation guarantee: identical to the desktop app.** Same `docx-engine` code, same `originalBytes` reference, same patch flow. The renderer doesn't know whether it's running in Electron or in an iframe.

### 3.2 PDF editor (`.pdf`)

Same shape, but parsing/editing happens in a Web Worker inside the iframe (not in the iframe's main thread):

**Web Worker (`pdf.worker.js`):**
- Loads pdfium.wasm + hb-subset.wasm via `fetch().arrayBuffer()` (cached in Cache API on first load).
- Loads bundled font catalog (Carlito/Caladea/Liberation/Noto CJK from `/fonts/`).
- Optionally enumerates local fonts via `navigator.fonts.query()` (Chromium only).
- Holds the pdfium document resident for the session.
- Accepts `postMessage` ops: `loadDocument(bytes)`, `applyTextEdit(op)`, `applyImageEdit(op)`, `renderPage(pageNum, scale) → ArrayBuffer`, `validateEdits`, `extractPages`, `insertPdf`, `save() → bytes`.

**Iframe main thread:**
- Renders pages from worker-returned bitmaps to `<canvas>` (matches existing pdf.js viewer pattern).
- Routes user edit gestures → ops to the worker.
- On save: worker produces new bytes → iframe POSTs to editor service → callback to host.

**What moves where:**
- `apps/pdf/src/main/text-edit.ts` → `apps/pdf/src/renderer-worker/text-edit.ts` (mechanical move; `readFileSync` → `fetch`).
- Same for `image-edit.ts`, `font-subset.ts`, `font-locate.ts` (the latter scans `/fonts/` instead of OS dirs), `wasm-path.ts` (uses `/wasm/pdfium.wasm` URL).

### 3.3 Save flow detail (both editors)

```
iframe (client)                editor service (server)         host app
     │                                │                            │
     │  POST /save-document           │                            │
     │  { key, bytes }                │                            │
     ├───────────────────────────────►│                            │
     │                                │  store bytes at temp URL   │
     │                                │  POST /track               │
     │                                │  { key, status:2, url }    │
     │                                ├───────────────────────────►│
     │                                │                            │ persist
     │                                │  GET <url>                 │
     │                                │◄───────────────────────────│
     │                                │  return bytes              │
     │                                │                            │
     │                                │  {"error": 0}              │
     │                                │◄───────────────────────────│
     │  200 OK                        │                            │
     │◄───────────────────────────────│                            │
     │                                │                            │
     │  fire onDocumentStateChange(false)                          │
```

Editor service holds the temp URL for ~60 s after the callback fires (configurable), then GCs it.

---

## 4. Editor service components

```
apps/editor-service/                          ~800 LOC (was ~3500 in v2)
  src/
    server/
      index.ts                               Hono app
      routes/
        fetch-document.ts                    POST /fetch-document
        save-document.ts                     POST /save-document (returns temp URL)
        track-callback.ts                    POST to host callbackUrl with outbox JWT
        ai-proxy.ts                          optional /ai/* routes
        health.ts                            GET /health, /metrics
      jwt/
        sign.ts                              HS256 sign (2 active secrets)
        verify.ts                            verify middleware
      storage/
        temp-store.ts                        in-memory temp URL store (60s TTL)
    static/                                  built SPAs + wasm + fonts land here
    Dockerfile
    nginx.conf
    docker-compose.yml
  package.json
```

**Not present in v1 (deferred to v2):**
- WebSocket server
- Session registry (`Map<key, Session>`)
- Y.js room service
- PDF lock manager
- Server-side pdfium worker (we use client-side Web Worker instead)
- `/command` route (no forcesave-by-server, meta, etc. — host does these via re-init)
- `/converter` route (we ship native `.docx`/`.pdf` only)

**Static asset sizes (after Vite build, approximate):**
- `genoffice.js` SDK: ~15 KB gzipped
- docs editor SPA: ~700 KB gzipped (Tiptap + docx-engine + React)
- pdf editor SPA: ~1.5 MB gzipped (pdf.js + worker code)
- pdfium.wasm: ~10 MB (cached, fetched once)
- hb-subset.wasm: ~1 MB (cached)
- fonts: ~30 MB (mostly Noto CJK subsets; cached)

Total first-load for docs: ~700 KB. For pdf: ~12 MB (cached afterward).

---

## 5. Reference host app

Same scope as v2's reference host, minus collab UI:
- File upload + list + delete (in `./data/files/`).
- Mock user picker (single user in v1; multi-user picker still useful to demo different permission sets).
- JWT signing example (browser secret).
- `POST /track` callback handler — GETs the temp URL, persists bytes, records version, replies `{"error":0}`.
- `GET /files/:id/bytes` — `document.url` endpoint.
- Editor embed via SDK.
- Version history UI.
- Read-only embed example (`mode:"view"` + `permissions:{edit:false}`).
- Embedded viewer example (`type:"embedded"`).
- Integrator guide markdown: config schema, callback protocol, JWT, permissions, events, signing examples in JS/Python/Go.

---

## 6. Work breakdown (phased)

**Total: ~7 weeks** for one engineer. Each phase ends in a demoable state.

### Phase 0 — Spikes & workspace setup (0.5 week)
- [ ] Spike: iframe + postMessage SDK scaffold — minimal `GenOfficeAPI.DocEditor` that injects an iframe, sends config, receives `onDocumentReady`. (The Y.js spike from v2 is GONE.)
- [ ] Spike: pdfium in browser Web Worker with `WebAssembly.instantiate(fetch(url).arrayBuffer())`. Validate text-edit produces byte-identical output to the desktop app.
- [ ] Create `apps/editor-service/`, `apps/reference-host/`, `packages/editor-contract/`, `packages/sdk-shared/`.
- [ ] Confirm desktop build (`apps/shell`) still compiles.
- **Exit:** SDK injects iframe and gets `onDocumentReady`; pdfium-in-Worker spike passes byte-identity test.

### Phase 1 — Editor service skeleton + SDK (1 week)
- [ ] Hono server: static serving for SDK + (placeholder) editor SPAs + wasm + fonts.
- [ ] JWT module: HS256 sign/verify, browser/outbox secrets from config, validation middleware.
- [ ] `GenOfficeAPI.DocEditor` SDK: full method set (`downloadAs`, `insertImage`, `refreshHistory`, `setHistoryData`, `setActionLink`, `refreshFile`, `requestEditRights`, `destroyEditor`), postMessage protocol, event dispatch.
- [ ] `POST /fetch-document` route (validates browser JWT, fetches `document.url` with outbox JWT, returns bytes).
- [ ] `POST /save-document` route (receives bytes, stores at temp URL, calls host callback, returns 200).
- [ ] Dockerfile + `docker-compose.yml` (editor service + reference host side-by-side).
- **Exit:** reference host embeds the SDK, gets an editor iframe loaded with valid JWT, iframe fetches a placeholder doc, posts a save, host receives the callback. No real editing yet.

### Phase 2 — Docs editor wired in (1.5 weeks)
- [ ] `/editor/docs` SPA: built from `apps/docs/src/renderer/`, with `window.desktop` replaced by `EditorServiceClient` (injected implementation of the existing `DesktopApi` interface).
- [ ] `EditorServiceClient.docs.*`: `fetchDocument`, `save`, `saveAs`, `pickImage` (FSAccess API inside iframe), `print` (`window.print`), `exportPdf` (client-side render), file attachment helpers.
- [ ] Save flow end-to-end: Tiptap dirty tracking → `docx-engine.patch` → POST → callback → host persists.
- [ ] **Byte-preservation regression test**: open fixture `.docx`, edit one paragraph, save, download, diff against original — only touched paragraph bytes differ.
- [ ] Recovery: IndexedDB autosave every 30 s; on iframe reload, offer recovery.
- [ ] Renderer feature parity: print, export-pdf, image insert.
- **Exit:** a single user opens a docx in the reference host, edits, saves, downloads — byte-preserved.

### Phase 3 — PDF editor wired in (2 weeks)
- [ ] `/editor/pdf` SPA: built from `apps/pdf/src/renderer/`, with `window.pdfApi` replaced by `EditorServiceClient.pdf.*`.
- [ ] PDF Web Worker: move `apps/pdf/src/main/{text-edit,image-edit,font-subset,font-locate,wasm-path}.ts` into `apps/pdf/src/renderer-worker/`. Adapt: `readFileSync` → `fetch().arrayBuffer()`, OS font dirs → bundled `/fonts/` catalog + `navigator.fonts.query()` + (optional) operator-configured font dir mounted into container.
- [ ] Bundled font catalog (port `apps/docs/src/renderer/fonts/` to a shared location).
- [ ] Save flow: worker produces bytes → iframe POSTs → callback.
- [ ] **Real-edit regression test**: open a PDF with embedded subset font, retype a run, save, open in Acrobat — content stream rewritten correctly, font subset embedded.
- [ ] Image edit, page extract, page insert.
- **Exit:** a single user opens a PDF in the reference host, edits text/image, extracts/inserts pages, saves — Acrobat-valid.

### Phase 4 — AI panel (0.5 week)
- [ ] Editor service `/ai/*` routes: `chat`, `stream` (SSE), `web-search`, `image-search`, `fetch-image`, `generate-image` (PDF).
- [ ] Operator configures `GENOFFICE_GSK_KEY`. Editor service proxies to Genspark HTTPS.
- [ ] SSRF guard ported from `packages/electron-utils/src/safe-remote-url.ts` to server middleware.
- [ ] Iframe AI client routes through editor service (browser never calls Genspark directly).
- **Exit:** AI panel works in both editors; block-level AI edits in docx flow through the normal save path.

### Phase 5 — Reference host app polish (0.5 week)
- [ ] File list with thumbnails (rendered by editor service `/preview/:fileType?url=...` route).
- [ ] User picker (single user; demo different permission presets).
- [ ] Version history UI from `/track` callback history.
- [ ] Read-only embed example.
- [ ] Embedded viewer example (`type:"embedded"`).
- [ ] JWT signing examples in JS/Python/Go in `docs/integrator-guide.md`.
- [ ] Integrator guide: config schema, callback protocol, JWT, permissions, events, common patterns.
- **Exit:** a new integrator can read the guide + reference host and have a working embed in their app within a day.

### Phase 6 — Polish & GA (1 week)
- [ ] Theming: light/dark/system via `data-theme` + CSS tokens (existing `packages/ui`).
- [ ] i18n: `packages/i18n` initializes from `editorConfig.lang`.
- [ ] Print stylesheet pass.
- [ ] Permissions enforcement matrix tests (every `permissions.*` flag verified end-to-end).
- [ ] Health check + Prometheus metrics.
- [ ] E2E Playwright suite: open docx → edit → save → byte-diff; open pdf → edit → save → Acrobat-valid; permissions; events.
- [ ] Docker image published; semantic versioning; upgrade guide.
- **Exit:** shippable v1.

---

## 7. File-level change inventory

### New apps/packages
```
apps/editor-service/                  ~800 LOC
  src/server/                         Hono app, JWT, fetch/save proxy, AI proxy
  static/                             built SPAs + wasm + fonts land here
  Dockerfile, nginx.conf, docker-compose.yml
  package.json

apps/reference-host/                  ~1000 LOC
  src/server/                         Express/Hono with /track, /files/:id/bytes, JWT signing
  src/client/                         React UI (file list, embed)
  data/files/                         (gitignored)
  package.json

packages/editor-contract/             ~400 LOC
  src/                                Config, Document, EditorConfig, Events, Permissions types
  package.json

packages/sdk-shared/                  ~250 LOC
  src/sdk.ts                          GenOfficeAPI.DocEditor implementation
  src/postmessage-protocol.ts         iframe↔host message types
  src/jwt-sign-browser.ts             config JWT signing helper
  package.json
```

### Modified files
- `apps/docs/src/renderer/**` — replace `window.desktop` with `getEditorApi()` factory. Mechanical change once `DesktopApi` interface is in `packages/editor-contract/`.
- `apps/pdf/src/renderer/**` — replace `window.pdfApi` with `getPdfApi()` factory.
- `apps/pdf/src/main/{text-edit,image-edit,font-subset,font-locate,wasm-path}.ts` → **moved** to `apps/pdf/src/renderer-worker/` with `fs` → `fetch` adaptations. Desktop main-process keeps its own copy (or imports from a shared worker package — TBD in Phase 3).
- `apps/docs/src/main/docs-main.ts`, `apps/pdf/src/main/pdf-main.ts` — **unchanged**. Desktop code path stays.
- `packages/docx-engine/`, `packages/pptx-engine/`, `packages/pptx-render/`, `packages/agent-core/`, `packages/ai-provider/`, `packages/i18n/`, `packages/ui/`, `packages/electron-utils/`, `packages/file-parse/` — **untouched**.
- `tsconfig.base.json` — path aliases for new packages.
- Root `package.json` — workspace scripts.

### Deleted files
None. Desktop code stays alive.

---

## 8. Risks & mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| **PDF font coverage gap** (customer's PDFs use fonts the bundled catalog + Local Font Access + operator dir don't cover) | Medium | Three-tier strategy (§3.2). Operator font dir is the practical answer for self-hosted. Phase 0 spike measures catalog coverage against a real-PDF corpus. |
| **pdfium Web Worker perf** on low-end client devices (large PDFs) | Medium | Worker holds doc resident (matches desktop). Stream pages on demand, don't load all at once. Phase 3 profiles against 200+ page PDFs. Server-side pdfium is a v1.1 escape hatch if needed. |
| **iframe first-load size** (pdf editor ~12 MB with pdfium + fonts) | Low-Medium | All cacheable (Cache API). First load is slow on bad connections; subsequent loads are fast. Self-hosted inside corporate LAN — bandwidth rarely a concern. |
| **Byte-preservation regression** (someone refactors docx-engine's `patch.ts`) | High | CI regression test in Phase 2: open fixture corpus, edit, save, byte-diff. Same test runs in desktop CI too. |
| **Cross-origin restrictions** (iframe can't read certain host responses) | Low | Editor service proxies `document.url` server-side; host doesn't need to send CORS. |
| **Customer misconfigures JWT secrets** → silent auth failures | Medium | Startup config validation (fail fast with clear error); `/health` returns secret-config status; reference host has working signing example to copy. |
| **Editor service temp URL GC** loses bytes before host fetches | Low | 60s TTL is configurable; if host is slow, increase. Track delivery failures in metrics. |
| **AI proxy costs** (operator's Genspark key used by all users) | Low | Optional per-customer rate limits in v1.1. |

**Notable: the v2 critical risk is GONE.** "BlockTree↔Y.Doc round-trip invertibility" doesn't exist in v1 — there's no Y.Doc. We're just running the desktop editor's flow inside an iframe. The single biggest technical risk in the v2 plan is simply not present here.

---

## 9. Path to v2 (collaboration)

The v1 architecture leaves clean room for v2 collab. Adding it means:

1. **Add a websocket server** to the editor service (new route `/coauthoring/*`).
2. **Add a session registry** (`Map<documentKey, Session>`) holding Y.Doc for docx, lock state for pdf.
3. **Move docx parsing from iframe to server**: editor service fetches `document.url` server-side, parses via docx-engine, builds the Y.Doc, syncs to iframes via y-websocket. The iframe's Tiptap edits become Y.js ops.
4. **Move pdfium from iframe Web Worker to server-side Worker Threads** (so multiple clients see the same doc state).
5. **Add the third JWT secret** (`INBOX_SECRET`) for the new `/command` route.
6. **SDK additions**: `coEditing` config field; collab events (`onCollaborativeChanges`, presence).

**What does NOT change for integrators:** the constructor, config shape, callback protocol, event names, JWT signing, permissions model. Customers who integrated against v1 add `coEditing: {mode:"fast"}` and get collab in v2 — no re-integration.

The v2 plan at `.omo/plans/embeddable-editor-service.md` is the design doc for this evolution.

---

## 10. Open questions

1. **Naming** — recommend "GenOffice Docs" (mirrors ONLYOFFICE Docs). Decidable in Phase 5 before public release. Doesn't gate engineering.
2. **Operator AI keys** — recommend operator-provided in v1 (`GENOFFICE_GSK_KEY`), per-user in v1.1. Doesn't gate engineering.
3. **CI / release pipeline** — standard (GitHub Actions, cosign-signed images, semver). Engineering setup task, not a decision.

That's it. v1 has minimal open questions because the scope is minimal.

---

## 11. Spike work to de-risk before Phase 1

Two one-day spikes (the third from v2 — Y.js — is gone):

1. **SDK + iframe + postMessage spike**: minimal `GenOfficeAPI.DocEditor` that creates an iframe at the editor service origin, postMessages a config, iframe acks with `onDocumentReady`. JWT validation passes. **Exit:** two-way postMessage works cross-origin; signing/verifying works.
2. **pdfium in browser Web Worker spike**: load pdfium.wasm in a Worker via `fetch().arrayBuffer()`, open a fixture PDF, apply a text edit, save bytes. Compare bytes to a desktop save of the same edit. **Exit:** byte-identical output.

Run both in parallel during Phase 0.

---

## 12. Success criteria

The migration is done when:

- A customer can `docker pull genoffice/editor-service:v1` and `docker run -p 443:443 -v ./config:/etc/genoffice genoffice/editor-service:v1` and have a working editor service.
- The reference host app (`apps/reference-host`) embeds the editor, lists files, opens a docx in edit mode, edits, saves, downloads — byte-preservation regression test passes against a fixture corpus.
- The same flow works for PDF: open, edit text, edit image, extract/insert pages, save → Acrobat-valid PDF.
- An integrator following `docs/integrator-guide.md` can embed the editor in their own app in under a day: sign valid JWTs, handle the callback protocol, get a working docx/pdf editor.
- The desktop Electron build (`apps/shell`) still builds and runs unchanged.
- Both Phase 0 spikes pass and are checked in as living tests.
- E2E Playwright suite covers: sign-config, open-docx, edit, save, byte-diff; open-pdf, edit, save, Acrobat-valid; permissions enforcement; events API.

Not required for v1 "done": real-time collaboration, WOPI protocol, sheets/slides/markdown editors, mobile-optimized UI, server-side pdfium.
