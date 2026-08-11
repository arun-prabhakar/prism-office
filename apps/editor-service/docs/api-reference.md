# GenOffice Editor Service — Public API Reference

> **Version:** 1.0.0  
> **License:** Apache-2.0  
> **Shape:** Mirrors ONLYOFFICE Docs API for familiarity. Diverges where GenOffice's byte-preserving docx round-trip and pdfium-based PDF editing require it.

## Quick Start

```html
<!doctype html>
<html>
<body>
  <div id="placeholder"></div>
  <script src="https://editor.internal/sdk/genoffice.js"></script>
  <script>
    const config = {
      documentType: 'word',  // 'word' | 'pdf'
      document: {
        key: 'unique-doc-key-' + Date.now(),
        url: 'https://your-app.com/files/abc.docx',
        fileType: 'docx',
        title: 'Report.docx',
      },
      editorConfig: {
        mode: 'edit',
        callbackUrl: 'https://your-app.com/track',
        user: { id: 'user-1', name: 'Alice' },
      },
      events: {
        onDocumentReady: () => console.log('doc loaded'),
        onDocumentStateChange: (e) => console.log('dirty:', e.data),
      },
      token: '<JWT — see §3>',
    }
    const editor = new GenOfficeAPI.DocEditor('placeholder', config)
  </script>
</body>
</html>
```

## Table of Contents

