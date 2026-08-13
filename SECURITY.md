# Security Policy

## Reporting a Vulnerability

Please report suspected vulnerabilities privately via GitHub's
[private vulnerability reporting](https://github.com/arun-prabhakar/prism-office/security/advisories/new)
on this repository. Do not open public issues for security reports. We aim to
acknowledge reports within 72 hours.

## Security model

PrismOffice is a **self-hosted, embeddable document editor**. The integrator
deploys the editor service in their own infrastructure and embeds it in their
app via an iframe plus a JavaScript SDK. Documents are fetched from the
integrator's own URL and saves are POSTed back to the integrator's
`callbackUrl`; the service itself stores nothing.

### Signed editor config (HS256 JWT)

Every editor config handed to the iframe — document URL, callback URL,
permissions, user identity — is **JWT-signed with `PRISMOFFICE_BROWSER_SECRET`**
(HS256). The iframe honors a config only if its signature verifies against the
service's browser secret. A tampered or stolen token therefore cannot:

- redirect a save to an attacker-controlled `callbackUrl`,
- point the editor at a file the user should not reach, or
- escalate permissions beyond what the integrator granted.

### Two independent secrets

- `PRISMOFFICE_BROWSER_SECRET` — signs the config the browser iframe accepts.
- `PRISMOFFICE_OUTBOX_SECRET` — signs the server-to-server requests the editor
  service makes to fetch the document URL and to expose saved bytes
  (`Authorization: Bearer <jwt>` on both).

A leak of the browser secret does not compromise server-to-server requests, and
vice-versa. Both must be kept secret. Rotation is "edit the env, restart the
service, allow a brief overlap window" — there is no JWKS / key-id mechanism in
v1, so plan the rotation window accordingly.

### iframe + postMessage boundary

- The editor runs inside an `<iframe>` loaded from the editor service origin.
- The SDK ↔ iframe handshake uses `postMessage` and is **origin-checked** on
  both sides: the host SDK only acts on messages whose `event.origin` matches
  the editor service origin, and the iframe only accepts the `init` config from
  the host page that loaded it.
- The signed config is delivered by `postMessage` after the iframe signals
  `app-ready` — **never in the iframe URL** — so it does not leak into Referer
  headers or browser history.

### Stateless by design

The service does not persist documents. It GETs the document from the
integrator's URL (presenting the outbox JWT), streams it to the iframe for the
session, and POSTs save status — with a short-lived URL to fetch the saved
bytes — back to the integrator's `callbackUrl`. A document is held only briefly
in memory while a session is open.

## Threat model: document content

`.docx` and `.pdf` files are untrusted input. They are parsed and rendered to
the extent needed to stream them into the iframe; editing happens in the
browser (Tiptap/ProseMirror for `.docx`, pdfium-wasm for `.pdf`). If you find a
parse or render path that reaches code execution, host file access, or network
access beyond the iframe sandbox, that is a vulnerability — please report it.

## Out of scope

- The integrator's host application — their `callbackUrl` handler, their file
  storage, and their signing of editor configs. That boundary is the
  integrator's responsibility.
- Vulnerabilities that require an already-compromised editor-service host or a
  modified service binary, including the deliberate environment-variable
  override points (`PRISMOFFICE_BROWSER_SECRET`, `PRISMOFFICE_OUTBOX_SECRET`):
  setting them requires control of the process environment, which is equivalent
  to code execution on the host.
- Desktop/Electron-only surfaces of the upstream engine packages (native
  IPC, sidecar processes) are not part of this web service; reports about them
  should go to the upstream project.
