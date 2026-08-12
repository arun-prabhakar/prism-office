# PrismOffice

**Self-hosted, embeddable document editor for the web.**

[![License: Apache-2.0](LICENSE)](LICENSE)

PrismOffice is a document editor you run on your own infrastructure and embed
into your web application via an iframe + JavaScript SDK — the same deployment
shape as ONLYOFFICE Docs or Collabora. Your users open and edit Word (`.docx`)
and PDF (`.pdf`) documents right in the browser; the file never has to leave
your environment.

It is a web port of the [GenOffice](https://github.com/genspark-ai/genoffice)
editing engines: the same byte-preserving `.docx` round trip and the same
pdfium-based real PDF editing, packaged as a stateless service you self-host
and script from the host page.

- **Deploy once, embed anywhere.** One container serves every document session;
  your host app loads the SDK and points it at a document URL.
- **Real `.docx` editing, byte-preserving.** Only the paragraphs you touched are
  regenerated; everything else is kept byte-for-byte, so files round-trip
  cleanly through Microsoft Word.
- **Real PDF editing.** Retype text and edit images in the page content stream
  with original fonts preserved — not cover-up annotations.
- **JWT-secured config.** The editor config your host page hands to the iframe
  is signed, so a tampered or stolen token can't redirect saves or read
  documents the user shouldn't see.
- **Light / dark editor chrome.** Document content stays fixed (white paper in
  both themes); only the surrounding UI follows the theme.

## How it fits together

```
your host app                  PrismOffice editor service            browser
─────────────                  ──────────────────────────            ───────
 <div id="editor">      ─┐
 <script                │  loads /sdk/<bundle>.js          ┐
   src="/sdk/...js">    │                                  │
                        │  new PrismOfficeAPI.DocEditor(   │  iframe loads
                        │       'editor', signedConfig)    ├─► /editor/word/  (docs SPA)
                        │           │                       │  /editor/pdf/   (pdf SPA)
                        │           ▼                       │
                        │  iframe + postMessage handshake   │
                        │  (origin-checked, JWT-verified)   │
                        │           │                       │
  callbackUrl ◄─────────┴──── /track (save / status) ──────┘
```

Four pieces ship in this repo:

| Path | What it is |
| --- | --- |
| `apps/editor-service` | The stateless [Hono](https://hono.dev/) server you deploy. Serves the SDK bundle, the editor SPAs, proxies document fetch/save between the iframe and your host app, and signs/verifies JWT config. Horizontally scalable. |
| `packages/sdk-shared` | The JavaScript SDK (`PrismOfficeAPI.DocEditor`). Loaded from the editor service via a `<script>` tag; manages the iframe, origin-checks messages, exposes events and methods to the host page. |
| `apps/docs` · `apps/pdf` | The editor SPAs (the word processor and PDF editor), built as web bundles and served by the editor service at `/editor/word/` and `/editor/pdf/`. |
| `apps/reference-host` | A minimal reference integrator — a Hono app that signs a config, renders the host page, and embeds the editor. Copy this pattern; it is documentation-as-code, not a product. |

## Quick start

Deploy the service and open the reference host against it — both take under a
minute with Docker or Node. See **[INSTALLATION.md](INSTALLATION.md)** for the
full guide.

```bash
# 1. Run the editor service (Docker)
docker build -t prismoffice -f apps/editor-service/Dockerfile .
docker run -p 3000:3000 \
  -e PRISMOFFICE_BROWSER_SECRET=$(openssl rand -hex 32) \
  -e PRISMOFFICE_OUTBOX_SECRET=$(openssl rand -hex 32) \
  prismoffice

# 2. Embed in your page
<script src="https://editor.internal/sdk/genoffice.js"></script>
<script>
  const editor = new PrismOfficeAPI.DocEditor('placeholder', {
    documentType: 'word',
    document: { key: 'doc-1', url: 'https://your-app.com/files/doc-1.docx',
                fileType: 'docx', title: 'Report.docx' },
    editorConfig: { mode: 'edit', callbackUrl: 'https://your-app.com/track',
                    user: { id: 'alice', name: 'Alice' } },
    events: { onDocumentReady: () => console.log('loaded') },
    token: '<signed JWT — see INSTALLATION.md>',
  })
</script>
```

For the full SDK reference (config fields, events, methods, permissions, JWT
signing, the callback protocol), see
**[`apps/editor-service/docs/api-reference.md`](apps/editor-service/docs/api-reference.md)**.

## Why the round trip matters

Most web "docx editors" convert to an intermediate format on open and rebuild
the file on save — layouts drift, tracked changes vanish, styles break, and
Microsoft Word complains about the result. PrismOffice does not.

```
open docx ─► archive the original by hash (never touched)
          ─► parse word/document.xml into a block tree
             (each block anchored to its original XML slice)
          ─► Tiptap editor streams manual + AI edits, dirty tracking per block
save      ─► regenerate only dirty blocks → OOXML fragments
             (referencing existing styles only)
          ─► splice fragments into the original document.xml;
             untouched blocks keep their original bytes
          ─► repack the zip — every other entry copied byte-for-byte
```

The original file is the source of truth; edits are applied as narrow patches.
Everything the editor didn't touch survives the round trip unchanged.

PDF editing follows the same principle: text and image edits rewrite the
page's content stream through [PDFium](https://pdfium.googlesource.com/pdfium/)
(wasm) with subset-embedded original fonts, so the saved PDF is a real,
re-editable PDF rather than a flattened image with annotation overlays.

## Development

```bash
npm install

# Build the SDK bundle → apps/editor-service/static/sdk/
npm run build:sdk -w @genoffice/editor-service

# Build the editor SPA bundles → apps/editor-service/static/editor/{word,pdf}/
npm run build:web -w @genoffice/docs
npm run build:web -w @genoffice/pdf

# Run the editor service (port 3000) and the reference host (port 3001)
npx tsx apps/editor-service/src/server.ts &
npx tsx apps/reference-host/src/server.ts

npm run typecheck    # tsc --noEmit across every workspace
npm test             # engine + app unit tests
```

The web renderers are Vite builds that output directly into the editor
service's static directory. After changing renderer source, rebuild the
affected app; after changing SDK source, rebuild the SDK.

## FAQ

**Is PrismOffice free?**
Yes — Apache-2.0, no trial, no paid tier for the service itself.

**What file formats are supported?**
`.docx` (byte-preserving open/save) and `.pdf` (real content-stream text and
image editing). The wider office format support from the upstream engines is
not part of the web service.

**Where do documents live?**
Nowhere inside PrismOffice. The editor service is stateless: it fetches the
document from the URL in your signed config, streams it to the iframe, and
POSTs saves back to your `callbackUrl`. You keep the files; the service only
ever holds a document briefly in memory while a session is open.

**Does it need a GPU / special runtime?**
No. PDFium and HarfBuzz ship as wasm; the service is a single Node process.
Run one replica, or many behind a load balancer.

**How are documents secured?**
The editor config (document URL, callback URL, permissions, user identity) is
JWT-signed with a shared HS256 secret. The iframe only honours a config whose
signature verifies against the service's `PRISMOFFICE_BROWSER_SECRET`, so a
tampered token cannot redirect a save or point the editor at a file the user
should not reach.

## Acknowledgements

PrismOffice builds on the [GenOffice](https://github.com/genspark-ai/genoffice)
engines and would not be possible without:

- [PDFium](https://pdfium.googlesource.com/pdfium/) (BSD-3-Clause, bundled via
  [@embedpdf/pdfium](https://github.com/embedpdf/embed-pdf-viewer)) — the
  content-stream engine behind real PDF text and image editing.
- [pdf.js](https://github.com/mozilla/pdf.js) (Apache-2.0) and
  [pdf-lib](https://github.com/Hopding/pdf-lib) (MIT) — PDF rendering and
  document assembly.
- [Tiptap](https://tiptap.dev/) / [ProseMirror](https://prosemirror.net/) —
  the block editor in Docs.
- [HarfBuzz](https://github.com/harfbuzz/harfbuzz) (wasm) — text-shaping
  metrics for complex scripts.
- [Hono](https://hono.dev/) — the editor service runtime.
- Liberation, Carlito, Caladea, and Noto CJK fonts (OFL/Apache-2.0) — bundled
  document fonts.

## License

Apache-2.0. See [LICENSE](LICENSE).

> PrismOffice is a web port of the open-source GenOffice engines. The GenOffice
> and Genspark names and logos are trademarks of their owners and are not
> granted by this license; this project uses its own branding.
