# Reference host — example integrator. Not a product; documentation-as-code.

FROM node:22-alpine AS base
WORKDIR /workspace

ENV GENOFFICE_SKIP_ELECTRON=1
COPY package.json package-lock.json* ./
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/reference-host ./apps/reference-host
COPY apps/editor-service ./apps/editor-service
RUN npm ci --no-audit --no-fund --ignore-scripts || npm install --no-audit --no-fund --ignore-scripts

EXPOSE 3001
ENV PORT=3001

CMD ["node", "--experimental-strip-types", "apps/reference-host/src/server.ts"]
