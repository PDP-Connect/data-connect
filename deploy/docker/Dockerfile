# syntax=docker/dockerfile:1.7

# Move B production-image proof: builds the moved reference implementation
# from its new home in data-connect, targeting the same runtime contract
# PDP-Connect/pdpp's own Dockerfile documents (AS_PORT=7662, RS_PORT=7663,
# PDPP_REFERENCE_REVISION build-arg, the "core" hosted image). Adapted for
# this repo's npm workspaces (pdpp uses pnpm) and its own path layout
# (reference-implementation/vendor/* here, packages/* there).

ARG NODE_VERSION=24.19.0-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03

FROM node:${NODE_VERSION} AS base

ENV NEXT_TELEMETRY_DISABLED=1

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl g++ make python3 \
  && rm -rf /var/lib/apt/lists/*

FROM base AS deps

# Skip Patchright's postinstall browser download during the manifest-only
# install: it needs network access this stage should not depend on, and the
# browser this image actually needs is installed explicitly in the
# `browsers` stage below, from a pinned version, independent of source
# changes.
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
# reference-implementation depends on @pdpp/reference-contract and
# @pdpp/polyfill-connectors via `file:./vendor/*.tgz` (Move B's interim,
# pre-registry-publish pin — see reference-implementation/vendor/README.md).
# npm resolves and unpacks these tarballs during install, so they must be
# present before the manifest-only install below runs.
COPY reference-implementation/vendor/*.tgz reference-implementation/vendor/

# --allow-git=all: this repo declares a git-sourced devDependency
# (@opendatalabs/data-connectors-tools); the manifest-only tree above is
# enough for npm to resolve it. --ignore-scripts here for the same reason
# as the Patchright env vars: native rebuilds happen explicitly below, after
# the full source tree exists, not against a manifest-only skeleton.
RUN npm install --allow-git=all --ignore-scripts \
  && npm rebuild better-sqlite3 esbuild onnxruntime-node protobufjs

FROM deps AS source

COPY . .

# mcp-server ships as dist/-built output (not source-resolved), and depends
# on both vendor/cli and vendor/read-core (also dist/-built) -- mcp-server's
# own build script builds cli first, but not read-core, so that one needs
# its own explicit build step. Confirmed live: without vendor/read-core's
# build, the server crashes at boot with ERR_MODULE_NOT_FOUND on
# @pdpp/read-core/dist/index.js, imported from mcp-server's own dist output.
RUN npm run build --workspace=packages/connector-protocol --workspace=packages/collector-runtime \
  && npm run build --workspace=reference-implementation/vendor/read-core \
  && npm run build --workspace=reference-implementation/vendor/mcp-server

# Build the hosted console against the completed workspace tree. The console's
# standalone output traces its workspace dependencies, so it must be built
# after the reference and shared-package outputs above exist.
FROM source AS console-builder

RUN npm run build --workspace=apps/console

FROM base AS reference

ARG PDPP_REFERENCE_REVISION=unknown

ENV NODE_ENV=production \
    AS_PORT=7662 \
    RS_PORT=7663 \
    PDPP_RS_URL=http://127.0.0.1:7663 \
    PDPP_EMBEDDING_DOWNLOAD_ALLOWED=0 \
    PDPP_REFERENCE_OPERATIONAL_DEFAULTS=1 \
    PDPP_REFERENCE_REVISION=${PDPP_REFERENCE_REVISION}

# The source stage's node_modules already resolves collector-runtime and
# connector-protocol to real, built dist/ output (via workspace symlinks) —
# retain that full tree rather than a manifest-only overlay.
COPY --from=source /app /app

EXPOSE 7662 7663

# --import tsx, not plain `node`: the moved server's vendored
# @pdpp/polyfill-connectors dependency ships raw TypeScript source under
# node_modules (see reference-implementation/vendor/README.md), and Node
# refuses to strip types from any file there by policy — a bare `node
# server/index.ts` crashes at the first import from that package with
# ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING. Confirmed live: this exact
# crash reproduced with a bare `node` CMD in this image before this fix.
# Matches PDP-Connect/pdpp's own real production entrypoint (deploy/railway/
# core-supervisor.ts), which is invoked the same way for the same reason.
CMD ["sh", "-c", "export AS_PORT=\"${PORT:-${AS_PORT:-7662}}\"; export PDPP_RS_URL=\"${PDPP_RS_URL:-http://127.0.0.1:${RS_PORT:-7663}}\"; exec node --import tsx reference-implementation/server/index.ts"]

# Dedicated browsers stage, cached independently of source changes: only a
# Patchright/Chromium version bump invalidates this layer.
FROM base AS browsers

ARG TARGETARCH

# Browser-capable runtime stages inherit this explicit capability marker. The
# reference runtime checks it together with DISPLAY before allowing headed
# connector launches; Xvfb alone is not sufficient.
ENV PDPP_RUNTIME_BROWSER=1

RUN apt-get update \
  && apt-get install -y --no-install-recommends xvfb \
  && rm -rf /var/lib/apt/lists/* \
  && test -x /usr/bin/Xvfb

COPY packages/polyfill-connectors/package.json /tmp/polyfill-connectors-package.json

WORKDIR /tmp/patchright-install

# The vendored reference-implementation/vendor/pdpp-polyfill-connectors-*.tgz
# is the package version actually loaded at runtime (see vendor/README.md);
# its Patchright dependency is what must match here, not this repo's own
# top-level packages/polyfill-connectors (a different, native package with
# no direct runtime relationship to reference-implementation's server).
COPY reference-implementation/vendor/*.tgz /tmp/patchright-install/vendor/
RUN PATCHRIGHT_VERSION="$(tar -xzO -f /tmp/patchright-install/vendor/pdpp-polyfill-connectors-0.0.1.tgz package/package.json | node --input-type=module -e "import { readFileSync } from 'node:fs'; const version = JSON.parse(readFileSync(0, 'utf8')).dependencies.patchright; if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Patchright dependency must be exact, got: ' + version); process.stdout.write(version)")" \
  && echo '{"name":"patchright-installer","private":true,"version":"0.0.0"}' > package.json \
  && npm install --no-save --ignore-scripts "patchright@${PATCHRIGHT_VERSION}" \
  && npx patchright install --with-deps chromium \
  && test -n "$(find /root/.cache/ms-playwright -type f \( -path '*/chrome-linux64/chrome' -o -path '*/chrome-linux/chrome' \) -print -quit)" \
  && rm -rf /tmp/patchright-install

