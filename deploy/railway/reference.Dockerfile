# syntax=docker/dockerfile:1.7

# Railway templates/config-as-code expose a Dockerfile path but not a Docker
# target-stage field. This Dockerfile is the template-safe private reference
# service image: its final stage is the reference runtime, so a Railway Template
# can select it directly without a manual "Target Stage" setting.
#
# Keep the dependency/reference stages in sync with deploy/docker/Dockerfile —
# see that file's own header comment for the full pdpp -> data-connect path
# translation (npm workspaces here, not pnpm; reference-implementation/vendor/*
# instead of packages/*).

ARG NODE_VERSION=24.19.0-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03

FROM node:${NODE_VERSION} AS base

ENV NEXT_TELEMETRY_DISABLED=1

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
COPY reference-implementation/package.json reference-implementation/package.json
COPY reference-implementation/vendor/brand/package.json reference-implementation/vendor/brand/package.json
COPY reference-implementation/vendor/brand-react/package.json reference-implementation/vendor/brand-react/package.json
COPY reference-implementation/vendor/cli/package.json reference-implementation/vendor/cli/package.json
COPY reference-implementation/vendor/display/package.json reference-implementation/vendor/display/package.json
COPY reference-implementation/vendor/list-envelope/package.json reference-implementation/vendor/list-envelope/package.json
COPY reference-implementation/vendor/mcp-server/package.json reference-implementation/vendor/mcp-server/package.json
COPY reference-implementation/vendor/operator-ui/package.json reference-implementation/vendor/operator-ui/package.json
COPY reference-implementation/vendor/read-core/package.json reference-implementation/vendor/read-core/package.json
# reference-implementation depends on @pdpp/reference-contract and
# @pdpp/polyfill-connectors via `file:./vendor/*.tgz` (Move B's interim,
# pre-registry-publish pin — see reference-implementation/vendor/README.md).
# npm resolves and unpacks these tarballs during install, so they must be
# present before the manifest-only install below runs.
COPY reference-implementation/vendor/*.tgz reference-implementation/vendor/

# --allow-git=all: this repo declares a git-sourced devDependency
# (@opendatalabs/data-connectors-tools); the manifest-only tree above is
# enough for npm to resolve it. --ignore-scripts here for the same reason as
# the Patchright env vars: native rebuilds happen explicitly below, after the
# full source tree exists, not against a manifest-only skeleton.
RUN npm install --allow-git=all --ignore-scripts \
  && npm rebuild better-sqlite3 esbuild onnxruntime-node protobufjs

FROM deps AS source

COPY . .

# mcp-server ships as dist/-built output (not source-resolved), and depends on
# both vendor/cli and vendor/read-core (also dist/-built) -- mcp-server's own
# build script builds cli first, but not read-core, so that one needs its own
# explicit build step. See deploy/docker/Dockerfile's own `source` stage for
# the confirmed-live crash this avoids.
RUN npm run build --workspace=packages/connector-protocol --workspace=packages/collector-runtime \
  && npm run build --workspace=reference-implementation/vendor/read-core \
  && npm run build --workspace=reference-implementation/vendor/mcp-server

FROM base AS reference

ARG PDPP_REFERENCE_REVISION=unknown

# PDPP_LOCAL_TRANSFORMER_SUPERVISOR_RESTART_CONTRACT is baked in because this
# image is deployed exclusively through railway.reference.json, which commits
# restartPolicyType=ON_FAILURE for this exact service — a real supervisor
# restart on the fail-stop the flag asserts. If this stage is ever deployed
# through a path with no restart policy, that deployment is the truthful gap
# to fix, not this flag.
ENV NODE_ENV=production \
    AS_PORT=7662 \
    RS_PORT=7663 \
    PDPP_RS_URL=http://127.0.0.1:7663 \
    PDPP_EMBEDDING_DOWNLOAD_ALLOWED=0 \
    PDPP_REFERENCE_OPERATIONAL_DEFAULTS=1 \
    PDPP_LOCAL_TRANSFORMER_SUPERVISOR_RESTART_CONTRACT=1 \
    PDPP_REFERENCE_REVISION=${PDPP_REFERENCE_REVISION}

# The source stage's node_modules already resolves collector-runtime and
# connector-protocol to real, built dist/ output (via workspace symlinks) —
# retain that full tree rather than a manifest-only overlay (mirrors
# deploy/docker/Dockerfile's `reference` stage).
COPY --from=source /app /app

EXPOSE 7662 7663

# --import tsx, not plain `node`: see deploy/docker/Dockerfile's own `reference`
# stage comment for why (the vendored @pdpp/polyfill-connectors dependency
# ships raw TypeScript under node_modules, and Node refuses to strip types
# there by policy).
CMD ["sh", "-c", "export AS_PORT=\"${PORT:-${AS_PORT:-7662}}\"; export PDPP_RS_URL=\"${PDPP_RS_URL:-http://127.0.0.1:${RS_PORT:-7663}}\"; exec node --import tsx reference-implementation/server/index.ts"]
