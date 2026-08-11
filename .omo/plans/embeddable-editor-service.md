# GenOffice Editor Service — Full Vision (v2 with Collaboration)

> **Scope:** This is the **v2 full-vision** plan with real-time collaboration. For the immediate v1 (no collab, just embeddable editing), see `editor-service-v1.md` — that's what we ship first. This document is the evolution path: collab is added in v2 by re-adding the pieces stripped out of v1.

> **Status:** This v2 plan was reviewed and approved by Momus but is **not the immediate execution target**. v1 is.

**Scope:** An embeddable editor service for `.docx` (byte-preserving) and `.pdf` (real text/image editing via pdfium), with real-time collaboration.

**Locked constraints:**
1. **Byte-preserving docx round trip** ("Word never notices") — non-negotiable.
2. **Real PDF text editing** — pdfium content-stream rewrites with subset-embedded fonts.
3. **Self-hosted product** — Docker container, deployed in customer's infra, like ONLYOFFICE Docs.
4. **Real-time collaboration is the point** — multi-user co-editing.

**Constraint traded away (explicitly):**
- **Offline-capable.** ONLYOFFICE-style cross-origin iframe embedding + service worker + collaboration model don't compose. Real-time collab is inherently online. The editor service is **online-only**. (If a customer needs offline, the desktop Electron app remains a separate product.)

**Additional constraints (recommended, baked in):**
- **Single codebase, two products.** The desktop Electron apps (`apps/shell`) and the new editor service share engine packages. Both stay alive.
- **Engine packages untouched.** `docx-engine`, `pptx-engine`, `pptx-render`, `agent-core`, `ai-provider`, `i18n`, `ui` don't change.
- **Mirror the ONLYOFFICE contract where integrators expect it.** SDK shape (`GenOfficeAPI.DocEditor(placeholder, config)`), config object, callback handler protocol, JWT scheme, event names. Diverge only where GenOffice's specifics (byte-preservation, AI panel) require it. Source of truth for the contract: `.omo/plans/reference-onlyoffice-api.md`.

---

## 1. Architecture

```
┌────────────────────────────────────────────────────────────────────────┐
│ Customer's Host App (their app, their origin, their users)             │
│                                                                         │
│  • User accounts, file storage, permissions, version history DB        │
│  • Implements POST /track           (the callbackUrl webhook)          │
│  • Implements GET  /files/:id/bytes (the document.url fetch)           │
│  • Loads <script src="https://editor.internal/sdk/genoffice.js">       │
│  • Calls new GenOfficeAPI.DocEditor("placeholder", {config, token})    │
│                                                                         │
│  ┌─────────────────────────────────────────────────────┐               │
│  │ <iframe src="https://editor.internal/editor/...">   │               │
│  │   editor SPA loaded, postMessage config             │               │
│  └─────────────────────────────────────────────────────┘               │
└──────────────────┬─────────────────────────────────────────────────────┘
                   │ cross-origin; JWT-signed config
                   ▼
┌────────────────────────────────────────────────────────────────────────┐
│ GenOffice Editor Service  (Docker container, customer's infra)         │
│                                                                         │
│  nginx ────┬────────────────────────────────────────────────────────┐  │
│            │ Node.js process                                          │  │
│            │                                                          │  │
│            │  HTTP routes:                                            │  │
│            │   GET  /sdk/genoffice.js         (the JS SDK)            │  │
│            │   GET  /editor/docs              (docs editor SPA)       │  │
│            │   GET  /editor/pdf               (pdf editor SPA)        │  │
│            │   POST /coauthoring/*            (Y.js ws upgrade path)  │  │
│            │   POST /command                  (host→DS control)       │  │
│            │   POST /converter                (format conversion)     │  │
│            │                                                          │  │
│            │  WebSocket server (the collaboration hub):               │  │
│            │   • Y.js rooms for docx (one room per document.key)      │  │
│            │   • PDF session manager (one per document.key)           │  │
│            │   • Presence, cursors, viewport sync                     │  │
│            │                                                          │  │
│            │  JWT validation (HS256 × 3 secrets: browser/inbox/outbox)│ │
│            │                                                          │  │
│            │  Per-document in-memory state:                           │  │
│            │   docx: Y.js doc + original docx bytes (for patch save)  │  │
│            │   pdf:  pdfium worker handle + edit lock owner           │  │
│            │                                                          │  │
│            │  PDF worker (in-process, Worker Threads):                │  │
│            │   • pdfium.wasm + hb-subset.wasm                         │  │
│            │   • Loads document.url bytes on session open             │  │
│            │   • Applies text/image edit ops                          │  │
│            │   • Renders page previews (PNG/WEBP) to broadcast        │  │
│            │                                                          │  │
│            │  Save assembler (called on session close / forcesave):   │  │
│            │   docx: Y.js doc → block tree → docx-engine patch        │  │
│            │         → splice into original bytes → upload via url    │  │
│            │   pdf:  pdfium writes new content stream → upload        │  │
│            │                                                          │  │
│            │  AI proxy (optional, configurable):                      │  │
│            │   /ai/* routes → Genspark HTTPS with operator's gsk key  │  │
│            │                                                          │  │
│            │  Config (env / local.json):                              │  │
│            │   GENOFFICE_BROWSER_SECRET, INBOX_SECRET, OUTBOX_SECRET  │  │
│            │   GENOFFICE_GSK_KEY (optional, for AI proxy)             │  │
│            │   GENOFFICE_STORAGE_DIR (cached conversions)             │  │
└────────────────────────────────────────────────────────────────────────┘

Reference Host App  (separate example repo / apps/reference-host):
  Vite + React + minimal Express backend
   • File upload/list/delete
   • Mock user list with avatars
   • POST /track callback handler (downloads url, persists bytes, records version)
   • GET /files/:id/bytes  (document.url endpoint)
   • JWT signing example (browser secret)
   • Embeds the editor via the SDK
```

