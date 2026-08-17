# Sheets Web Port — Status & Phase 2 Reference

> **Current as of:** post-upstream-merge, Phase 1 **verified end-to-end**.
> This file records the port's architecture decision, verified state, and the
> Phase 2 (wasm) roadmap. Read before continuing sheets work.

---

## 1. Current state — all green

- **Branch:** `feat/sheets-web-port` (5 commits: scaffold, Phase 1, boot fixes,
  upstream merge, rebrand sweep). Based on `main` @ `f7ec92f`; `main` itself has
  advanced (089483b+) — rebase/merge decision pending. **Not yet pushed.**
- **Phase 1 VERIFIED end-to-end:** reference host `/sheets` → SDK handshake →
  `/fetch-document` 200 → SheetJS in-browser parse → Univer renders.
  Evidence: `onAppReady → onDocumentReady → onDocumentStateChange dirty=false`,
  status line "Streaming sample.xlsx: 4 rows available", Sheet1 tab, 3 canvases,
  console clean. Docs editor re-verified after the merge (full event chain).
- **Tests/typecheck:** editor-service 9/9; web-runtime + docs + pdf typechecks
  clean; all three web bundles build (`docs`, `pdf`, `sheets`).
- **Upstream merged:** 38 commits (08-13/08-16 snapshots + engine fixes);
  259 conflicts resolved (see §6 for the playbook used).

## 2. Build memory requirements (solved)

The sheets bundle (9 `@univerjs/preset-sheets-*` packages) OOMs small hosts:

```bash
# this box: 3.7 GB RAM + an 8 GB swap file added at /swapfile2
NODE_OPTIONS="--max-old-space-size=8192" npm run build:web -w @prismoffice/sheets
```

Builds take 2–4.5 min. On ≥8 GB hosts the swap file is likely unnecessary.
Main chunk ≈ 9.8 MB (2.7 MB gzip); chunk-splitting via `manualChunks` is a
future optimization, not a blocker.

## 3. What works on the web port (sheets)

| Surface | Status |
|---|---|
| Open small `.xlsx` (SheetJS parse → `WorkbookFile`) | ✅ real |
| View cell values/formulas/merges (`readWorkbookRange`) | ✅ real |
| Boot (lang/theme/queued-open), SDK events, `closeWorkbook` | ✅ real |
| `imageSearch` / `fetchImage` | ✅ real (editor-service `/ai/*` proxy) |
| AI settings/status (boot-safe degraded defaults) | ✅ resolve, not throw |
| Recalc, **save**, media/pivot/chart reads, styles/CF/DV mapping | ❌ `throw 'not supported on the web port (yet)'` |
| `generateImage`, chat attachments | ❌ stubbed |

Same maturity for docs/pdf web ports: open/view/edit verified; pdf's 14 new
page-op methods (upstream) are canceled/error stubs; saved signatures return
`[]`.

## 4. Architecture decision — wasm, staged (Oracle; already decided)

**Port `xlsx-sidecar` (Rust) to wasm in a browser Worker — the pdfium
pattern — in two phases. Do NOT build a server-side sidecar.**

- **Why not server-side (A):** `read_range` fires on every viewport scroll and,
  for streamed workbooks, has no fallback. Server-side = 100–300 ms
  cross-region RTT on the most scroll-sensitive path + sticky sessions +
  breaks the "stateless, horizontally scalable" positioning in README/
  INSTALLATION.md.
- **Why not hybrid:** browser already has the bytes from `/fetch-document`;
  batch commands compile to wasm as easily as to a server. Pure B.
