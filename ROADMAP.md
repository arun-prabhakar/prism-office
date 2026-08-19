# PrismOffice — Public Roadmap

> Status: **living document** — updated as the product evolves. Contributions
> welcome: open an issue to discuss a direction, or jump into the
> [How to help](#how-the-community-can-help) section.

## Vision

**The document editor you embed, not the one you adopt.**

PrismOffice is a self-hosted, embeddable document editor for the web. An
integrator deploys it in their infrastructure, embeds it via an iframe +
JavaScript SDK, and their users open and edit `.docx`, `.pdf`, and `.xlsx`
files in the browser — the file never leaves the integrator's environment.

We are not building another office suite. We are building the **editor
component** that other products embed: a stateless service that does one
thing perfectly — preserve file fidelity across the round trip — and gets
out of the way.

## Why this exists

- **Byte-preserving round trip is rare and hard.** Most web "docx editors"
  convert to an intermediate format on open and rebuild on save. Layouts
  drift, tracked changes vanish, styles break. PrismOffice patches only the
  paragraphs you touched; everything else survives byte-for-byte.
- **Self-hosted is a requirement, not a preference.** Healthcare, legal,
  finance, government — organizations that cannot send documents through a
  third-party SaaS. PrismOffice runs in their Docker cluster; the file never
  transits an external endpoint.
- **Embeddability is the product.** The SDK + iframe architecture means any
  web app gets a document editor in one `<script>` tag. No React components
  to integrate, no framework lock-in. Just sign a config and embed.

## Why now

- **A well-known API shape reduces adoption friction.** Our contract follows
  established patterns that integrators already understand. Migration cost
  is near-zero.
- **wasm makes real editing possible in-browser.** PDFium for PDF, HarfBuzz
  for text shaping, Univer for sheets — the heavy lifting runs as wasm, not
  as a server-side rendering farm.
- **Privacy regulation is pulling.** GDPR, LGPD, HIPAA, the EU AI Act —
  organizations need to keep documents on-premises. The cloud-only model is
  hitting regulatory walls.

## State of the code (honest diagnosis)

**Real strengths**

- Mature, battle-tested format engines: byte-preserving docx round-trip
  (dirty-block patching, SHA-256 drift checks), pdfium-based real PDF
  content-stream editing, SheetJS + Univer for sheets.
- Stateless architecture: no database, no session store, no file system.
  The service fetches from your URL, streams to the iframe, POSTs saves
  back. Horizontally scalable by design.
- Two-secret JWT model: `PRISMOFFICE_BROWSER_SECRET` signs the config the
  iframe accepts; `PRISMOFFICE_OUTBOX_SECRET` signs server-to-server
  fetch/save URLs. Tampered tokens cannot redirect saves or read documents.
- Desktop/web code unification: identical renderer code, only the
  `DesktopApi` bridge swaps (Electron IPC vs web-runtime HTTP). The sheets
  web port proves this pattern works.

**Structural gaps**

1. **Sheets web port is incomplete.** Phase 1 (open/view small xlsx via
   SheetJS) is verified. Phase 2 (port the Rust xlsx-sidecar to
   wasm-in-Worker) is decided but not started. Saves support only a subset
   of operations; unsupported ops fail atomically (fail-closed, never
   corrupts).
2. **PDF web editing is viewer-only.** The pdfium Worker integration
   (Phase 3.1) is not started. Text and image editing are stubbed.
3. **AI proxy routes are stubbed.** The `/ai/*` endpoints return 501. The
   web runtime adapters throw on AI operations. AI integration is delegated
   to the integrator, but the plumbing is not wired.
4. **Test coverage is uneven.** Engine packages have strong coverage
   (docx-engine 71 files, sheets 110). But `packages/web-runtime` (the
   entire web bridge layer) and `packages/editor-contract` have zero tests.
   Browser-level e2e for the SDK/iframe flow is manual verification only.
5. **Bundle size is a deployment friction.** The sheets main chunk is 9.8 MB
   (2.7 MB gzip). Builds OOM on hosts with <4 GB RAM. Chunk-splitting is
   deferred.

## Principles

1. **File fidelity is sacred.** The round trip is the product. Every save
   must pass SHA-256 verification; untouched bytes must survive.
2. **Stateless by design.** No database, no session store, no file system.
   The service is a proxy with format intelligence.
3. **Embeddable, not adoptable.** The SDK + iframe boundary is hard. The
   editor never reaches into the host app; the host app controls the
   document lifecycle.
4. **Self-hosted first.** No cloud account required. No telemetry unless
   opted in. No external dependencies at runtime.
5. **Fail closed.** Unsupported operations throw atomically. The service
   never silently corrupts a file.

---

## Now — Phase 1 · Sheets Web Port (in progress)

> **Outcome:** *Enable integrators to embed a working spreadsheet editor
> that opens, views, and saves small-to-medium xlsx files in the browser —
> without a Rust sidecar.*

| Initiative | Why (outcome) | Status |
| --- | --- | --- |
| SheetJS in-browser open/view for small xlsx | Core value: users see their data without a server-side engine | ✅ verified |
| SDK event chain (open, ready, state change, save) | Integrators get the same lifecycle as docs/pdf | ✅ verified |
| Save via SheetJS `buildWorkbookBytes` | Mutations persist across sessions | 🔄 partial (merge/unmerge, row/col size, hide, rename/add sheet; others fail-closed) |
| AI panel + Genspark branding removal for web | Web embeds should not show desktop-only chrome | ✅ done |
| File upload routing for xlsx in reference host | Integrators can test the full flow | ✅ done |
| English-only docx fixtures | Test fixtures should not contain non-English content | ✅ done |
| Merge `feat/sheets-web-port` to main | First-class sheets support in the web service | 🔄 in progress |

**Exit criteria:** an integrator can embed the sheets editor, upload an xlsx
file, view data, make supported edits, and save — with unsupported ops
failing cleanly (never corrupting).

---

## Next — Phase 2 · Sheets wasm Engine + PDF Editing

> **Outcome:** *The sheets editor handles large files and full formula
> recalculation in the browser. The PDF editor supports real text and image
> editing — not just annotations.*

### Track — Sheets wasm Engine

| Initiative | Why (outcome) | Status |
| --- | --- | --- |
| IronCalc bytes-entry de-risk spike | Validate that the Rust crate can accept/return bytes without filesystem | 💡 planned (1-day spike) |
| `content_path: PathBuf` → inline bytes refactor | Remove filesystem dependency from the engine boundary | 💡 planned |
| Cooperative yielding (no SharedArrayBuffer) | The engine must not block the main thread on large files | 💡 planned |
| OPFS chunk cache | Large files need streaming reads without loading everything into memory | 💡 planned |
| Full save via OOXML patching | All mutations (styles, CF, DV, pivots) persist correctly | 💡 planned |

**Exit criteria:** a 10 MB xlsx with formulas opens, edits, and saves
correctly in the browser; the main thread never blocks for >100ms.

### Track — PDF Web Editing

| Initiative | Why (outcome) | Status |
| --- | --- | --- |
| PDFium in a Web Worker | Real content-stream text editing with original fonts preserved | 💡 planned |
| Image bake (replace embedded images) | The most-requested PDF editing feature | 💡 planned (stubbed, needs Worker) |
| Form filling + signature support | Legal and business use cases require forms | 💡 planned |
| Annotation overlay (highlights, notes) | Collaborative review workflows | 💡 planned (desktop has it; web bridge needed) |

**Exit criteria:** a user can open a PDF, retype text in a paragraph,
replace an image, fill a form field, and save — with the output being a
real, re-editable PDF (not a flattened image).

---

## Later — Phase 3 · Developer Platform + AI Integration

> **Outcome:** *Make PrismOffice the default document editor component for
> web applications — with a mature SDK, AI capabilities, comprehensive docs,
> and a plugin model for custom integrations.*

| Initiative | Why (outcome) | Status |
| --- | --- | --- |
| AI integration layer | Integrators need to plug in their own LLM providers (OpenAI, Anthropic, local models) for content generation, summarization, and assisted editing | 💡 planned |
| SDK v2: programmatic control | Integrators need to read/write content, insert images, manage history from the host page | 💡 planned |
| Webhook event system | Integrators need to react to document events without polling | 💡 planned (callback protocol exists; event forwarding is partial) |
| Theme customization API | Integrators need the editor to match their product's design system | 💡 planned (light/dark works; custom themes need API) |
| Slides editor web port (`.pptx`) | Complete the format trifecta — the desktop app is mature; web port follows the sheets pattern | 💡 planned |
| Plugin/extension system | Integrators need to add custom toolbar buttons, menu items, and document transforms without forking | 💡 ideas |
| Offline support | Mobile and field workers need editing without connectivity | 💡 ideas |
| Mobile-optimized UI | Responsive layout for tablet/phone embedding | 💡 ideas |

**Exit criteria:** an integrator can embed PrismOffice, customize the
theme, react to events from the host page, and build a custom plugin —
all without forking the repo.

---

## Future — Phase 4 · Collaboration

> **Outcome:** *Enable real-time co-editing in embedded documents — so
> multiple users (and agents) can work in the same document simultaneously.*

| Initiative | Why (outcome) | Status |
| --- | --- | --- |
| CRDT-based collaborative editing | Real-time co-editing without a proprietary cloud | 💡 ideas |
| Presence and cursor sharing | Users see who is editing where | 💡 ideas |
| Comment threads and review | Collaborative review without leaving the editor | 💡 ideas (desktop has comments; web needs them) |
| Version history and branching | Safe experimentation without losing work | 💡 ideas |

**Exit criteria:** two users co-edit the same document live, with a full
audit trail of who changed what.

---

## What we are deliberately NOT doing (yet)

- **Cloud lock-in** — no mandatory accounts; the integrator controls the
  document lifecycle.
- **Proprietary formats** — OOXML round-trip fidelity is non-negotiable.
- **Replacing the integrator's AI** — AI is delegated to the host app via
  the SDK; we provide the plumbing, not the brain.
- **Building a full office suite** — we embed, not compete. Slides and
  markdown editors exist in the codebase but are not the web product focus.

---

## Success metrics

| Phase | Metric |
| --- | --- |
| 1 | Integrator embeds sheets editor in <30 min; supported edits save correctly; unsupported ops fail cleanly |
| 2 (sheets) | 10 MB xlsx opens/saves in-browser; main thread blocks <100ms; full formula recalc |
| 2 (pdf) | Text/image editing produces real re-editable PDF; original fonts preserved |
| 3 | Integrator customizes theme + reacts to events + builds plugin without forking |
| 4 | Two users co-edit live with full audit trail |

---

## How the community can help

### Areas & labels

| Label | Best for |
| --- | --- |
| `good-first-issue` | Small, well-scoped: engine bugs, test fixtures, docs |
| `help-wanted` | Bigger features, owner welcome |
| `sheets` | Sheets web port work (wasm, save, engine integration) |
| `pdf` | PDF web editing (pdfium Worker, annotations) |
| `sdk` | SDK improvements, host-page integration patterns |
| `quality` | Tests, fuzzing, docs, tooling |

### Good starting points

- `packages/web-runtime` — the web bridge layer (docs-api, pdf-api,
  sheets-api). **Zero tests today; high-impact contribution.**
- `packages/editor-contract` — the typed contract shared by SDK, service,
  and editors. **Zero tests today.**
- `apps/reference-host` — the sample integrator. Copy this pattern; it is
  documentation-as-code.
- `apps/sheets/src/renderer` — the sheets renderer (Univer-based).
- `packages/sdk-shared` — the JavaScript SDK loaded by the host page.

### Where your profile fits

| Profile | Where to start |
| --- | --- |
| First PR | Test fixtures, docs improvements, `good-first-issue` bugs |
| TypeScript/React | SDK v2, theme API, event system, web-runtime tests |
| Rust/wasm | Sheets xlsx-sidecar wasm port (Phase 2) |
| PDF expertise | pdfium Worker integration (Phase 2) |
| DevOps/Docker | Dockerfile improvements, CI/CD, bundle optimization |
| Docs/i18n | API reference, integration guides, translations |

---

*Roadmap is a direction, not a promise — items move between phases as we
learn. Questions? Open an issue with the `help-wanted` or `sheets` label.*