### Why these picks

- **Node.js + Hono** for the editor service: matches the existing codebase; Hono is types-first and minimal.
- **Y.js + y-websocket** for docx collaboration: Tiptap already supports Y.js (`y-prosemirror`); CRDT model handles concurrent edits without operational transform; library is battle-tested (used by Evernote, Affine, Linear).
- **Worker Threads + pdfium.wasm** for PDF editing: pdfium is already a wasm module in the existing code; Worker Threads let us run pdfium in parallel without blocking the websocket server.
- **HS256 JWT with three secrets (browser/inbox/outbox)**: identical to ONLYOFFICE's model so integrators can port their signing code; three independent secrets prevent a browser leak from compromising host→server requests.
- **Reference host as a separate app**: integrators can copy it whole as their starting point; we don't ship it as a product.

---

## 2. The API contract (mirror ONLYOFFICE, diverge where GenOffice needs to)

Source of truth: `.omo/plans/reference-onlyoffice-api.md`. Below is the contract summary + where we diverge.

### 2.1 SDK loading & constructor

```html
<script src="https://editor.internal/sdk/genoffice.js"></script>
```
```js
const editor = new GenOfficeAPI.DocEditor("placeholder", {
  document: { /* §2.2 */ },
  editorConfig: { /* §2.3 */ },
  events: { /* §2.5 */ },
  token: "<jwt>",        // HS256 with browser secret, payload = entire config
  type: "desktop",       // "desktop" | "mobile" | "embedded"
  documentType: "word",  // "word" | "pdf"  (we ship two editors, not four)
})
```
- `placeholder` is the **id** of a DOM element that gets replaced by the iframe. Same as ONLYOFFICE (`web-apps/apps/api/documents/api.js` L593–L621 in the reference).
- Required params (SDK validates, alerts on missing): `document.url`, `document.fileType` OR `documentType`, `document.key`.

### 2.2 `document`

```js
document: {
  fileType: "docx",                    // "docx" | "pdf"
  key:     "<uuid-or-hash>",           // room identity + cache key; see §2.6
  title:   "Q3 Report.docx",
  url:     "https://host/files/abc",   // GET, returns bytes; bearer if JWT on
  permissions: { /* §2.7 */ },
  info:    { owner: "Alice", folder: "Reports", uploaded: "2026-...", favorite: false },
}
```

### 2.3 `editorConfig`

```js
editorConfig: {
  mode:        "edit",                 // "edit" | "view"
  lang:        "en",
  callbackUrl: "https://host/track",   // REQUIRED for save
  user: { id: "u1", name: "Alice", image: "https://..." },
  coEditing:   { mode: "fast", change: true },   // "fast" | "strict"
  customization: {
    autosave: true, forcesave: false, logo: { /* branding */ }, goback: { url, text },
    // GenOffice-specific:
    ai: { enabled: true, sidebar: true, model: "claude-sonnet" },  // diverges from ONLYOFFICE
  },
}
```

**Divergence from ONLYOFFICE:** `customization.ai` is GenOffice-specific. Controls the AI panel (block-level edits, snapshots, diffs) — a load-bearing feature for the docx editor.

### 2.4 `editorConfig.callbackUrl` — save protocol

Identical to ONLYOFFICE. The editor service POSTs status updates; the host replies `{"error":0}` and downloads the assembled file from `url`.

| status | Meaning |
|---|---|
| 1 | being edited (per-user connect/disconnect) |
| 2 | ready for saving (last user closed with changes) — `url` is the new docx/pdf |
| 3 | save error |
| 4 | closed with no changes |
| 6 | forcesave (still editing) |
| 7 | forcesave error |

Body includes `key, status, url, users, actions, changesurl, history, filetype, forcesavetype` per the reference (§5). Host response: `{"error": 0}` mandatory.

### 2.5 Events

Inherit ONLYOFFICE's event taxonomy (`.omo/plans/reference-onlyoffice-api.md` §7). The critical ones:

- **Lifecycle**: `onAppReady`, `onDocumentReady`, `onError`, `onInfo`.
- **Dirty state**: `onDocumentStateChange({data: boolean})` — for showing "unsaved changes" warnings in the host.
- **View→edit**: `onRequestEditRights` — user clicked "go to edit"; host re-inits editor with edit-mode config.
- **Save As / rename**: `onRequestSaveAs`, `onRequestRename`.
- **Close**: `onRequestClose`.
- **History** (paired method calls): `onRequestHistory` → `refreshHistory(...)`, `onRequestHistoryData` → `setHistoryData(...)`, `onRequestRestore`, `onRequestHistoryClose`.
- **Insert image / mail-merge / @-mention**: `onRequestInsertImage` → `insertImage(...)`, `onRequestUsers` → `setUsers([...])`, `onRequestSendNotify`.
- **Outdated**: `onOutdatedVersion` / `onRequestRefreshFile`.

**Divergence:** none. Mirroring the ONLYOFFICE events API verbatim maximizes portability.

### 2.6 `document.key` rules

Same as ONLYOFFICE (`.omo/plans/reference-onlyoffice-api.md` §3):