WORKDIR /app

FROM browsers AS reference-browser

ARG PDPP_REFERENCE_REVISION=unknown

ENV NODE_ENV=production \
    AS_PORT=7662 \
    RS_PORT=7663 \
    PDPP_REFERENCE_OPERATIONAL_DEFAULTS=1 \
    PDPP_REFERENCE_REVISION=${PDPP_REFERENCE_REVISION}

COPY --from=source /app /app

EXPOSE 7662 7663

CMD ["node", "--import", "tsx", "reference-implementation/server/index.ts"]

FROM reference-browser AS core

# One public service owns port 3000. The reference AS/RS stay on loopback and
# are reached through the console's existing route handlers and proxy.
ENV HOSTNAME=0.0.0.0 \
    PORT=3000 \
    PDPP_AS_URL=http://127.0.0.1:7662 \
    PDPP_RS_URL=http://127.0.0.1:7663

COPY --from=console-builder /app/apps/console/.next/standalone /console
COPY --from=console-builder /app/apps/console/.next/static /console/apps/console/.next/static
COPY --from=console-builder /app/apps/console/public /console/apps/console/public

EXPOSE 3000

# `tsx` is required for the reference server because its vendored connector
# package contains TypeScript source. The supervisor is PID 1 so it can own
# Xvfb, the AS/RS process, and the public Next.js console together.
CMD ["node", "--import", "tsx", "/app/deploy/railway/core-supervisor.ts"]