- **Phase 1 (done):** no Rust; small workbooks fully in-browser (SheetJS +
  Univer's JS formula engine). Validates demand before the expensive port.
- **Phase 2:** wasm port for large/streamed workbooks + recalc fallback.

### Phase 2 porting risks (budget these)
1. **Threading is the real risk, not the deps.** `ensure_parser` (lib.rs:663)
   spawns OS threads; `read_range` (lib.rs:703) blocks on a Condvar. Needs a
   cooperative chunked-yielding rewrite. Do NOT adopt wasm threads /
   SharedArrayBuffer (COOP+COEP header tax on self-hosters).
2. `save_archive`'s wire contract takes `content_path: PathBuf` (archive.rs:43)
   → carry bytes inline, bump `PROTOCOL_VERSION`, keep desktop on v1.
3. IronCalc `load_from_xlsx(path)` is path-based (recalc.rs:195) — verify a
   bytes/reader entry point exists in 0.7.1 **before** scheduling (the
   de-risk spike).
4. On-disk chunk cache → OPFS (or in-memory with strict cap); mtime+size
   recalc invalidation → version counter; cap resident models at 1.

## 5. Rust sidecar facts (Phase 2 target)

- `apps/sheets/native/xlsx-engine/` — crate `xlsx-sidecar`; calamine 0.36,
  ironcalc 0.7.1, quick-xml, zip 4 (deflate-only). `lib.rs` (sessions) +
  `main.rs` (stdio dispatcher) — already library-shaped.
- IPC: stdio JSON-lines, 12 commands. Batch: `open close convert_workbook
  archive_manifest read_entries scan_entries save_archive`. Live:
  `read_range` (per-scroll), `read_formula_cells`, `read_media`,
  `recalc_cells` (per-edit fallback, debounced 600 ms).
- Sole consumer: `apps/sheets/src/main/xlsx-sidecar-client.ts` (Electron main).
  Editor-service has zero references.

## 6. Upstream-merge playbook (used for 08-16 merge; reuse next time)

1. `git fetch upstream && git merge upstream/main --no-edit` → 259 conflicts.
2. **Bulk (247 files):** `git checkout --theirs`, then guarded sed:
   `GenOfficeSansKR/SerifKR → __FONT_*` guards, `@genoffice/ → @prismoffice/`,
   `GenOffice → PrismOffice`, restore guards. Desktop `GENOFFICE_*` env vars
   stay untouched.
3. **Keep ours:** `package-lock.json`, README/CLAUDE/SECURITY/CONTRIBUTING,
   root `package.json` (ours is the superset — web-port workspaces).
4. **Manual:** `apps/sheets/package.json` (theirs + re-apply `exports` +
   `build:web`), docs/pdf `package.json` (theirs + re-apply `exports` +
   `build:web`), `ci.yml` (theirs + rebrand), docs `App.tsx`/`Ribbon.tsx`/
   `ribbon-tabs.tsx` (theirs + re-apply `aiAvailable` gate — see below),
   `markdown-skill.ts` (theirs + rebrand).
5. **Sweep auto-merged files** for `@genoffice/` + `GenOffice` (same guarded
   sed), `npm install`, fix contract drift (new/removed interface methods),
   re-typecheck, re-run editor-service tests, rebuild all three bundles,
   browser-verify both editors.

### Post-merge adaptations (08-16 merge)
- Upstream **removed** `DesktopApi.getEditorMode` (docs) — the old
  `aiAvailable` probe. Replacement: web entries set `window.__prismofficeWeb`
  (declared in `apps/docs/src/renderer/env.d.ts`); `App.tsx` uses
  `window.__prismofficeWeb !== true`. Immune to contract churn.
- New sheets `DesktopApi` methods implemented (`imageSearch`, `fetchImage`) or
  stubbed (`generateImage`); workbook schema gained `activeTab`,
  `rowBreaks`/`colBreaks`/`protectedRanges` (filled in `sheets-xlsx.ts`).
- PdfApi gained 14 methods (page ops/signatures/username) — stubbed in
  `pdf-api.ts`. pdf renderer worker now imports `buffer` (polyfill dep added)
  and font-metrics needs `mkdirSync`/`writeFileSync` (fs-shim no-ops).

## 7. Remaining roadmap

1. **Phase 2 (wasm):** 1-day de-risk spike → byte-buffer refactor →
   cooperative indexer → OPFS chunk cache → wire into `sheets-api.ts` for
   large workbooks + recalc. (All details in §4.)
2. **Save on the web** (sheets): journaled edits → OOXML patch. Currently
   `saveWorkbookEdits` throws; the SheetJS write path is a quick degraded
   option, byte-preserving patch is the real goal.
3. **Chunk-splitting** the sheets bundle (`manualChunks`) for load time.
4. **Merge branch → main** (rebase decision), push to origin.
5. Pre-existing web-port typecheck debt (reference-host `uiTheme` cast,
  docs `main-web.tsx` duplicate decl + `.tsx` import).

## 8. Key file map

| File | Role |
|---|---|
| `apps/sheets/vite.web.config.ts` | Web build → `static/editor/sheets/` |
| `apps/sheets/src/renderer/{index.web.html, main-web.tsx}` | Web entry (handshake → `window.desktopApi` → `main.tsx`) |
| `packages/web-runtime/src/sheets-api.ts` | `createSheetsApi(): DesktopApi` (real + degraded) |
| `packages/web-runtime/src/sheets-xlsx.ts` | Phase 1: SheetJS → `WorkbookFile`/`readRange` |
| `packages/web-runtime/src/{docs-api,pdf-api}.ts` | Docs/pdf bridges (same pattern) |
| `apps/docs/src/renderer/env.d.ts` | `window.__prismofficeWeb` marker decl |
| `packages/editor-contract/src/index.ts` | `DocumentType` includes `'sheets'` |
| `apps/editor-service/src/server.ts` | `/editor/{word,pdf,sheets}` + `/ai/*` routes |
| `apps/reference-host/src/server.ts` | `/docs` `/pdf` `/sheets` samples (xlsx via SheetJS) |
| `apps/sheets/native/xlsx-engine/` | Rust crate (Phase 2 target) |
| `apps/sheets/src/shared/desktop-api.ts` | The 45-method sheets `DesktopApi` contract |
