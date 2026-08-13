# Contributing to PrismOffice

Thanks for your interest in contributing. This document covers the local
setup, the checks a change must pass, and the conventions used in this
repository.

## What this is

PrismOffice is a **self-hosted, embeddable document editor for the web**. An
integrator deploys the editor service and embeds it in their app via an iframe
plus a JavaScript SDK; users open and edit `.docx` and `.pdf` documents in the
browser without the file leaving their environment. See the
[README](README.md) for the full overview and [INSTALLATION.md](INSTALLATION.md)
for deployment.

## Repository layout

- `apps/editor-service` — the stateless [Hono](https://hono.dev/) server you
  deploy. Serves the SDK bundle, the editor SPAs, proxies document fetch/save
  between the iframe and the host app, and signs/verifies JWT config.
- `apps/reference-host` — a minimal reference integrator. Read it as
  documentation-as-code for the embedding pattern.
- `apps/docs`, `apps/pdf` — the editor SPAs (word processor, PDF editor), built
  as web bundles and served at `/editor/word/` and `/editor/pdf/`.
- `packages/sdk-shared` — the JavaScript SDK (`PrismOfficeAPI.DocEditor`).
- `packages/editor-contract` — the typed config/event/callback contract shared
  by the SDK, the service, and the editor SPAs.
- `packages/*` — the OOXML/PDF editing engines and shared libraries the
  editors are built on.

## Getting started

Prerequisites: Node 22+, npm 10+.

```bash
npm install

# Build the SDK bundle → apps/editor-service/static/sdk/prismoffice.js
npm run build:sdk -w @prismoffice/editor-service

# Build the editor SPA bundles → apps/editor-service/static/editor/{word,pdf}/
npm run build:web -w @prismoffice/docs
npm run build:web -w @prismoffice/pdf

# Run the editor service (port 3000) and the reference host (port 3001)
npx tsx apps/editor-service/src/server.ts &
npx tsx apps/reference-host/src/server.ts
```

Set `PRISMOFFICE_BROWSER_SECRET` and `PRISMOFFICE_OUTBOX_SECRET` to random
strings for local dev (the reference host falls back to short dev secrets).
Without them the editors still load, but config signing/verification is
insecure — fine locally, never in a real deployment.

## Checks every change must pass

CI runs these on every PR; please run them locally first:

```bash
npm run format:check  # Prettier check for changed/new files
npm run lint          # ESLint across the repo
npm run typecheck     # tsc --noEmit across every workspace
npm test              # engine + service unit tests
npm run licenses      # production dependency licenses within the allowlist
```

## Coding conventions

- TypeScript everywhere; avoid adding new `any` surfaces where a precise type
  is cheap. `packages/editor-contract` is the source of truth for
  config/event/callback shapes.
- English only in code, comments, commit messages, and docs.
- Tests live in `apps/*/tests` and `packages/*/tests` (vitest). New engine
  behavior needs a unit test.
- **File-format fidelity is the core product promise.** For changes touching
  `.docx` open/save paths, include a round-trip test proving untouched content
  survives byte-for-byte.
- Keep files from growing without bound; prefer a new module over enlarging an
  already-large file.

## Commit and PR guidelines

- Small, focused commits with imperative English subject lines
  (e.g. `fix docx table border round-trip`, `add editor-service /health check`).
- A PR should explain _why_ the change is needed and mention which of the
  checks above you ran.
- Don't weaken the JWT verification, the postMessage origin checks, or add a
  path that accepts an unsigned editor config — see [SECURITY.md](SECURITY.md).

## Reporting bugs and requesting features

Use the issue templates. For suspected security issues, do **not** open a
public issue — follow [SECURITY.md](SECURITY.md).

## Code of conduct

All community spaces follow the
[Contributor Covenant](CODE_OF_CONDUCT.md); participation implies acceptance.

## License

There is no CLA (contributor license agreement). By contributing, you agree
that your contributions are licensed under the
[Apache License 2.0](LICENSE) that covers this project — inbound = outbound,
per Apache-2.0 §5.
