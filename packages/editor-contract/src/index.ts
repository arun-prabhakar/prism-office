/**
 * @genoffice/editor-contract
 *
 * Typed contract for the GenOffice embeddable editor. Mirrors the ONLYOFFICE
 * Docs API shape (config / events / callback handler / JWT) so integrators
 * familiar with ONLYOFFICE can adopt ours with minimal relearning.
 *
 * Source of truth for the contract shape:
 *   .omo/plans/reference-onlyoffice-api.md
 *
 * v1 subset: collaboration-related fields and events are intentionally
 * omitted. Adding them in v2 does not change the existing fields.
 */

// ---------------------------------------------------------------------------
// documentType & type
// ---------------------------------------------------------------------------

/** Editor app selected by file type. v1 ships two editors. */
export type DocumentType = 'word' | 'pdf'

/** Platform profile. v1 honors `embedded` (read-only viewer); `desktop` is the default full editor. */
export type EditorType = 'desktop' | 'mobile' | 'embedded'

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

/**
 * v1 permission set. Subset of ONLYOFFICE's; adds `aiEdit` (GenOffice-specific
 * — gates the AI panel).
 *
 * Defaults follow ONLYOFFICE: `edit/review/comment/fillForms` default true;
 * `download/print/copy` default true.
 */
export interface Permissions {
  /** Full editing. false → opens in viewer; cannot switch to edit. */
  edit?: boolean
  /** Track-changes accept/reject. Requires edit mode. */
  review?: boolean
  /** Add/edit comments. Requires edit mode for adding. */
  comment?: boolean
  /** Fill form fields (docx/pdf). Requires edit mode. */
  fillForms?: boolean
  /** Download the file. */
  download?: boolean
  /** Print. */
  print?: boolean
  /** Copy to clipboard. */
  copy?: boolean
  /** GenOffice-specific: show the AI panel. */
  aiEdit?: boolean
}

// ---------------------------------------------------------------------------
// Document config
// ---------------------------------------------------------------------------

/** Display-only document metadata (shown in the editor UI, never enforced). */
export interface DocumentInfo {
  owner?: string
  folder?: string
  uploaded?: string
  favorite?: boolean
  sharingSettings?: Array<{ user: string; permissions: string }>
}

/**
 * The `document` block of the editor config.
 *
 * `key` rules (matches ONLYOFFICE):
 *   - Generate a new key on every save (after status-2 with `{"error":0}`).
 *   - Charset `0-9 a-z A-Z - _ . =`, max 128 chars.
 *   - Globally unique across all integrators sharing an editor service.
 */
export interface DocumentConfig {
  /** Lowercase extension: `docx` | `pdf`. */
  fileType: string
  /** Version identifier; see rules above. */
  key: string
  /** Display title (≤128 chars). */
  title?: string
  /**
   * Document bytes URL. The editor service fetches this server-side (with the
   * outbox JWT in `Authorization`) and proxies to the iframe — hosts do not
   * need to configure CORS for the editor origin.
   */
  url: string
  /** Permission flags. Omitted fields take ONLYOFFICE defaults. */
  permissions?: Permissions
  /** Display-only metadata. */
  info?: DocumentInfo
}

// ---------------------------------------------------------------------------
// Editor config
// ---------------------------------------------------------------------------

/** User identity for the editing session. `id` MUST be a string. */
export interface EditorUser {
  id: string
  name?: string
  group?: string
  image?: string
}

/** Branding / behavior toggles. v1 subset of ONLYOFFICE's `customization`. */
export interface Customization {
  autosave?: boolean
  forcesave?: boolean
  /** Logo shown in the editor header. `visible:false` hides it. */
  logo?: { image?: string; imageDark?: string; url?: string; visible?: boolean }
  /** "Back to host app" affordance. */
  goback?: { url: string; text?: string; blank?: boolean }
  /** Close button on the editor; requires `onRequestClose` event to show. */
  close?: { visible?: boolean; text?: string }
  /** GenOffice-specific: AI panel config. */
  ai?: { enabled?: boolean; sidebar?: boolean; model?: string }
}

