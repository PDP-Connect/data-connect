# syntax=docker/dockerfile:1.7
#
# "Vacuna al día" walkthrough image: the PDPP reference server with the DR
# pilot on, the walkthrough seed, and the reminder web app, in one process
# (scripts/demo-dr-vacuna/portal/server.ts). Build context = repo root:
#
#   docker build -f scripts/demo-dr-vacuna/deploy/Dockerfile -t vacuna-walkthrough .
#
# Dependency and build steps follow deploy/docker/Dockerfile (the "reference"
# target); browsers are not installed (no connectors run here).
# Dockerfile.dockerignore next to this file keeps node_modules and local
# state out of the context.

ARG NODE_VERSION=24.19.0-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03

FROM node:${NODE_VERSION} AS base
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl g++ make python3 \
  && rm -rf /var/lib/apt/lists/*

FROM base AS deps
ENV PATCHRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json ./
COPY packages/collector-runtime/package.json packages/collector-runtime/package.json
COPY packages/connector-protocol/package.json packages/connector-protocol/package.json
COPY packages/local-collector/package.json packages/local-collector/package.json
COPY packages/polyfill-connectors/package.json packages/polyfill-connectors/package.json
COPY apps/console/package.json apps/console/package.json
COPY reference-implementation/package.json reference-implementation/package.json
COPY reference-implementation/vendor/brand/package.json reference-implementation/vendor/brand/package.json
COPY reference-implementation/vendor/brand-react/package.json reference-implementation/vendor/brand-react/package.json
COPY reference-implementation/vendor/cli/package.json reference-implementation/vendor/cli/package.json
COPY reference-implementation/vendor/display/package.json reference-implementation/vendor/display/package.json
COPY reference-implementation/vendor/list-envelope/package.json reference-implementation/vendor/list-envelope/package.json
COPY reference-implementation/vendor/mcp-server/package.json reference-implementation/vendor/mcp-server/package.json
COPY reference-implementation/vendor/operator-ui/package.json reference-implementation/vendor/operator-ui/package.json
COPY reference-implementation/vendor/read-core/package.json reference-implementation/vendor/read-core/package.json
COPY reference-implementation/vendor/*.tgz reference-implementation/vendor/
RUN npm install --allow-git=all --ignore-scripts \
  && npm rebuild better-sqlite3 esbuild

FROM deps AS source
COPY . .
RUN npm run build --workspace=packages/connector-protocol --workspace=packages/collector-runtime \
  && npm run build --workspace=reference-implementation/vendor/read-core \
  && npm run build --workspace=reference-implementation/vendor/mcp-server

FROM source AS walkthrough
ARG PDPP_REFERENCE_REVISION=unknown
ENV NODE_ENV=production \
    PORT=8080 \
    VACUNA_STATE_DIR=/data \
    PDPP_REFERENCE_REVISION=${PDPP_REFERENCE_REVISION}
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8080
# --import tsx: the vendored polyfill-connectors package ships TypeScript
# under node_modules, which Node will not type-strip (see deploy/docker/Dockerfile).
CMD ["node", "--import", "tsx", "scripts/demo-dr-vacuna/portal/server.ts"]
