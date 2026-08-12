# GenOffice editor service container image.
#
# Self-hosted by customers (matches ONLYOFFICE Docs deployment shape).
# Single Node process — horizontally scalable behind a sticky-session LB if
# real-time collaboration is ever added (v2); for v1 (no collab) any number
# of replicas works.

FROM node:22-alpine AS base
WORKDIR /workspace

# Install all workspace deps (postinstall pulls Electron for the legacy
# desktop build — disabled here via PRISMOFFICE_SKIP_ELECTRON to keep the
# image lean; the editor service doesn't need Electron).
ENV PRISMOFFICE_SKIP_ELECTRON=1
COPY package.json package-lock.json* ./
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/editor-service ./apps/editor-service
COPY apps/pdf ./apps/pdf
COPY apps/docs ./apps/docs
# The editor service needs docx-engine + pdf-engine types + the SDK package.
# Other apps are not required, but npm workspaces need the whole tree.
RUN npm ci --no-audit --no-fund --ignore-scripts || npm install --no-audit --no-fund --ignore-scripts

# Build the SDK bundle into static/sdk/prismoffice.js
RUN npm run build:sdk -w @prismoffice/editor-service

EXPOSE 3000
ENV PORT=3000
ENV PRISMOFFICE_BROWSER_SECRET=change-me
ENV PRISMOFFICE_OUTBOX_SECRET=change-me-too

CMD ["node", "--experimental-strip-types", "apps/editor-service/src/server.ts"]