1. [SDK Constructor](#1-sdk-constructor)
2. [Config Object](#2-config-object)
3. [JWT Signing](#3-jwt-signing)
4. [Callback Protocol](#4-callback-protocol)
5. [Events](#5-events)
6. [SDK Methods](#6-sdk-methods)
7. [Permissions](#7-permissions)
8. [Editor Service Configuration](#8-editor-service-configuration)
9. [Integration Patterns](#9-integration-patterns)

---

## 1. SDK Constructor

### Loading

```html
<script src="https://editor.internal/sdk/genoffice.js"
        data-editor-origin="https://editor.internal"></script>
```

The SDK is a single ~10 KB IIFE bundle. It registers `window.GenOfficeAPI`.

The `data-editor-origin` attribute tells the SDK where the editor service runs. If omitted, the SDK derives it from the `<script>` element's `src` URL.

### Constructor

```js
const editor = new GenOfficeAPI.DocEditor(placeholderId, config)
```

| Parameter | Type | Description |
|---|---|---|
| `placeholderId` | `string` | DOM element id. The SDK **replaces** this element with the editor iframe. |
| `config` | `EditorConfigRoot` | The full config object (see §2). Must include a valid `token`. |

**Required config fields** (validated at construction — missing any throws):
- `document.url` — where the editor service fetches the document bytes
- `document.key` — unique version identifier (1–128 chars of `[0-9a-zA-Z-_.=]`)
- `document.fileType` **or** `documentType` — selects the editor app

### Destroy

```js
editor.destroyEditor()
```

Removes the iframe from the DOM, unsubscribes from messages, rejects pending method calls.

---

## 2. Config Object

```typescript
interface EditorConfigRoot {
  documentType: 'word' | 'pdf'
  type?: 'desktop' | 'mobile' | 'embedded'
  width?: string   // default '100%'
  height?: string  // default '100%'
  token: string    // HS256 JWT — see §3
  document: DocumentConfig
  editorConfig?: EditorConfig
  events?: { [name: string]: Function }
}
```

### document

```typescript
interface DocumentConfig {
  fileType: string           // 'docx' | 'pdf'
  key: string                // version identifier — regenerate on every save
  title?: string             // display title (≤128 chars)
  url: string                // document bytes URL — editor service fetches server-side
  permissions?: Permissions  // see §7
  info?: {
    owner?: string
    folder?: string
    uploaded?: string
    favorite?: boolean
  }
}
```

**`document.key` rules:**
- Generate a **new key on every save.** After the host acknowledges the save callback with `{"error":0}`, the old key is stale.
- Must be **globally unique** across all integrators sharing an editor service deployment.
- Charset: `0-9 a-z A-Z - . _ =`, max 128 chars.

**`document.url`:**
- The editor service fetches this URL **server-side** (not from the browser). The host does not need CORS configured for the editor origin.
- The fetch includes an `Authorization: Bearer <outbox-jwt>` header (see §3).
- Must return raw document bytes with `Content-Type: application/octet-stream`.

### editorConfig

```typescript
interface EditorConfig {
  mode?: 'edit' | 'view'           // default 'edit'
  lang?: string                     // ISO-639-1 (e.g. 'en', 'zh', 'ja')
  callbackUrl?: string              // REQUIRED for edit mode — see §4
  user?: { id: string; name?: string; image?: string }
  customization?: {
    autosave?: boolean
    forcesave?: boolean
    logo?: { image?: string; url?: string; visible?: boolean }
    goback?: { url: string; text?: string }
    close?: { visible?: boolean }
    ai?: { enabled?: boolean; model?: string }  // GenOffice-specific
  }
}
```

---

## 3. JWT Signing

The editor service uses **HS256** with two secrets:

| Secret | Direction | What it signs |
|---|---|---|
| `GENOFFICE_BROWSER_SECRET` | Browser → Editor Service | The entire config object (the `token` field) |
| `GENOFFICE_OUTBOX_SECRET` | Editor Service → Host | Each server-side request to `document.url` and `callbackUrl` |

### Signing the config (browser secret)

The host signs the serializable subset of the config (everything except `events` — functions can't be serialized) and places the JWT at `config.token`.

**JavaScript / Node.js:**

```javascript
import { signConfig } from '@genoffice/sdk-shared/jwt-sign-browser'

const token = await signConfig(
  {
    documentType: 'word',
    document: { key: 'Khirz6zTPdfd7', url: 'https://host/files/abc', fileType: 'docx' },
    editorConfig: { mode: 'edit', callbackUrl: 'https://host/track' },
  },
  process.env.GENOFFICE_BROWSER_SECRET,
)
// → 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJkb2N1bWVudFR5cGUiOi...'
```

**Python:**

```python
import jwt
token = jwt.encode(
    {
        "documentType": "word",
        "document": {"key": "Khirz6zTPdfd7", "url": "https://host/files/abc", "fileType": "docx"},
        "editorConfig": {"mode": "edit", "callbackUrl": "https://host/track"},
    },
    BROWSER_SECRET,
    algorithm="HS256",
)
```

**Go:**

```go
token := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
    "documentType": "word",
    "document":     map[string]string{"key": key, "url": docURL, "fileType": "docx"},
    "editorConfig": map[string]string{"mode": "edit", "callbackUrl": callbackURL},
})
signed, _ := token.SignedString([]byte(browserSecret))
```

### Verifying outbox requests (host side)

When the editor service fetches `document.url` or POSTs to `callbackUrl`, it sends:

```
Authorization: Bearer <outbox-jwt>
```

The outbox JWT payload is `{"payload":{"url":"<the-url-being-accessed>"}}`. The host verifies it:

```javascript
import { verifyJwt } from '@genoffice/sdk-shared/jwt'

const payload = await verifyJwt(token, OUTBOX_SECRET)
if (!payload) return 401
if (payload.payload.url !== expectedUrl) return 401
```

---

## 4. Callback Protocol

When the user edits and saves (or closes a dirty document), the editor service POSTs to `editorConfig.callbackUrl`.

### Request

```http
POST /track HTTP/1.1
Content-Type: application/json
Authorization: Bearer <outbox-jwt>

{
  "key": "Khirz6zTPdfd7",
  "status": 2,
  "url": "https://editor.internal/saved/abc123",
  "filetype": "docx"
}
```

### Status codes

| Status | Meaning | When |
|---|---|---|
| `2` | Ready for saving | Last editor closed with changes. `url` points at the new bytes. |
| `3` | Save error | Save assembly failed. |
| `4` | Closed, no changes | Last editor closed without edits. No `url`. |
| `6` | Force-saved (still editing) | Explicit save while the editor is open. |
| `7` | Force-save error | Force-save failed. |

### Response

The host **must** reply with HTTP 200 and:

```json
{"error": 0}
```

Any non-zero `error` causes the editor to surface the failure. After replying, the host fetches the bytes from `url` (with the outbox JWT) and persists them.

### Complete flow

```
User clicks Save (or Ctrl+S)
  → Editor generates new bytes (docx-engine.patch for docx; pdfium for PDF)
  → Editor POSTs bytes to editor service /save-document
  → Editor service stores bytes at /saved/<temp-id>
  → Editor service POSTs {key, status:2, url} to host's callbackUrl
  → Host replies {"error":0}
  → Host GETs the bytes from url (with outbox JWT)
  → Host persists to its file store
  → Host generates a new document.key for the next open
```

---

## 5. Events

Events are functions on `config.events`. The SDK invokes each as `handler.call(editor, { target, data })`.

### Lifecycle

| Event | Data | When |
|---|---|---|
| `onAppReady` | — | Editor app loaded into the iframe (no document yet). |
| `onDocumentReady` | — | Document parsed, editor rendered. |
| `onError` | `{ errorCode, errorDescription }` | Fatal error. |
| `onWarning` | `{ errorCode, errorDescription }` | Non-fatal warning. |

### Save state

| Event | Data | When |
|---|---|---|
| `onDocumentStateChange` | `boolean` | `true` = user has unsaved edits. `false` = edits pushed to editor service. Use this for confirm-on-close. |
| `onDownloadAs` | `{ fileType, url }` | In response to `editor.downloadAs()`. |

### Requests (paired with SDK methods)

| Event | SDK method to call in response |
|---|---|
| `onRequestHistory` | `editor.refreshHistory({ currentVersion, history })` |
| `onRequestHistoryData` | `editor.setHistoryData({ url, key, version })` |
| `onRequestHistoryClose` | — (host navigates or re-inits) |
| `onRequestInsertImage` | `editor.insertImage({ c: 'add', images: [{ fileType, url }] })` |
| `onRequestEditRights` | — (host re-inits with `mode: 'edit'`) |
| `onRequestSaveAs` | — (host provides new file identity) |
| `onRequestRename` | — (host updates the file title) |
| `onRequestClose` | — (host navigates away or destroys editor) |
| `onOutdatedVersion` | `editor.refreshFile({ url, key })` |

### Example

```javascript
events: {
  onAppReady: () => console.log('app ready'),
  onDocumentReady: () => hideSpinner(),
  onDocumentStateChange: (e) => {
    window.onbeforeunload = e.data ? () => 'You have unsaved changes' : null
  },
  onError: (e) => showError(e.data.errorDescription),
  onRequestHistory: () => {
    editor.refreshHistory({
      currentVersion: 3,
      history: [
        { version: 1, created: '2024-01-01', user: { name: 'Alice' } },
        { version: 2, created: '2024-01-02', user: { name: 'Bob' } },
        { version: 3, created: '2024-01-03', user: { name: 'Alice' } },
      ],
    })
  },
  onRequestHistoryData: (e) => {
    editor.setHistoryData({
      version: e.data,
      url: `https://your-app.com/files/abc/v${e.data}`,
      key: `v${e.data}-key`,
    })
  },
}
```

---

## 6. SDK Methods

Available on the `editor` instance returned by `new GenOfficeAPI.DocEditor(...)`.

| Method | Returns | Description |
|---|---|---|
| `destroyEditor()` | `void` | Remove iframe, clean up listeners. |
| `downloadAs()` | `Promise<unknown>` | Trigger download; fires `onDownloadAs`. |
| `insertImage(payload)` | `Promise<unknown>` | Respond to `onRequestInsertImage`. |
| `refreshHistory(history)` | `Promise<unknown>` | Respond to `onRequestHistory`. |
| `setHistoryData(data)` | `Promise<unknown>` | Respond to `onRequestHistoryData`. |
| `refreshFile(file)` | `Promise<unknown>` | Respond to `onOutdatedVersion`. |
| `requestEditRights()` | `void` | Programmatically request edit mode. |

---

## 7. Permissions

```javascript
document: {
  permissions: {
    edit: true,       // default true. false = view-only.
    review: true,     // default = edit. Track-changes accept/reject.
    comment: true,    // default = edit. Comment sidebar.
    fillForms: true,  // default = edit. Form field editing.
    download: true,   // default true. Download capability.
    print: true,      // default true. Print capability.
    copy: true,       // default true. Clipboard copy.
    aiEdit: true,     // GenOffice-specific. AI panel visibility.
  },
}
```

**Interaction rules:**
- `edit: false` opens in viewer. Cannot switch to edit even if `mode: 'edit'`.
- `edit: false, review: false, comment: true` = comment-only mode.
- `edit: false, review: false, fillForms: true` = form-fill only.

---

## 8. Editor Service Configuration

The editor service reads configuration from environment variables:

| Variable | Required | Default | Description |
|---|---|---|---|
| `PORT` | no | `3000` | HTTP listen port. |
| `GENOFFICE_BROWSER_SECRET` | **yes** | `dev-browser-secret` (dev only) | HS256 secret for config JWTs. |
| `GENOFFICE_OUTBOX_SECRET` | **yes** | `dev-outbox-secret` (dev only) | HS256 secret for service→host requests. |
| `GENOFFICE_GSK_KEY` | no | — | Genspark API key for AI panel. If absent, AI returns "not configured". |
| `SAVED_URL_TTL_SEC` | no | `60` | TTL for `/saved/<id>` temp URLs (seconds). |

### Docker

```yaml
services:
  editor-service:
    image: genoffice/editor-service:1.0
    ports: ['3000:3000']
    environment:
      GENOFFICE_BROWSER_SECRET: your-browser-secret
      GENOFFICE_OUTBOX_SECRET: your-outbox-secret
      GENOFFICE_GSK_KEY: optional-gsk-key
```

### Health check

```http
GET /health
→ { "ok": true, "version": "1.0.0", "browserJwt": true, "outboxJwt": true }
```

---

## 9. Integration Patterns

### Pattern A: Minimal edit flow

```javascript
// 1. Sign the config
const token = await signConfig(config, BROWSER_SECRET)

// 2. Embed
const editor = new GenOfficeAPI.DocEditor('placeholder', { ...config, token })

// 3. Handle save callback (server-side)
app.post('/track', async (req, res) => {
  const { status, url, key } = req.body
  if (status === 2) {
    const bytes = await fetch(url, { headers: { Authorization: `Bearer ${signUrl(url)}` } })
    await saveToFileStore(key, await bytes.arrayBuffer())
  }
  res.json({ error: 0 })
})
```

### Pattern B: View-only embed

```javascript
const config = {
  documentType: 'pdf',
  document: { key: 'view-key', url: '...', fileType: 'pdf' },
  editorConfig: { mode: 'view' },
  events: { onDocumentReady: () => console.log('viewing') },
  token: await signConfig(/* ... */),
}
new GenOfficeAPI.DocEditor('placeholder', config)
```

### Pattern C: Embedded viewer (compact)

```javascript
const config = {
  type: 'embedded',  // compact viewer UI
  documentType: 'pdf',
  document: { key: 'embed-key', url: '...', fileType: 'pdf' },
  token: await signConfig(/* ... */),
}
```

### Pattern D: Version history

```javascript
events: {
  onRequestHistory: () => {
    const versions = await fetch(`/api/files/${fileId}/versions`)
    editor.refreshHistory({
      currentVersion: versions.current,
      history: versions.list.map(v => ({
        version: v.number,
        created: v.createdAt,
        user: { name: v.userName },
      })),
    })
  },
  onRequestHistoryData: (e) => {
    editor.setHistoryData({
      version: e.data,
      url: `/api/files/${fileId}/versions/${e.data}/bytes`,
      key: `v${e.data}`,
    })
  },
  onRequestHistoryClose: () => {
    // Re-init the editor with the current version
    location.reload()
  },
}
```

---

## Endpoint Reference

### Editor service endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/health` | none | Health probe. |
| `GET` | `/sdk/genoffice.js` | none | SDK bundle. |
| `GET` | `/editor/word/` | none | Docs editor SPA. |
| `GET` | `/editor/pdf/` | none | PDF editor SPA. |
| `GET` | `/editor/*/assets/*` | none | Static assets (JS, CSS, fonts, wasm). |
| `POST` | `/fetch-document` | browser JWT | Proxy: fetch `document.url` → return bytes to iframe. |
| `POST` | `/save-document` | browser JWT | Iframe uploads new bytes → editor service fires callback to host. |
| `GET` | `/saved/:id` | outbox JWT | Host fetches uploaded bytes (60s TTL). |
| `GET` | `/ai/settings` | none | AI configuration status. |
| `POST` | `/ai/stream` | browser JWT | Start AI streaming (SSE when `GENOFFICE_GSK_KEY` is set). |
| `POST` | `/ai/stream-cancel` | browser JWT | Cancel in-flight stream. |
| `POST` | `/ai/web-search` | browser JWT | Web search proxy. |
| `POST` | `/ai/image-search` | browser JWT | Image search proxy. |
| `POST` | `/ai/fetch-image` | browser JWT | Image download proxy (SSRF-guarded). |

### Host endpoints (integrator implements)

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/files/:id/bytes` | outbox JWT | `document.url` — return raw docx/pdf bytes. |
| `POST` | `/track` | outbox JWT | Save callback — receive status, download bytes from `url`, persist. |

---

## Supported Document Types

| Editor | Formats | Features |
|---|---|---|
| **word** | `.docx` | Full Tiptap editing. Byte-preserving round trip (only edited paragraphs' bytes change). Tracked changes, comments, styles, equations, tables, images. AI panel with block-level edits. |
| **pdf** | `.pdf` | pdf.js viewer with text layer, search, thumbnails, annotations. Real text editing via pdfium Web Worker (content-stream rewrite, subset font embedding). Image insert/edit. Page extract/insert. |

## Limitations (v1)

- No real-time collaboration (planned for v2).
- No offline capability (the editor service is stateless but online-only).
- PDF text editing uses bundled fonts (Carlito/Caladea/Liberation/Noto CJK). System fonts are not available in the browser.
- AI panel requires `GENOFFICE_GSK_KEY` configured on the editor service.
- Mobile UI is not optimized (desktop browsers only).