1. **Generate a new key on every save.** After status-2 callback with `{"error":0}`, the old key is frozen for editing (still valid for view from cache until eviction).
2. Charset `0-9 a-z A-Z -._=`, max 128 chars.
3. Must be **globally unique across all integrators** sharing an editor service — else you'll get someone else's cached doc. Use a UUID v4 or `hash(fileId + version + tenantSalt)`.
4. Same `key` + different `url` = URL silently ignored, cached doc reopened.
5. Don't change `key` during forcesave.

### 2.7 Permissions

Inherit ONLYOFFICE's permission set (`.omo/plans/reference-onlyoffice-api.md` §8) but prune to what GenOffice supports in v1:

```js
permissions: {
  edit: true, download: true, print: true, copy: true,
  review: true, comment: true, fillForms: true,
  // GenOffice-specific (diverges):
  aiEdit: true,   // controls the AI panel
}
```
Drop `modifyFilter`, `modifyContentControl`, `commentGroups`, `reviewGroups`, `userInfoGroups` for v1 (they're for group-scoped review workflows we don't support yet). Add `aiEdit` for the AI panel gate.

### 2.8 JWT

Three HS256 secrets, three enable flags, identical to ONLYOFFICE (`.omo/plans/reference-onlyoffice-api.md` §6):

```jsonc
// /etc/genoffice/editor-service.json  (mounted into the container)
{
  "secrets": {
    "browser": {"string": "..."},  // validates config sent browser → editor service
    "inbox":   {"string": "..."},  // validates host → editor service (command/convert)
    "outbox":  {"string": "..."}   // editor service signs host → callbacks, file GETs
  },
  "token": { "enable": { "browser": true, "request": { "inbox": true, "outbox": true } } }
}
```

- Browser config: `token` field at top level, payload = entire config.
- Host→DS requests: `Authorization: Bearer <jwt>` header, payload wrapped as `{"payload":{...body...}}`.
- DS→Host callbacks/file-GETs: `Authorization: Bearer <jwt>` header.

**No JWKS rotation in v1** (matches ONLYOFFICE). Rotation = edit secrets + restart container + brief overlap window. Document this in the integrator guide.

---

## 3. Constraint resolution

### 3.1 Byte-preserving docx round trip under collaboration

This is the hardest technical problem in the plan. The desktop app already does it for a single user: docx-engine parses to a block tree; Tiptap edits; on save, dirty blocks regenerate to OOXML fragments; fragments splice into the original `word/document.xml`; the zip repacks with untouched entries byte-for-byte.

**For collaboration, the model is:**

```
document.url (docx bytes)
      │
      ▼  (editor service, on session open)
docx-engine.parse(bytes) → BlockTree + originalBytes + originalHash
      │
      ▼
blockTreeToProseMirror(BlockTree) → ProseMirrorDoc
      │
      ▼
ProseMirrorDoc ↔ Y.Doc  (y-prosemirror binding; Y.Doc is the live collab state)
      │
      ▼  (websocket broadcast to all editors)
Editor iframe loads Y.Doc, renders via Tiptap
      │
      ▼  (user edits; y-prosemirror turns ProseMirror transactions into Y.js ops)
Y.js ops flow through server → all editors; convergent CRDT
      │
      ▼  (on save: status-2 callback or forcesave)
Y.Doc → ProseMirrorDoc → proseMirrorToBlockTree → diff against original BlockTree
      │
      ▼  (dirty-block detection; same path as desktop AI edits)
docx-engine.patch({ originalBytes, dirtyBlocks }) → newBytes
      │
      ▼
Editor service uploads newBytes to a temp URL → POST callback with that URL
```

**Critical invariants:**
- The `originalBytes` (archived by hash, same pattern as desktop `userData/originals/<sha256>.docx`) live in the editor service's memory for the session lifetime. They're the byte-preservation reference.
- The block-tree ↔ ProseMirror ↔ Y.Doc mappings must be **invertible** — i.e., saving the doc must produce the same block tree (modulo edits) the parse produced, so dirty-block detection works.
- The docx-engine is **untouched**. What's new is the BlockTree ↔ ProseMirror mapping layer (in a new package `packages/collab-docx/`).

