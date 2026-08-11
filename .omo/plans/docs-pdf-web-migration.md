> **⚠️ SUPERSEDED** — see `embeddable-editor-service.md`. The architecture pivoted from a SaaS web app (host owns files/users) to an embeddable Document Editor Service (ONLYOFFICE Docs shape — customers deploy the editor as a Docker container, their existing app embeds it). This file is kept as the alternative-architecture analysis; do not execute against it.

# GenOffice Docs + PDF — SaaS Web Migration Plan (SUPERSEDED)

**Scope:** Port `apps/docs` (`.docx` byte-preserving editor) and `apps/pdf` (real PDF text/image editor) from Electron to a SaaS web app. Drop sheets, slides, markdown. Keep the existing Electron desktop build alive in parallel — the web port is additive (`apps/web`, `apps/server`, `packages/web-*`), not a delete-and-replace.

**Constraints (locked):**
1. Keep byte-preserving docx round trip ("Word never notices").
2. Keep real PDF text editing (pdfium content-stream rewrites + subset-embedded fonts).
3. Offline-capable.
4. Engine packages untouched (`packages/docx-engine`, etc.).

**Additional constraints (recommended, this plan assumes them):**
5. **Single-editor-per-document for v1.** No real-time multi-user CRDT. The data model leaves room for it later; shipping it now would ~3× the work.
6. **Local-first architecture** (the resolution of "SaaS + offline"): server is source of truth for cross-device/share; everything mirrors to client storage; edits work offline; sync on reconnect. AI is online-only (acceptable — AI is inherently a network feature).
7. **Desktop build stays alive** in `apps/shell`. Web port is a new surface, not a replacement.

---

## 1. Architecture

```
                         ┌─────────────────────────────────────────┐
                         │            Browser (per user)            │
                         │                                          │
                         │  ┌─────────────┐   ┌─────────────────┐  │
                         │  │  docs SPA   │   │   pdf SPA       │  │
                         │  │ (Vite+React)│   │  (Vite+React)   │  │
                         │  │             │   │                 │  │
   routes:  /docs/:id ─► │  │  Tiptap     │   │  pdf.js viewer  │  │
            /pdf/:id  ─► │  │  editor     │   │  + edit overlay │  │
            /home        │  └──────┬──────┘   └────────┬────────┘  │
                         │         │                   │           │
                         │  ┌──────▼───────────────────▼────────┐  │
                         │  │  @genoffice/web-runtime           │  │
                         │  │  (new pkg: typed client for the   │  │
                         │  │   server API; matches the existing│  │
                         │  │   DesktopApi surface)             │  │
                         │  └──────┬────────────────────┬───────┘  │
                         │         │                    │          │
                         │  ┌──────▼──────┐    ┌────────▼────────┐ │
                         │  │ IndexedDB   │    │ pdfium Worker   │ │
                         │  │ + OPFS      │    │ + hb-subset     │ │
                         │  │ (file mirror│    │ (real PDF edit) │ │
                         │  │  + offline  │    │                 │ │
                         │  │  edits)     │    │                 │ │
                         │  └─────────────┘    └─────────────────┘ │
                         └────────────┬────────────────────────────┘
                                      │ HTTPS (auth + sync + AI)
                         ┌────────────▼────────────────────────────┐
                         │            apps/server (Node)            │
                         │  Hono routes:                            │
                         │   /auth/{login,logout,session}           │
                         │   /files/{list,open,save,rename,...}     │
                         │   /projects/...   (mirror project-store) │
                         │   /ai/{chat,stream,web-search,...}       │
                         │   /pdf/{save,extract,insert,...}         │
                         │                                          │
                         │   ┌────────────┐  ┌──────────────────┐  │
                         │   │ Postgres   │  │ Object storage   │  │
                         │   │ (users,    │  │ (S3 / R2 / local)│  │
                         │   │  files     │  │ docx/pdf bytes   │  │
                         │   │  index,    │  │ + originals/<h>  │  │
                         │   │  projects, │  │   archive        │  │
                         │   │  chats)    │  │                  │  │
                         │   └────────────┘  └──────────────────┘  │
                         │                                          │
                         │   Genspark AI proxy (HTTPS to gsk)      │
                         │   Web OAuth → mint gsk key per user     │
                         └──────────────────────────────────────────┘
```

### Why these picks