/**
 * The `editorConfig` block. v1 omits collaboration-related fields
 * (`coEditing`, `templates`, `recent`, etc.).
 */
export interface EditorConfig {
  /** `"edit"` (default) or `"view"`. */
  mode?: 'edit' | 'view'
  /** ISO-639-1 language code (e.g. `en`, `zh`, `ja`). */
  lang?: string
  /**
   * Save/status callback URL. REQUIRED when permissions.edit is true.
   * The editor service POSTs status updates here (see CallbackRequest).
   */
  callbackUrl?: string
  /** User opening the document. */
  user?: EditorUser
  /** Branding / behavior. */
  customization?: Customization
  /** Deep-link target passed in from `onMakeActionLink` (v1.1). */
  actionLink?: { action: { type: string; data: unknown } }
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/**
 * v1 event subset. Each handler is invoked as `handler.call(editor, event)`
 * where `event` is `{ target: DocEditor, data: T }`.
 *
 * Two families (matches ONLYOFFICE):
 *   - Notifications: one-way (`onAppReady`, `onDocumentReady`, `onError`).
 *   - Requests: paired with a method call on the editor (`onRequestHistory`
 *     → `editor.refreshHistory(...)`, etc.). The SDK hides request/method
 *     plumbing from the host — declare the event, call the method.
 */
export interface EditorEvents {
  /** App loaded into the iframe (no document yet). */
  onAppReady?: () => void
  /** Document parsed, editor rendered. */
  onDocumentReady?: () => void
  /** `{errorCode, errorDescription}`. */
  onError?: (event: { data: { errorCode: number; errorDescription: string } }) => void
  /** Non-fatal warning. */
  onWarning?: (event: { data: { errorCode: number; errorDescription: string } }) => void
  /**
   * Dirty state. `data:true` = user has unsaved edits; `data:false` = edits
   * have been pushed to the editor service. Host uses this for confirm-on-close.
   */
  onDocumentStateChange?: (event: { data: boolean }) => void
  /** User asked to switch view→edit. Host re-inits the editor with `mode:"edit"`. */
  onRequestEditRights?: () => void
  /** User picked Save As. Host provides a new file identity. */
  onRequestSaveAs?: (event: { data: { fileType: string; title: string } }) => void
  /** User typed a new title. */
  onRequestRename?: (event: { data: { newTitle: string } }) => void
  /** User clicked ✕. Host can navigate away or destroy the editor. */
  onRequestClose?: () => void
  /** Open version history → host calls `editor.refreshHistory(...)`. */
  onRequestHistory?: () => void
  /** User picked a version → host calls `editor.setHistoryData(...)`. */
  onRequestHistoryData?: (event: { data: number }) => void
  /** Restore a version → host saves it as the new current, calls `refreshHistory`. */
  onRequestRestore?: (event: { data: { fileType: string; url: string; version: number } }) => void
  /** History panel closed. Host re-inits or refreshes. */
  onRequestHistoryClose?: () => void
  /** User picked insert-image → host calls `editor.insertImage(...)`. */
  onRequestInsertImage?: (event: { data: { c: 'add' } }) => void
  /** In response to `editor.downloadAs()`. */
  onDownloadAs?: (event: { data: { fileType: string; url: string } }) => void
  /** Title or favorite flag changed via command-service `meta`. */
  onMetaChange?: (event: { data: { title?: string; favorite?: boolean } }) => void
  /** Opened a stale `key` after save → host calls `editor.refreshFile(...)`. */
  onOutdatedVersion?: () => void
  /** v8.3+ name for `onOutdatedVersion`. */
  onRequestRefreshFile?: () => void
}

// ---------------------------------------------------------------------------
// Top-level Config
// ---------------------------------------------------------------------------

/**
 * The full editor config object passed to `new GenOfficeAPI.DocEditor(id, config)`.
 *
 * Required: `document.url`, `document.fileType` (or `documentType`), `document.key`.
 *
 * `token` is HS256-over-the-entire-config, signed with the editor service's
 * browser secret. The SDK validates it before opening the document.
 */
export interface EditorConfigRoot {
  documentType: DocumentType
  type?: EditorType
  width?: string
  height?: string
  /** HS256 JWT. Payload = this entire object (minus `token`). */
  token?: string
  document: DocumentConfig
  editorConfig?: EditorConfig
  events?: EditorEvents
}

// ---------------------------------------------------------------------------
// Callback handler protocol (editor service → host)
// ---------------------------------------------------------------------------

/**
 * Save/status enum. Matches ONLYOFFICE.
 *
 * v1 subset actually fired: 2, 3, 4, 6, 7 (no status 1 — that's collab-only).
 */
export enum CallbackStatus {
  /** Document is being edited (per-user connect/disconnect). v1: not fired. */
  BeingEdited = 1,
  /** Document ready for saving (last editor closed with changes). */
  ReadyForSaving = 2,
  /** Save error. */
  SaveError = 3,
  /** Closed with no changes. */
  ClosedNoChanges = 4,
  /** Force-saved while still editing. */
  ForceSaved = 6,
  /** Forcesave error. */
  ForceSaveError = 7,
}

/** Forcesave trigger (only present when status is 6 or 7). Matches ONLYOFFICE. */
export type ForceSaveType = 0 | 1 | 2 | 3

/**
 * Request body the editor service POSTs to `editorConfig.callbackUrl`.
 *
 * Host replies with HTTP 200 and `{"error": 0}` (see CallbackResponse).
 * Host then GETs `url` (with the outbox JWT in `Authorization`) to download
 * the assembled bytes and persist them.
 */
export interface CallbackRequest {
  /** The document.key this callback is for. */
  key: string
  /** Status (see CallbackStatus enum). */
  status: CallbackStatus
  /** Present on status 2/3/6/7 — the new bytes URL on the editor service. */
  url?: string
  /** Present on status 2/3/6/7 — file type extension. */
  filetype?: string
  /** Present on status 2/3/6/7 — zip of edit data for history (v1.1). */
  changesurl?: string
  /** Present on status 6/7 — what triggered the forcesave. */
  forcesavetype?: ForceSaveType
  /** Present on status 1/2/6 — user IDs in the session. */
  users?: string[]
  /** Present on status 1/2/6 — connect/disconnect/forcesave-click actions. */
  actions?: Array<{ type: 0 | 1 | 2; userid: string }>
}

/** Host response to a CallbackRequest. `error:0` means success. */
export interface CallbackResponse {
  /** 0 = success; non-zero = error code (the editor surfaces it). */
  error: number
}

// ---------------------------------------------------------------------------
// SDK method signatures (paired with request events)
// ---------------------------------------------------------------------------

/** Version history entry, returned by the host via `editor.refreshHistory(...)`. */
export interface HistoryEntry {
  created: string
  user?: EditorUser
  version: number
  changes?: unknown
  serverVersion?: string
}

/** Per-version data, returned by the host via `editor.setHistoryData(...)`. */
export interface HistoryData {
  version: number
  url: string
  key: string
  previous?: { key: string; url: string; fileType: string }
  changesUrl?: string
  token?: string
}

/** Image to insert, returned by the host via `editor.insertImage(...)`. */
export interface InsertImagePayload {
  c: 'add'
  images: Array<{ fileType: string; url: string; token?: string }>
}

// ---------------------------------------------------------------------------
// JWT helpers
// ---------------------------------------------------------------------------

/**
 * JWT payload shape for the browser config token.
 *
 * The token signs the ENTIRE config (document, editorConfig, events omitted
 * since functions aren't serializable — the SDK signs the serializable subset
 * and the editor service re-validates that subset on receipt).
 *
 * The host signs `{ document, editorConfig, documentType, type }` with the
 * browser secret; the SDK places the resulting JWT at `config.token`.
 */
export type EditorConfigTokenPayload = Pick<
  EditorConfigRoot,
  'document' | 'editorConfig' | 'documentType' | 'type'
>

/**
 * JWT payload for editor-service → host requests (file GET, callback POST).
 * The URL (or callback body) is wrapped as `{ payload: { ... } }` and signed
 * with the outbox secret.
 */
export interface OutboxUrlTokenPayload {
  payload: { url: string }
}