**Risk:** the existing Tiptap renderer in `apps/docs/src/renderer/` already has a BlockTree ↔ Tiptap mapping (it's how the desktop editor works today). We extract that into a shared package so both the editor service (server-side parse) and the iframe (client-side render) use the same mapping. **This extraction is the technical heartbeat of the docx collaboration work** — see §7 (risks).

### 3.2 Real PDF text editing under collaboration

PDFs are opaque content streams. There is no clean CRDT for pdfium edit ops. The realistic v1 model:

```
Per-document.key session (server-side, in PDF worker):
  - pdfium holds the doc resident
  - Edit lock: one user owns it at a time (per-document in v1)
  - All viewers receive live page renders via websocket (binary PNG/WEBP chunks)
  - All viewers see each other's viewport + cursor via presence channel
  - Annotation layer is a SEPARATE Y.js doc over PDF coordinate space —
    collaborative by default (multiple users can annotate concurrently)
  - Edit ops from the lock holder flow: client → server → pdfium → re-render affected pages → broadcast
  - On lock release: forcesave (status 6) automatically
```

**Why lock-based for edits:**
- True OT/CRDT on content-stream ops is research-grade (no library; pdfium isn't transactional).
- Lock matches user expectations for PDF (people don't expect to co-type in a PDF the way they do in a docx).
- Annotations (the genuinely collaborative surface) get full Y.js treatment.

**Lock UX:**
- Viewers see "Alice is editing" with a takeover button (alice's client gets a "someone wants to edit" prompt; if no response in N seconds, lock transfers).
- Lock is per-document. Page-level locking is a v1.1 refinement.

### 3.3 PDF font strategy (carries over from previous plan)

Three tiers (unchanged):
1. Bundled catalog (Carlito/Caladea/Liberation/Noto CJK from `apps/docs/src/renderer/fonts/`) — covers ~90%.
2. Local Font Access API (`navigator.fonts.query()`) where available — Chromium-only.
3. Operator-configured font directory on the editor service host (`/opt/genoffice/fonts/`) — server-side fallback. Customer can mount their org's licensed fonts.

This is **easier than the SaaS plan** because the editor service runs in the customer's own infra — they can mount their licensed font library directly. Tier 3 becomes practical, not a last resort.

### 3.4 Real-time collaboration

Two different stacks because the document models are different:

| | docx | pdf |
|---|---|---|
| Doc model | Y.Doc (CRDT) over ProseMirror | Opaque pdfium handle (server-side) |
| Edit concurrency | Full concurrent editing | Lock-based (one editor at a time) |
| Annotation/comment | Y.js channel (same doc) | Y.js channel (separate doc over PDF coord space) |
| Presence | Cursors, selections, viewport | Viewport, cursor |
| Library | `y-websocket` + `y-prosemirror` | Custom (lock state + binary render broadcast) |

---

## 4. Editor service components

### 4.1 Process model

Single Node.js process per container (replica horizontally; route by `document.key` shardkey — see §4.6). Inside the process:

- HTTP server (Hono) — serves SDK, editor SPAs, command/convert routes, JWT-validated.
- WebSocket server (`ws`) — handles `/coauthoring/*` upgrade, routes to Y.js rooms or PDF session manager by `documentType`.
- Worker Threads pool — pdfium + hb-subset, one worker per active PDF session (or a small pool with affinity).
- Session registry — `Map<documentKey, Session>` where `Session` is either `DocxSession { yDoc, originalBytes, blockTree, users }` or `PdfSession { worker, lockOwner, users, annotationYDoc }`.

### 4.2 Session lifecycle

```
OPEN:
  1. Iframe boots, validates config JWT, extracts document.key + documentType
  2. Session registry: hit? attach user → existing session. Miss? continue.
  3. Miss path: fetch document.url (with outbox JWT in Authorization), parse,
     build initial state (Y.Doc for docx; pdfium worker for pdf), register session.
  4. Subscribe user to session updates; broadcast presence update.

EDIT:
  docx: y-prosemirror transactions → Y.js ops → broadcast to room
  pdf:  lock holder sends ops → worker applies → broadcast re-renders

CLOSE (last user leaves, ~10s grace):
  docx: assemble current Y.Doc → block tree → docx-engine.patch → upload → POST callback status=2
  pdf:  worker writes new PDF bytes → upload → POST callback status=2
  Then evict session from registry.

FORCESAVE (timer, explicit save, or session idle):
  Same as CLOSE but session stays alive. POST callback status=6.

CACHE EVICTION (TTL since last user left, default 1h):
  Drop session from registry. Next open with same key rebuilds from document.url.
  (Only relevant if the host reused a key — which they shouldn't, see §2.6.)
```

### 4.3 SDK (`/sdk/genoffice.js`)

Mirror ONLYOFFICE's `web-apps/apps/api/documents/api.js` shape (`.omo/plans/reference-onlyoffice-api.md` §1):
- Define global `GenOfficeAPI`.
- `DocEditor(placeholderId, config)` constructor: validate required params, create iframe, replace placeholder, postMessage `{command:'init', data:{config}}`.
- Methods: `downloadAs()`, `insertImage()`, `refreshHistory()`, `setHistoryData()`, `setUsers()`, `setActionLink()`, `refreshFile()`, `requestEditRights()`, `destroyEditor()`.
- postMessage dispatcher: route iframe→host events to `config.events.*` callbacks.
- Same-origin enforcement: SDK only accepts postMessage from the iframe origin it created.

### 4.4 Editor SPAs

Each editor iframe (`/editor/docs`, `/editor/pdf`) is a Vite+React app built from the existing renderer:
- `/editor/docs` ← `apps/docs/src/renderer/` minus `window.desktop` calls; plus a `CollabClient` that speaks the Y.js websocket protocol to `/coauthoring/docs/<key>`.
- `/editor/pdf` ← `apps/pdf/src/renderer/` minus `window.pdfApi`; plus a `PdfCollabClient` that speaks the lock/render-broadcast protocol to `/coauthoring/pdf/<key>`. The pdfium worker stays server-side (in the editor service's Worker Threads, not in the iframe).

**Renderer refactor:** same pattern as previous plan — inject the API via a factory. The iframe's "API" is no longer `window.desktop` but a `CollabClient` injected by the iframe shell.

### 4.5 PDF worker (server-side, Worker Threads)

Moves `apps/pdf/src/main/{text-edit,image-edit,font-subset,font-locate,wasm-path}.ts` logic into `apps/editor-service/src/pdf-worker/`:
- `pdf-worker.ts` — Worker entry; instantiates pdfium.wasm + hb-subset.wasm from `fetch().arrayBuffer()` (or `readFileSync` if local file).
- Receives `postMessage` requests: `loadDocument`, `applyTextEdit`, `applyImageEdit`, `renderPage(pageNum, scale)`, `validateEdits`, `extractPages`, `insertPdf`, `save`.
- Streams page renders back as transferable `ArrayBuffer` (zero-copy).
- Loads fonts from three tiers (§3.3).

### 4.6 Clustering (multi-replica)

Same as ONLYOFFICE: all clients editing the same `document.key` must hit the same replica. The SDK appends `?shardkey=<document.key>` to its requests (matches ONLYOFFICE §9 of the reference). Customer puts a sticky-session load balancer (nginx `upstream hash $arg_shardkey;`) in front of the editor service replicas.

Redis (optional) for cross-replica presence broadcast in v1.1; v1 ships single-replica-per-key without Redis.

---

## 5. Reference host app (`apps/reference-host`)

A working example integrators can copy. Stack: **Vite + React + Express** (or Hono — pick what's clearer for example code).

Features:
- File upload + list + delete (files in `./data/files/`).
- Mock user picker (Alice / Bob / Carol — same browser, different tabs to demo collab).
- **JWT signing example** (browser secret) — the canonical "how do I sign a config" code.
- **`POST /track` callback handler** — downloads `url` from the editor service, persists as new version, records history row, replies `{"error":0}`.
- **`GET /files/:id/bytes`** — `document.url` endpoint; sends bytes with `Content-Type: application/vnd.openxmlformats-officedocument.wordprocessingml.document`.
- **Editor embed** — `<script src="/sdk/genoffice.js">` (proxied to the editor service) + `new GenOfficeAPI.DocEditor(...)`.
- **Version history UI** — minimal: list versions, click to open that version's editor.
- **Read-only embed example** — `mode:"view"` + `permissions:{edit:false}`.
- **Embedded viewer example** — `type:"embedded"`.

This is documentation-as-code: integrators read it, copy it, adapt it. Not a product.

---

## 6. Work breakdown (phased)

Total estimate: **~14 weeks** for one engineer; **~9 weeks** with two engineers (Phases 4 and 5 can overlap; Phases 7 and 8 can overlap). Each phase ends in a demoable state.

### Phase 0 — Spikes & workspace setup (1.5 weeks)
- [ ] Spike: Y.js + y-prosemirror + Tiptap minimal demo (two browser tabs editing a paragraph, convergent). Validates the docx collab approach.
- [ ] Spike: pdfium in Node Worker Threads with `WebAssembly.instantiate(readFileSync(...))`. Validate text-edit on a real PDF produces byte-identical output to the desktop app.
- [ ] Spike: iframe + postMessage SDK scaffold — minimal `GenOfficeAPI.DocEditor` that injects an iframe, sends config, receives `onDocumentReady`.
- [ ] Create `apps/editor-service/`, `apps/reference-host/`, `packages/editor-contract/`, `packages/collab-docx/`, `packages/collab-pdf/`, `packages/sdk-shared/`.
- [ ] Confirm desktop build (`apps/shell`) still compiles after the workspace additions.
- **Exit:** Y.js spike works in two tabs; pdfium spike produces byte-identical saves; SDK scaffold injects an iframe that says "ready".

### Phase 1 — Editor service skeleton + SDK (2 weeks)
- [ ] Hono server: static serving for SDK + (placeholder) editor SPAs.
- [ ] JWT module: HS256 sign/verify, three-secret config, browser/inbox/outbox validation middleware.
- [ ] `GenOfficeAPI.DocEditor` SDK: full method set, postMessage protocol, event dispatch.
- [ ] `POST /command` route (forcesave, meta, info, version, getForgottenList) — host→DS control.
- [ ] `POST /converter` route — placeholder for format conversion (we ship native only in v1, but the route exists for API parity).
- [ ] Dockerfile + `docker-compose.yml` (editor service + reference host side-by-side).
- **Exit:** reference host embeds the SDK, gets an editor iframe loaded, signs a valid config JWT, iframe validates it. No editing yet (placeholder SPA).

### Phase 2 — Docs single-user editor wired in (2 weeks)
- [ ] Extract the BlockTree ↔ Tiptap/ProseMirror mapping from `apps/docs/src/renderer/` into `packages/collab-docx/`. Verify desktop still works against the extracted package.
- [ ] `/editor/docs` SPA: built from the existing docs renderer, with `window.desktop` replaced by a `SingleUserClient` that talks to the editor service over HTTP (no Y.js yet).
- [ ] Session manager: on iframe `init`, fetch `document.url`, parse via `docx-engine`, hold `originalBytes` + `blockTree` + a single-user `ProseMirrorDoc` in memory.
- [ ] Save flow: iframe posts edits → server reconstructs block tree → diff against original → `docx-engine.patch` → upload → POST callback status=2.
- [ ] **Byte-preservation regression test**: open fixture `.docx`, edit one paragraph, save, download from reference host, diff against original — only touched paragraph bytes differ.
- [ ] Renderer feature parity: print, export-pdf, image insert, AI panel stub (no AI backend yet).
- **Exit:** a single user opens a docx in the reference host, edits, saves, downloads — byte-preserved.

### Phase 3 — PDF single-user editor wired in (2.5 weeks)
- [ ] `/editor/pdf` SPA: built from the existing pdf renderer, with `window.pdfApi` replaced by a `SingleUserPdfClient`.
- [ ] PDF worker (Worker Threads): pdfium + hb-subset, all ops from `apps/pdf/src/main/text-edit.ts` etc. moved in. Wasm bytes loaded from local file (Docker-mounted).
- [ ] Three-tier font loader (bundled catalog + Local Font Access + operator-configured dir).
- [ ] Session manager: on iframe `init`, fetch `document.url`, hand bytes to a worker, hold worker handle in registry.
- [ ] Save flow: worker writes new PDF → upload → POST callback status=2.
- [ ] **Real-edit regression test**: open a PDF with embedded subset font, retype a run, save, open in Acrobat — content stream rewritten correctly, font subset embedded.
- [ ] Image edit, page extract, page insert flows.
- **Exit:** a single user opens a PDF in the reference host, edits text, edits image, extracts/inserts pages, saves — Acrobat-valid.

### Phase 4 — Docx real-time collaboration (2 weeks)
- [ ] Replace `SingleUserClient` with `CollabClient` that speaks `y-websocket` protocol to `/coauthoring/docs/<key>`.
- [ ] Server: `y-websocket`-compatible room per `<key>`, holding the shared `Y.Doc`.
- [ ] On session open: `blockTreeToYDoc(blockTree)` initializes the `Y.Doc` if room is new; otherwise attaches to existing.
- [ ] Presence channel: cursor, selection, user list (Y.js awareness protocol).
- [ ] Save flow under collab: when last user leaves OR forcesave fires, run `Y.Doc → block tree → patch → upload → callback`. Multiple concurrent users → still one save (status-2 from session close).
- [ ] Conflict handling: CRDT means no conflicts. Verify with two tabs editing the same paragraph.
- [ ] `onDocumentStateChange` correctly fires per-user (Tiptap dirty state).
- **Exit:** two users in two tabs co-edit a docx; cursors visible; save preserves bytes; reload shows merged edits.

### Phase 5 — PDF real-time collaboration (1.5 weeks)
- [ ] PDF lock manager: per-document.key edit lock with takeover prompt.
- [ ] Live render broadcast: when lock holder edits, affected pages re-render in worker → broadcast PNG/WEBP to all viewers.
- [ ] Presence: viewport + cursor broadcast.
- [ ] Annotation Y.js doc: per `<key>`, separate from edit state; collaborative by default.
- [ ] Forcesave on lock release (status=6) so the editor's edits persist before another user takes over.
- **Exit:** two users open a PDF; one edits while other watches live; annotations from both visible; lock transfer works.

### Phase 6 — AI panel (1 week)
- [ ] Editor service `/ai/*` routes: `chat`, `stream` (SSE), `web-search`, `image-search`, `fetch-image`, `generate-image` (PDF only in v1).
- [ ] Operator configures `GENOFFICE_GSK_KEY` (or per-tenant keys if multi-tenant). Editor service proxies to Genspark HTTPS.
- [ ] SSRF guard ported from `packages/electron-utils/src/safe-remote-url.ts` to a server middleware.
- [ ] iframe AI client routes through editor service (never calls Genspark directly).
- [ ] Block-level AI edits in docx integrate with the Y.Doc (AI edits become regular transactions, broadcast to collaborators).
- **Exit:** AI panel works in both editors; AI edits are visible to collaborators in real time.

### Phase 7 — Reference host app polish (1 week)
- [ ] File list with thumbnails (rendered by editor service `/preview` endpoint).
- [ ] User picker with avatars; "open as Alice" / "open as Bob" tabs.
- [ ] Version history UI (lists versions from `/track` callback history).
- [ ] Read-only embed example.
- [ ] Embedded viewer example (`type:"embedded"`).
- [ ] JWT signing examples in 3 languages (JS, Python, Go) in the integrator guide.
- [ ] Integrator guide markdown (`docs/integrator-guide.md`): config schema, callback protocol, JWT, permissions, events, common patterns.
- **Exit:** a new integrator can read the guide + reference host and have a working embed in their app within a day.

### Phase 8 — Polish & GA (1.5 weeks)
- [ ] Theming: light/dark/system via CSS tokens (existing `packages/ui` already supports this).
- [ ] i18n: `packages/i18n` works as-is; editor SPAs initialize from `editorConfig.lang`.
- [ ] Print stylesheet pass for the iframe.
- [ ] Permissions enforcement matrix tests (every `permissions.*` flag verified end-to-end).
- [ ] Cluster mode: nginx sticky-session via shardkey; verify two replicas + same `key` routes consistently.
- [ ] Health check + metrics endpoints (`/health`, `/metrics` Prometheus).
- [ ] E2E test suite (Playwright): open → multi-user edit → save → byte-diff.
- [ ] Docker image published; semantic versioning; upgrade guide.
- **Exit:** shippable v1.

---

## 7. Risks & mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| **BlockTree ↔ ProseMirror ↔ Y.Doc mapping is not cleanly invertible** (save produces a different block tree than parse) | **Critical** | Phase 0 Y.js spike must include a round-trip test: parse → block tree → ProseMirror → Y.Doc → ProseMirror → block tree → assert structural equality with original. If it fails, the desktop Tiptap mapping needs refactor before collab work starts. **This is the single biggest technical risk.** |
| **Byte-preservation breaks under collaboration** (concurrent edits produce block-tree deltas the patcher can't splice cleanly) | High | Phase 4 byte-preservation test must run with two concurrent editors. If patch fails, fall back to "save the whole document.xml" for collaborative docs (loses byte-preservation but keeps Word compat). Document the trade-off. |
| **pdfium Worker Thread memory blowup** on large PDFs | High | Cap session count per replica; per-session page cap; LRU eviction. Phase 3 must profile against 200+ page PDFs. |
| **PDF font coverage gap** (customer's PDFs use fonts the bundled catalog + Local Font Access + operator dir don't cover) | Medium | Three-tier strategy (§3.3). Operator font dir is the practical answer for self-hosted. Document the catalog-coverage spike in Phase 0. |
| **Y.js websocket scaling** (single replica handles N concurrent rooms; memory grows) | Medium | Phase 8 cluster mode + Redis presence in v1.1. v1 supports ~100 concurrent docx sessions per replica — adequate for self-hosted mid-market. |
| **JWT secret rotation downtime** | Low | Document the brief-overlap rotation procedure. Optional: dual-secret validation shim in v1.1. |
| **iframe cross-origin restrictions break some host-page integrations** (postMessage origin checks, cookie restrictions) | Low | SDK accepts a configured list of allowed host origins. Document CORS / cookie requirements clearly. |
| **Collaboration on AI edits is jarring** (AI rewrites a paragraph that another user is also editing) | Medium | Use Y.js awareness to surface "AI is editing block X" hints; serialize AI edits as transactions tagged with a synthetic user. UX polish in Phase 6. |
| **Editor SPA bundle size** (Tiptap + pdf.js + Y.js + fonts) | Medium | Lazy-load: only load the docx or pdf bundle based on `documentType`. Code-split AI panel. Target <2 MB initial bundle per editor type. |
| **Reference host is mistaken for the product** | Low | Name it `reference-host` everywhere; mark "example" in the UI; integrator guide leads with "you build the host, this is just a demo." |
| **Operator misconfigures inbox/outbox secrets** → silent auth failures | Medium | Startup config validation (fail fast with a clear error); `/health` returns secret-config status. |

---

## 8. File-level change inventory

### New apps/packages
```
apps/editor-service/                         ~3500 LOC
  src/
    server/
      index.ts                               Hono app entry
      routes/sdk.ts                          GET /sdk/genoffice.js
      routes/command.ts                      POST /command
      routes/converter.ts                    POST /converter
      routes/editor-pages.ts                 GET /editor/{docs,pdf}
      jwt/
        sign.ts                              HS256 sign (3-secret)
        verify.ts                            HS256 verify middleware
        config.ts                            secret loading
      sessions/
        registry.ts                          Map<key, Session>
        docx-session.ts                      Y.Doc + originalBytes + blockTree
        pdf-session.ts                       worker handle + lock + annotationYDoc
        lifecycle.ts                         open/edit/close/forcesave flows
      collab/
        y-websocket-room.ts                  y-websocket compatible room
        pdf-render-broadcast.ts              render → viewer fanout
        presence.ts                          awareness channel
      pdf-worker/
        pdf-worker.ts                        Worker entry
        text-edit.ts                         moved from apps/pdf/src/main/
        image-edit.ts                        moved
        font-subset.ts                       moved
        font-locate.ts                       moved (server-side dir scan)
        font-catalog.ts                      bundled font registry
        wasm-loader.ts                       fetch / readFileSync
      ai-proxy/
        gsk-proxy.ts                         Genspark HTTPS calls
        ssrf.ts                              ported from electron-utils
      save-assembler/
        docx-assemble.ts                     Y.Doc → block tree → patch
        pdf-assemble.ts                      worker writes new bytes
    static/                                  built SPAs land here
    Dockerfile
    nginx.conf
    docker-compose.yml
  package.json

apps/reference-host/                         ~1200 LOC
  src/
    server/
      index.ts                               Express/Hono
      routes/files.ts                        upload/list/delete
      routes/track.ts                        POST callback handler
      routes/document-url.ts                 GET /files/:id/bytes
      jwt-sign.ts                            browser-secret signing example
    client/
      App.tsx                                file list + user picker
      EditorEmbed.tsx                        the SDK wrapper
      HistoryDrawer.tsx                      version history UI
    data/files/                              (gitignored)
  package.json

packages/editor-contract/                    ~600 LOC
  src/
    config.ts                                Config, Document, EditorConfig types
    callback.ts                              CallbackRequest, status enum
    events.ts                                Event map types
    permissions.ts                           Permissions types
    sdk.ts                                   DocEditor method signatures
  package.json

packages/collab-docx/                        ~1500 LOC (mostly extracted)
  src/
    block-tree-to-prosemirror.ts             extracted from apps/docs/src/renderer
    prosemirror-to-block-tree.ts             extracted
    block-tree-to-y-doc.ts                   NEW
    y-doc-to-block-tree.ts                   NEW
    dirty-block-diff.ts                      extracted from docx save flow
  package.json

packages/collab-pdf/                         ~400 LOC
  src/
    lock-manager.ts                          per-key edit lock with takeover
    annotation-y-doc.ts                      PDF coord space annotation CRDT
    render-protocol.ts                       render broadcast message types
  package.json

packages/sdk-shared/                         ~300 LOC
  src/
    sdk.ts                                   GenOfficeAPI.DocEditor implementation
    postmessage-protocol.ts                  iframe↔host message types
    jwt-sign-browser.ts                      config JWT signing helper for hosts
  package.json
```

### Modified files
- `apps/docs/src/renderer/**` — replace `window.desktop` with injected client API. Once the BlockTree ↔ ProseMirror mapping is extracted to `packages/collab-docx/`, the renderer imports from there.
- `apps/pdf/src/renderer/**` — replace `window.pdfApi` with injected client API. The pdfium worker logic stays in the desktop main process (for the desktop product) AND moves to the editor service (for the new product) — shared types via `packages/editor-contract/`.
- `apps/docs/src/main/docs-main.ts` — **unchanged**. Desktop code path stays.
- `apps/pdf/src/main/pdf-main.ts` — **unchanged**. Desktop code path stays.
- `packages/docx-engine/`, `packages/pptx-engine/`, `packages/pptx-render/`, `packages/agent-core/`, `packages/ai-provider/`, `packages/i18n/`, `packages/ui/`, `packages/electron-utils/`, `packages/file-parse/` — **untouched**.
- `tsconfig.base.json` — path aliases for new packages.
- Root `package.json` — workspace scripts (`dev:editor-service`, `dev:reference-host`, `build:editor-service`, `docker:build`).

### Deleted files
None. Desktop code stays alive.

### Untouched (still alive, still supported)
- `apps/shell/` (desktop suite)
- `apps/sheets/`, `apps/slides/`, `apps/markdown/` (other desktop editors — not in scope for v1 web editor service, but build still works)

---

## 9. Out of scope (v1)

- **Sheets, slides, markdown editors** in the embeddable service. Architecture allows adding them later (especially markdown — it's the simplest); sheets/slides bring the Rust sidecar and the harfbuzz shaping back into scope.
- **WOPI protocol support.** ONLYOFFICE offers WOPI as an alternative integration model. We ship only the custom config+callback API in v1. Add WOPI in v1.1 if a customer needs it (SharePoint/Nextcloud integration).
- **Cross-replica collaboration** (Redis-backed presence, multi-node Y.js). v1 is single-replica-per-key via sticky-session load balancing.
- **Mobile-optimized editor UX**. `type:"mobile"` is a config value we accept, but v1 doesn't ship a separate mobile UI — desktop UI scales responsively. True mobile UI in v1.1.
- **End-to-end encryption** of stored documents.
- **Public sharing links** (anyone-with-URL can view). Customers build this in their host app via the SDK + view-mode permissions.
- **Real-time co-editing on PDF content streams** (true OT on pdfium ops). v1 ships lock-based editing + collaborative annotations. True co-editing is research-grade and stays out.
- **Migration tool** from desktop `userData/` to a host's storage.

---

## 10. Open questions (need answers before Phase 1 starts)

1. **Branding & naming.** "GenOffice" and "Genspark" are Mainfunc trademarks (per repo `README.md`). Self-hosted product released to customers almost certainly needs a different name + LICENSE review (the existing `ee/` directory uses the GenOffice Enterprise License; does this product live there?). **Legal blocker before any public release.**
2. **License model for the editor service** — **RESOLVED: Apache-2.0** (inherits the repo root). Editor service source lives at `apps/editor-service/` with no special `LICENSE` override. Reference host at `apps/reference-host/` is also Apache-2.0. Docker image is freely redistributable. Trade-off accepted: competitors can package this work without contributing back, in exchange for maximum adoption and zero license-infrastructure overhead. (Revisit if a competitor resells the editor service without attribution — switching to AGPL+commercial dual later is a single commit + LICENSE file change.)
3. **Multi-tenant or single-tenant per deployment?** Single-tenant (one customer = one container) is simpler and matches how ONLYOFFICE is typically deployed. Multi-tenant (one container serves multiple customers) needs stricter session isolation. Recommend single-tenant for v1.
4. **Operator-provided AI keys vs per-user AI keys?** If operator provides the gsk key, every user on that deployment uses the operator's Genspark billing. If per-user, the editor service needs an "AI sign-in" flow per user. Recommend operator-provided for v1 (matches self-hosted model); per-user as v1.1.
5. **CI / release pipeline.** Docker image build, semantic versioning, signed images, changelog. Need a GitHub Actions workflow.
6. **Reference host licensing.** Apache-2.0 (matches §10.2). Customers can copy it freely into proprietary apps without license concerns.

---

## 11. Spike work to de-risk before Phase 1

Three one-day spikes that resolve the biggest unknowns cheaply:

1. **Y.js docx collab spike** (highest priority — resolves the critical risk): minimal Tiptap editor with y-prosemirror + y-websocket. Two browser tabs editing one paragraph. Round-trip test: serialize ProseMirror doc to a known block tree shape, apply a Y.js op from another tab, serialize back, assert structure. **Exit criterion:** convergent CRDT + invertible block-tree mapping proven. If this fails, the docx collab approach needs rethinking before any other work starts.
2. **pdfium in Node Worker Threads spike**: load pdfium.wasm in a Worker Thread, open a fixture PDF, apply a text edit, save bytes. Compare bytes to a desktop save of the same edit. **Exit criterion:** byte-identical output. Validates that the worker-port is mechanical, not a rewrite.
3. **SDK + iframe + postMessage spike**: minimal `GenOfficeAPI.DocEditor` that creates an iframe at a different origin, postMessages a config, iframe acks with `onDocumentReady`. **Exit criterion:** two-way postMessage works cross-origin; JWT validation passes.

Run all three in parallel during Phase 0; do not start Phase 1 until they pass.

---

## 12. Success criteria

The migration is done when:

- A customer can `docker pull genoffice/editor-service:v1` and `docker run -p 443:443 -v ./config:/etc/genoffice genoffice/editor-service:v1` and have a working editor service.
- The reference host app (`apps/reference-host`) embeds the editor service, lists files, opens a docx in edit mode with two concurrent users (Alice + Bob), saves, downloads the result, and the byte-preservation regression test passes against a fixture corpus.
- The same flow works for PDF: two users, one editing (lock-based), one watching live, annotations collaborative, save produces an Acrobat-valid PDF.
- An integrator following `docs/integrator-guide.md` can embed the editor in their own app in under a day, sign valid JWTs, handle the callback protocol, get real-time collaboration working.
- The desktop Electron build (`apps/shell`) still builds and runs unchanged.
- All three Phase 0 spikes pass and are checked in as living tests.
- E2E Playwright suite covers: sign-config, open-docx, multi-user-edit, save, byte-diff; open-pdf, lock-edit, save, Acrobat-valid; permissions enforcement; events API.

Not required for v1 "done": WOPI, sheets/slides/markdown in the service, cross-replica collab, mobile UI, true PDF content-stream co-editing.