- **Hono** for the server: minimal, types-first, fast, plays well with Vite. Alternative: Fastify. Avoid Express (no first-class TS, dated).
- **Postgres** for metadata (users, file index, projects, chats). SQLite is tempting but multi-tenant SaaS + concurrent writers rule it out.
- **S3-compatible object storage** for file bytes (any of S3, Cloudflare R2, MinIO for self-host). Don't put docx bytes in Postgres.
- **IndexedDB** for client metadata cache + offline edit queue.
- **OPFS** for client file mirror (origin-private, large, fast, sync). File System Access API is *also* used — but only when the user explicitly wants to "Save As" to their real disk; the working copy lives in OPFS.
- **pdfium in a Web Worker** (not main thread): keeps the editor responsive while pdfium rewrites content streams.

### Workspace shape after migration

```
apps/
  docs/         existing — split renderer (web-ready) from main (desktop-only)
  pdf/          existing — same split
  shell/        existing — UNCHANGED, desktop build keeps working
  web/          NEW — web shell (home page, routing, auth state, theme)
  server/       NEW — Hono server (auth, files, projects, ai, pdf)
packages/
  docx-engine/  UNCHANGED
  pptx-engine/  UNCHANGED (still used by docs for blank-docx — verify why)
  pptx-render/  UNCHANGED (same)
  agent-core/   UNCHANGED
  ai-provider/  UNCHANGED
  ai-search/    UNCHANGED — but server becomes the only caller of gsk
  i18n/         UNCHANGED
  ui/           UNCHANGED
  project-store/ UNCHANGED signature, NEW backend implementation
  electron-utils/ UNCHANGED (desktop only)
  web-runtime/  NEW — typed client matching DesktopApi/PdfApi surface
  server-core/  NEW — shared server logic (file model, sync, ai wiring)
```

---

## 2. Resolving the locked constraints

### 2.1 Byte-preserving docx round trip

The round trip is already pure-TS — `packages/docx-engine/src/patch.ts` does the byte-patch in memory on a `Uint8Array` from `JSZip.loadAsync`. **The engine doesn't move.**

What changes is *where the original bytes live*:

- **Desktop today:** `userData/originals/<sha256>.docx` on local disk. The renderer never sees the original; the main process hands it a parsed block tree and saves spliced bytes back.
- **Web:** the original lives in **server-side object storage** keyed by content hash (`originals/<sha256>.docx`, deduplicated naturally). On open, the server returns the parsed block tree *and* the original bytes (or a handle); the renderer holds both in memory; on save, the renderer computes the patched bytes client-side (docx-engine runs in the browser) and uploads them.

This keeps byte-preservation **identical** to today — same code, same JSZip patch, same "Word never notices" guarantee.

**Originals archive location:** server object storage `originals/<sha256>.docx`. Server runs the same dedup + LRU eviction as today's `pruneOriginals` (currently 500 MiB cap, oldest-first). Per-user quotas replace the global cap.

### 2.2 Real PDF text editing (pdfium in a Worker)

Today pdfium runs in the Electron main process via `WebAssembly.instantiate(readFileSync(path))`. The web port is **cleaner**:

- pdfium.wasm is fetched once and cached in the browser Cache API.
- A dedicated `pdf-worker.ts` instantiates pdfium + hb-subset, owns the open document, and accepts edit/render requests via `postMessage`.
- All `apps/pdf/src/main/text-edit.ts`, `image-edit.ts`, `font-subset.ts` logic moves into the worker — almost unchanged, except `readFileSync` becomes `await fetch(wasmUrl).arrayBuffer()`.
- Renderer calls `pdfWorker.editText(...)`, `pdfWorker.extractPages(...)`, etc., through a thin typed facade.

**The font problem (the real risk here):** PDF text editing currently rebuilds glyphs using **the user's installed system fonts** (`apps/pdf/src/main/font-locate.ts` walks `/System/Library/Fonts`, `C:\Windows\Fonts`, `/usr/share/fonts`; `text-edit.ts:119-214` hardcodes fallback paths). Browsers cannot enumerate installed fonts. Resolution:

1. **Bundled font catalog** — ship the same Liberation/Carlito/Caladea/Noto CJK fonts that the docx renderer already bundles (see `apps/docs/src/renderer/fonts/`) as the *primary* PDF edit-font source. These cover the document-font families users actually encounter (Word's Calibri/Arial/Times/Cambria substitutes + CJK).
2. **Local Font Access API** (`window.queryLocalFonts()`) where the browser supports it (Chromium-based). Prompts the user once for font access; exposes installed fonts by name + bytes. Used as a *fallback* when the bundled catalog doesn't have the requested family.
3. **Server-side font metrics service** as a last resort: if neither works, the worker asks the server "give me the bytes for `<family>`", and the server (running on a real OS) returns them. Only used on browsers without Local Font Access (Firefox, Safari).

This is the single biggest UX risk in the plan; see §7.

### 2.3 Offline-capable

Local-first model:

- **Open:** the renderer always loads from OPFS first; if the doc isn't local, fetches from server and caches.
- **Edit:** all edits happen against the OPFS copy. The renderer doesn't block on the network.
- **Save:** writes to OPFS immediately (user-visible "saved" feedback), enqueues a sync op for the server.
- **Sync:** a background queue replays pending saves when online. Last-write-wins with vector clocks per file (simple, single-editor-per-doc — no conflict resolution in v1; if two devices edit offline, the later write wins and the earlier one is preserved as a version).
- **Service Worker** caches the SPA shell + engine packages + wasm for cold-load offline.
- **AI is online-only.** The panel shows a clear "offline" state; this is acceptable per the user's constraint trade-off.

### 2.4 Recommend: keep the desktop build alive

The Electron build (`apps/shell`, `apps/{docs,pdf}/src/main`) keeps working unchanged. Benefits:
- Migration can ship incrementally without stranding desktop users.
- The desktop main process becomes a *reference implementation* for the new server routes (each `ipcMain.handle` documents what the server endpoint must do).
- A/B testing: features can land desktop-first, then migrate.
- The `DesktopApi` interface (typed, already in `apps/docs/src/shared/ipc.ts`) is reused by `web-runtime` — same shape, two implementations.

---

## 3. IPC migration table

The renderer never touches `ipcRenderer` directly — only through the typed `DesktopApi` / `PdfApi` surface exposed via `contextBridge`. **The web port replaces the implementation behind the same interface.** This is the central design move.

The renderer becomes platform-agnostic via a single injection:

```ts
// renderer code (unchanged for both surfaces)
import { getDesktopApi } from '@genoffice/web-runtime'  // or '@genoffice/desktop-api'
const desktop = getDesktopApi()
await desktop.saveDocx(path, bytes)
```

`getDesktopApi()` returns one of:
- **Web** — calls `web-runtime` (fetch + IndexedDB + Worker); the default in `apps/web`.
- **Desktop** — calls `window.desktop` (existing preload bridge); the default in `apps/shell`.

Below: every IPC handler in docs + pdf + shared AI/project, with its new home.

### 3.1 Docs handlers (`apps/docs/src/main/docs-main.ts`)

| Channel | New home | Notes |
|---|---|---|
| `app:get-language` | `localStorage` (renderer) | Already client-side concern; persist `genoffice.language`. |
| `app:get-theme` | `localStorage` + `prefers-color-scheme` | Same. |
| `docs:open` | **FSAccess API** (`window.showOpenFilePicker`) → read bytes → cache OPFS → parse via docx-engine | No server round-trip needed for open-from-disk. |
| `docs:open-path` | server `GET /files/:id/open` (for files already in user's account) | Used for "open recent" / project files. |
| `docs:consume-pending-open` / `docs:consume-new-blank` | **DROP** | Desktop-only (file association from OS). |
| `docs:save` | OPFS write + enqueue sync op → server `PUT /files/:id/bytes` | Server stores new bytes + ensures `originals/<hash>` exists. |
| `docs:write-recovery` | IndexedDB "recovery" store (keyed by file id + ts) | Replace `userData/docs-autosave/` entirely. |
| `docs:save-as` | FSAccess API (`window.showSaveFilePicker`) | User picks the destination; renderer writes bytes directly. |
| `docs:save-new` | FSAccess API → also `POST /files` to register in account | New file: disk + account. |
| `docs:recent` | server `GET /files?filter=recent` + IndexedDB cache | |
| `docs:pick-image` | FSAccess API (`showOpenFilePicker`, `image/*`) | |
| `files:pick` / `files:add` / `files:read` / `files:read-image` / `files:add-pasted-image` | FSAccess API for pick; OPFS for add/pasted; client-side `FileReader` for read | AI attachments — note these are passed to AI which is server-side; uploads go via `POST /ai/attachments`. |
| `docs:print` | **`window.print()`** in a print-styled route | Browser print. |
| `docs:export-pdf` | **Client-side render** (the renderer already paginates with Word-faithful metrics) → print to PDF via browser; OR server-side headless render | Decision: prefer client-side. Browser's "Save as PDF" preserves layout. |
| `docs:print-pdf-buffer` | Render in hidden iframe + `iframe.contentWindow.print()` | Used by export flow. |
| `docs:save-merged-pdf` | FSAccess API (`showSaveFilePicker`) | Merged in renderer via `pdf-lib` (already a dep). |
| `win:new` / `win:list` / `win:focus` | **DROP** for web (single-tab model); or replace with `window.open()` + `BroadcastChannel` for tab-list | v1: drop. Tabs become browser tabs. |
| `docs:view-menu-state` / `docs:close-check-result` / `docs:close-save-result` (`ipcMain.on`) | **Local React state** in `apps/web` shell | No IPC needed; the web shell owns chrome state. |
| `docs:opened` / `docs:renamed` / `docs:teardown` / `docs:close-check` / `docs:close-save-request` / `menu:command` / `app:language-changed` / `app:theme-changed` (pushes to renderer) | **React context** in `apps/web` shell | Same. |

### 3.2 PDF handlers (`apps/pdf/src/main/pdf-main.ts`)

| Channel | New home | Notes |
|---|---|---|
| `pdf:consume-pending` | **DROP** | Desktop-only. |
| `pdf:read-file` | FSAccess API on open; server `GET /files/:id/bytes` for account files; **then loaded into the pdfium Worker** | Worker holds the document. |
| `pdf:save` | Worker computes new bytes → OPFS write + sync → server `PUT /files/:id/bytes` | |
| `pdf:list-page-images` / `pdf:page-image-png` / `pdf:page-preview-png` | **pdfium Worker** calls (renderer ↔ Worker `postMessage`) | Move `apps/pdf/src/main/{text-edit,image-edit}.ts` into `apps/pdf/src/worker/`. |
| `pdf:validate-text-edits` | pdfium Worker | |
| `pdf:list-edit-fonts` | pdfium Worker + bundled font catalog | See §2.2 font strategy. |
| `pdf:extract-pages` / `pdf:insert-pdf` | Worker (uses `pdf-lib` for assembly, already a dep) | |
| `pdf:export-images` | Worker | |
| `pdf:generate-image` | server `POST /ai/generate-image` (it's an AI feature) | |
| `pdf:dirty-changed` / `closeSaveResult` / `saveAsResult` (`ipcMain.on`) | Local React state | |
| `pdf:close-save-request` / `save-as-request` / `save-as-flow` / `language-changed` / `theme-changed` (pushes) | React context | |

### 3.3 Shared AI handlers (owned globally by `docs-main.ts` today)

| Channel | New home | Notes |
|---|---|---|
| `ai:get-settings` / `ai:set-settings` | server `GET/PUT /users/me/ai-settings` + IndexedDB cache | Per-user on server; cached client-side. |
| `ai:gsk-status` | server `GET /auth/status` | Server holds the gsk key; reports whether minted. |
| `ai:gsk-login` | **Web OAuth flow**: server `/auth/login` redirects to Genspark; callback mints gsk key; session cookie set | **Major change** from device-code flow — see §4.3. |
| `ai:stream` / `ai:stream-cancel` | server `POST /ai/stream` via **Server-Sent Events** (or fetch streaming) | Server proxies to Genspark with the user's gsk key; never exposes the key to the browser. |
| `ai:web-search` / `ai:image-search` / `ai:fetch-image` | server `POST /ai/{web-search,image-search,fetch-image}` | Same proxy model. The `safe-remote-url.ts` SSRF guard from `electron-utils` moves to the server. |
| `ai:chat` | server `POST /ai/chat` | Non-streaming path. |
| `ai:stream-chunk` (push) | SSE event from server | |

### 3.4 Project handlers (`registerProjectIpc` — shared)

| Channel | New home | Notes |
|---|---|---|
| `project:list` / `files` / `create` / `rename` / `delete` / `moveFile` / `timeline` | server `GET/POST/PATCH/DELETE /projects/...` | Direct port of `packages/project-store/src/store.ts` logic to server routes + Postgres. IndexedDB caches the project list. |
| `project:resolveChat` / `appendChat` / `loadChat` / `rebindChat` | server `/projects/:id/chats/...` | JSONL append → Postgres row append (or keep JSONL on object storage if you want chat history byte-compatible). |

---

## 4. Component decisions

### 4.1 File storage model

- **Server object storage layout:**
  ```
  originals/<sha256>.docx                 # byte-preservation archive (deduped)
  files/<userId>/<fileId>/head.docx       # current bytes
  files/<userId>/<fileId>/v<ts>.docx      # version snapshot on each save
  ```
- **Postgres `files` table:** `id, user_id, name, ext, content_sha256, original_sha256, size, created_at, updated_at, last_opened_at, project_id?`.
- **Client mirror (OPFS):** `genoffice/files/<fileId>/head.{docx,pdf}` + metadata in IndexedDB. Used for open and as the write target before sync.
- **Quota:** per-user (e.g. 5 GB free tier) enforced server-side; client tracks approximate usage from IndexedDB.

### 4.2 Sync engine

- Each save produces a **sync op** `{fileId, baseHash, newBytes, parentVersion}`.
- Client persists the op to IndexedDB `outbox` table; background flush attempts `PUT /files/:id/bytes` with the op.
- Server rejects if `parentVersion` is not the latest → client refetches, presents "your edit vs. their edit" diff (rare in single-user-per-doc model; almost always a same-user-second-device case).
- **Vector clocks** per file, not CRDT. We're not resolving concurrent edits in v1.

### 4.3 Auth: from device-code to web OAuth

The current flow (`packages/ai-search/src/genoffice-auth.ts`):
1. App calls `POST /device_code` → gets a verification URL + user code.
2. User opens the URL in a browser, approves.
3. App polls `POST /token` until the user approves → 30-day Bearer.
4. App calls `POST /session` + `POST /api/api_tokens/create` to mint a gsk API key.
5. Key stored in `~/.genoffice/auth.json`.

**Web flow:**
1. User clicks "Sign in with Genspark" → redirect to `/auth/login` on our server.
2. Server redirects to Genspark OAuth authorize URL with a PKCE challenge and our callback URL.
3. Genspark redirects back to `/auth/callback?code=...`.
4. Server exchanges code for tokens, **mints the gsk key server-side**, stores it encrypted in Postgres `users.gsk_key` (or a secrets manager for production).
5. Server sets a session cookie (`__Host-genoffice_session`, HttpOnly, SameSite=Strict, Secure).
6. All AI calls now go through our server, which injects the user's gsk key.

**Offline impact:** sign-in requires network. Once signed in, the session cookie + IndexedDB cache let editing work offline; AI requires network.

**Pre-requisite:** confirm with Genspark that the OAuth client can be registered for our redirect URI, and that the existing `office_addin_auth` device-code endpoint has an OAuth/code-flow equivalent. If not, fallback: keep the device-code flow but run it server-side — show the verification URL on a web page, poll server-side, mint the key.

### 4.4 PDF font strategy

Per §2.2, three-tier:
1. **Bundled catalog** (primary) — reuse `apps/docs/src/renderer/fonts/` (Carlito, Caladea, Liberation, Noto CJK). Map the top-30 most-edited font families to these substitutes.
2. **Local Font Access API** (`navigator.fonts.query()`) where available — gives the worker access to *real* installed fonts by family name + bytes. Chromium-only; requires user gesture + permission.
3. **Server-side font lookup** as last resort — `GET /fonts?family=Arial` returns the bytes from the server's OS fonts. Used on Safari/Firefox.

The bundled catalog covers ~90% of real-world cases (Word docs almost always use Calibri/Arial/Times/Cambria + Noto CJK for non-Latin). Local Font Access gets us to ~99%. Server fallback closes the rest.

### 4.5 What dies on web

- `electron-updater` (replaced by deploy model — push new SPA bundle).
- Single-instance lock, file-association routing, OS chrome (`titleBarStyle`, `vibrancy`).
- `shell.openExternal` → `<a target="_blank" rel="noopener">`.
- `dialog.*` → FSAccess API + custom modals.
- Native `Menu` → web menu bar (existing `packages/ui` should have most primitives).
- `nativeImage` → Canvas / `createImageBitmap`.
- `desktopCapturer` → `navigator.mediaDevices.getDisplayMedia` (not needed for docs/pdf in v1).
- `printToPDF` (Electron hidden window) → browser print or client-side render.
- macOS `sample` profiling, Windows `explorer.exe` Recycle Bin, `app.on('open-file')` — drop.

---

## 5. Work breakdown (phased)

Each phase ends in a demoable state. Phases are sequenced; sub-items within a phase are parallelizable.

### Phase 0 — Workspace restructure (1 week)
- [ ] Create `apps/web` (Vite + React, hosts `/home`, `/docs/:id`, `/pdf/:id`).
- [ ] Create `apps/server` (Hono + Drizzle ORM + Postgres).
- [ ] Create `packages/web-runtime` (typed client; `getDesktopApi()` factory).
- [ ] Split `apps/docs/src/renderer` and `apps/pdf/src/renderer` so they can be imported by `apps/web` without their main-process code. Verify the engines they import don't pull electron.
- [ ] CI: ensure desktop build (`apps/shell`) still compiles and runs after the split.
- **Exit:** `apps/web` renders a home page; `apps/server` answers `/health`; `apps/shell` unchanged.

### Phase 1 — Auth + user model (1 week)
- [ ] Postgres schema: `users`, `sessions`, `files`, `projects`, `chats`, `ai_settings`.
- [ ] Server routes: `/auth/login`, `/auth/callback`, `/auth/logout`, `/auth/status`, `GET /users/me`.
- [ ] Genspark OAuth integration (or server-side device-code fallback).
- [ ] `apps/web`: session-aware shell, login redirect, logout.
- [ ] IndexedDB session cache for offline launch.
- **Exit:** user can sign in via browser; session persists; AI status visible.

### Phase 2 — File model + sync (1.5 weeks)
- [ ] Object storage adapter (S3-compatible interface; MinIO for dev).
- [ ] Server routes: `GET /files`, `POST /files` (upload), `GET /files/:id` (bytes), `PUT /files/:id/bytes` (save), `PATCH /files/:id` (rename), `DELETE /files/:id`, `GET /files/:id/versions`.
- [ ] `originals/<sha256>` server-side archive + dedup + per-user quota.
- [ ] `packages/web-runtime`: file API client with IndexedDB mirror + OPFS write + outbox sync.
- [ ] `apps/web`: home page with file list, recent, delete, rename (port of `apps/shell/src/renderer` Home).
- **Exit:** user can sign in, see file list, upload a docx, see it cached locally, rename/delete.

### Phase 3 — Docx editor port (2 weeks)
- [ ] Port `apps/docs/src/renderer` into `apps/web` route `/docs/:id`. Inject `getDesktopApi()` everywhere the renderer currently uses `window.desktop`.
- [ ] `web-runtime` docs implementation:
  - `openDocx` / `openDocxPath` → FSAccess or `GET /files/:id/bytes` → docx-engine parse in renderer.
  - `saveDocx` → OPFS + outbox → server `PUT`.
  - `writeRecoveryCopy` → IndexedDB recovery store. Background flush every 30s (mirror current autosave).
  - `pickImage` / file attachment ops → FSAccess.
  - `print` / `exportPdf` / `printPdfBuffer` / `saveMergedPdf` → browser print + client-side render + `pdf-lib` merge.
  - Menu commands (`menu:command`) → React context in web shell.
- [ ] Byte-preservation test: open a `.docx`, edit one paragraph, save, upload to server, download, diff against original — only the touched paragraph's bytes differ.
- [ ] Recovery test: kill the tab mid-edit, reopen — recovery copy prompts.
- **Exit:** full docx editing in the browser, byte-preserved, with offline edits syncing.

### Phase 4 — PDF editor port (2.5 weeks — the longest phase)
- [ ] Build `apps/pdf/src/worker/pdf-worker.ts`: moves `text-edit.ts`, `image-edit.ts`, `font-subset.ts`, `wasm-path.ts` logic in. Wasm fetched via `fetch().arrayBuffer()` + cached in Cache API.
- [ ] Bundled font catalog for Worker (port `apps/docs/src/renderer/fonts/` or shared package).
- [ ] Local Font Access API integration in Worker (via `navigator.fonts.query()` from main thread, bytes sent to Worker).
- [ ] Server `/fonts?family=...` fallback endpoint.
- [ ] Port `apps/pdf/src/renderer` into `apps/web` route `/pdf/:id`. Replace `window.pdfApi` calls with `pdfWorker.*` + `webRuntime.*`.
- [ ] Real text-edit test: open a PDF with embedded subset font, retype a run, save — content stream rewritten, font subset embedded, opens correctly in Acrobat.
- [ ] Image-edit test: insert/edit an image in a content stream.
- [ ] Extract/insert pages test.
- **Exit:** real PDF text + image editing in browser.

### Phase 5 — AI panel (1 week)
- [ ] Server routes: `/ai/stream` (SSE), `/ai/chat`, `/ai/web-search`, `/ai/image-search`, `/ai/fetch-image`, `/ai/generate-image` (pdf only needs `generate-image`; docs uses search + chat).
- [ ] SSRF guard ported from `electron-utils/src/safe-remote-url.ts` to a server middleware.
- [ ] `web-runtime` AI client: matches existing `aiStream` / `aiChat` / etc. signature, but routes via server. SSE for streaming.
- [ ] AI panel works in docs (block-level edits, snapshots, diffs) and pdf (chat over PDF content).
- [ ] Offline state: panel shows "offline" when network down; chat disabled; editing enabled.
- **Exit:** full AI editing in both editors.

### Phase 6 — Projects, history, polish (1.5 weeks)
- [ ] Server `/projects/*` routes (port `project-store` logic).
- [ ] `web-runtime` project client + IndexedDB cache.
- [ ] Version history UI (`GET /files/:id/versions`).
- [ ] Themes (light/dark/system) — already supported via CSS tokens; web shell wires `data-theme`.
- [ ] i18n — `packages/i18n` works as-is; web shell initializes from `localStorage` + `navigator.language`.
- [ ] Keyboard shortcuts — port desktop menu accelerators to web (Cmd/Ctrl-S, etc.).
- [ ] Print stylesheet pass.
- [ ] E2E test coverage for open → edit → save → reload → byte-diff.
- **Exit:** shippable v1.

**Estimated total: ~10 weeks** for one engineer working full-time with no context-switching. Parallelizable to ~7 weeks with two engineers (Phase 3+4 can overlap; Phase 5+6 can overlap).

---

## 6. File-level change inventory

### New files/directories
```
apps/web/                              ~1500 LOC
  src/
    main.tsx                           app entry, routing
    pages/
      Home.tsx                         port of shell/src/renderer/Home
      DocsEditor.tsx                   mounts docs renderer
      PdfEditor.tsx                    mounts pdf renderer
      Login.tsx
    components/
      MenuBar.tsx                      web menu (replaces native Menu)
      Tabs.tsx                         browser-tab-aware tab strip
      ThemeProvider.tsx
    state/                             auth, theme, language contexts
  vite.config.ts
  package.json

apps/server/                           ~2500 LOC
  src/
    index.ts                           Hono app
    routes/
      auth.ts
      files.ts
      projects.ts
      ai.ts
      pdf.ts
      fonts.ts
    services/
      gsk-proxy.ts                     Genspark HTTPS proxy (replaces @genspark/cli execFile)
      storage.ts                       S3 adapter
      originals.ts                     byte-archive dedup + eviction
      sync.ts                          version conflict checks
    db/
      schema.ts                        Drizzle schema
      migrations/
    middleware/
      ssrf.ts                          ported from electron-utils
      session.ts
  package.json
  drizzle.config.ts

apps/pdf/src/worker/                   ~moved (not new LOC)
  pdf-worker.ts                        entry
  text-edit.ts                         moved from src/main/, fs → fetch
  image-edit.ts                        moved
  font-subset.ts                       moved
  font-catalog.ts                      NEW — bundled font registry
  wasm-loader.ts                       fetch + Cache API

packages/web-runtime/                  ~1000 LOC
  src/
    index.ts                           getDesktopApi(), getPdfApi() factories
    desktop-api-web.ts                 web impl of DesktopApi interface
    pdf-api-web.ts                     web impl of PdfApi
    project-api-web.ts
    storage/
      opfs.ts                          OPFS read/write helpers
      indexeddb.ts                     metadata + outbox + recovery
    sync/
      outbox.ts                        save queue + retry
      clock.ts                         vector clock per file
  package.json

packages/server-core/                  shared between server (and maybe desktop)
  src/
    file-model.ts                      File / Version types (mirrors Postgres schema)
    ai-contract.ts                     request/response shapes shared with web-runtime
```

### Modified files
- `apps/docs/src/renderer/**` — replace direct `window.desktop` access with `getDesktopApi()`. Small mechanical change once `DesktopApi` interface is shared. Mostly one-shot grep-and-replace per file.
- `apps/pdf/src/renderer/**` — same, with `getPdfApi()`.
- `apps/docs/src/main/docs-main.ts` — keep for desktop build; **refactor** to share file/save logic with `apps/server` (extract a `docs-file-service` shared module). Avoids two implementations.
- `apps/pdf/src/main/pdf-main.ts` — same.
- `packages/project-store/src/store.ts` — extract an interface; provide two implementations (fs for desktop, Postgres for server).
- `packages/ai-search/src/gsk.ts` — server uses the HTTPS paths directly, drops `execFile` of `@genspark/cli`. Keep `execFile` path for desktop.
- `tsconfig.base.json` — add path aliases for new packages.
- Root `package.json` — add workspace scripts (`dev:web`, `dev:server`, `build:web`, `build:server`).

### Deleted files
- None in v1. The desktop code paths stay. They become effectively dead for web users but live for desktop builds.

### Untouched
- `packages/docx-engine/`, `packages/pptx-engine/`, `packages/pptx-render/`, `packages/agent-core/`, `packages/ai-provider/`, `packages/i18n/`, `packages/ui/`, `packages/electron-utils/`, `packages/file-parse/`.
- `apps/shell/`, `apps/sheets/`, `apps/slides/`, `apps/markdown/` — untouched.

---

## 7. Risks & mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| **PDF font fallback fails on a font family the bundled catalog doesn't cover** | High | Three-tier strategy (§4.4). Test against a corpus of real PDFs from Fortune-500 doc sets *before* Phase 4 starts (Phase 0.5 spike). |
| **pdfium Worker performance** on large PDFs | Medium | Worker holds the doc resident (matches today's main-process model). Stream pages, don't load all at once. Profile against 200+ page PDFs. |
| **Genspark OAuth doesn't exist** (only device-code) | Medium | Fallback in §4.3: server-side device-code flow. User sees URL on web page, server polls. Worse UX, but works. Confirm with Genspark in Phase 1. |
| **OPFS quotas** (browsers cap origin storage; user could blow through 5 GB) | Medium | Origin storage can be persisted (`navigator.storage.persist()`). Show quota UI; evict least-recently-opened files client-side. Server is source of truth, so client eviction is safe. |
| **Sync conflicts** (same user, two devices, offline) | Low in v1 (single-editor-per-doc) but visible | Vector clock + version snapshot of the loser. UI shows "your unsaved edit was preserved as a version." |
| **byte-preservation regression** (someone refactors docx-engine's patch.ts and breaks the diff) | High | Add a regression test in Phase 3 that opens → edits → saves → diff-checks against a fixture corpus. Same test runs in CI for both desktop and web builds. |
| **SSE through corporate proxies** breaks AI streaming | Low-Medium | SSE has good proxy support; fallback to fetch-with-streaming-body if needed. |
| **CORS** for the AI proxy and object storage | Low | Server proxies AI (browser never calls Genspark directly). Object storage accessed only via server (signed URLs), no CORS issue. |
| **Browser print fidelity** differs from Electron print | Medium | Phase 6 polish. Browser print CSS is well-trodden territory (Notion, Google Docs). May need a print-specific route. |
| **Offline AI** is jarring to users who expect AI everywhere | Low | Clear UI state. Document the trade-off in onboarding. |

---

## 8. Out of scope (v1)

- Sheets, slides, markdown editors.
- Real-time multi-user collaboration (CRDT, presence). Architecture leaves room; not shipping.
- Mobile/responsive (desktop-class browsers only in v1).
- Public sharing links (anyone-with-link can view). Add in v1.1.
- Comments / tracked-changes UI sync (the docx engine supports them; web UI can light up later).
- End-to-end encryption of stored files. Server-side at-rest encryption yes; E2E no (would break AI panel and server-side rendering).
- Migration tool from desktop `userData/` to web account (nice-to-have follow-up).

---

## 9. Open questions (need answers before Phase 1 starts)

1. **Multi-tenant or single-tenant?** Plan assumes multi-tenant SaaS (one Postgres, shared object storage, `user_id` on every row). Single-tenant simplifies nothing meaningful and limits future options.
2. **Hosting target?** Affects Phase 0 deployment scripts. Candidates: Vercel (frontend) + Fly.io/Render (server) + R2 (storage); or all-on-Fly.io; or self-hosted Docker Compose.
3. **Backend framework confirmation.** Plan picks Hono. If team has strong Fastify/NestJS preference, swap in Phase 0 (no downstream impact).
4. **OAuth client registration with Genspark.** Phase 1 hard-blocker. Need to confirm Genspark supports our redirect URI, or commit to the server-side device-code fallback.
5. **Quota/pricing model.** Affects Postgres schema (quotas, usage tracking) and UI. Free tier assumed at 5 GB.
6. **Brand.** The repo notes GenOffice/Genspark are trademarks of Mainfunc; forks should rebrand. Web deployment needs a name + domain decision.

---

## 10. Spike work to de-risk before Phase 1

Three one-day spikes that resolve the biggest unknowns cheaply:

1. **PDF font spike:** Pick 20 real-world PDFs (Word exports, Adobe-created, scanned-then-OCR'd). For each, identify the font families used. Check coverage against the bundled Carlito/Caladea/Liberation/Noto catalog. **Exit criterion:** ≥85% family coverage, or expand the catalog.
2. **Genspark OAuth spike:** Confirm with Genspark whether OAuth code-flow can be registered for a web redirect, or whether the device-code flow is the only option. **Exit criterion:** a working sign-in on `localhost`.
3. **pdfium-in-Worker spike:** Minimal Worker that loads pdfium.wasm, opens a small PDF, and writes a text edit. Confirms the wasm-in-Worker pattern works end-to-end before committing to Phase 4. **Exit criterion:** save bytes from the Worker are byte-identical to a desktop save of the same edit.

---

## 11. Success criteria

The migration is done when:

- A user can sign in at `https://<app>/`, see their file list, open a `.docx`, edit a paragraph, save, and re-opening shows the edit.
- The same `.docx`, when downloaded and opened in Microsoft Word, shows the byte-preservation guarantee (only the edited paragraph's bytes differ from the original).
- A user can open a `.pdf`, retype a run of text, save, re-open, and the text is preserved with subset fonts embedded.
- The user can disconnect from the network, continue editing, reconnect, and the edits sync.
- The desktop Electron build (`apps/shell`) still builds and runs unchanged.
- Phase 4 spike exit criteria pass.
- E2E tests cover: sign-in, upload, docx edit + byte-preservation, PDF edit, offline sync.

Not required for "done": real-time collab, mobile, comments sync, share links.
