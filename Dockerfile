# syntax=docker/dockerfile:1.7

# Ported from PDP-Connect/pdpp's root Dockerfile (pre-Move-B commit
# 206abe0b57^), which builds the combined console+reference-implementation
# "Core" image that deploy/railway/core-supervisor.ts's CMD expects. Move B's
# split left data-connect with only deploy/docker/Dockerfile's RI-only build
# (see that file's own header comment for the npm/vendor-path Rosetta stone
# this file reuses) — this file is the missing superset: console
# (apps/console) + reference-implementation, combined into the "core" target
# docker-images.yml publishes to GHCR.
#
# Runtime contract verified against deploy/railway/core-supervisor.ts (already
# restored in this repo): it spawns the reference server as plain
# `node /app/reference-implementation/server/index.ts` (cwd /app, NO --import
# tsx) and the console as plain `node /console/apps/console/server.js` (cwd
# /console). Unlike deploy/docker/Dockerfile's standalone `reference` stage
# (which needs `--import tsx` because a bare CLI invocation of
# reference-implementation/cli/index.ts reaches vendored packages), the
# supervisor's own reference process only ever imports server/index.ts's
# graph, and every path that graph traverses through node_modules
# (@pdpp/mcp-server, @pdpp/polyfill-connectors, @pdpp/reference-contract) is
# already vendored as COMPILED JS, not raw TypeScript (see
# reference-implementation/vendor/README.md — this was fixed there
# specifically because Node refuses to strip types under node_modules). The
# one remaining raw-.ts reach, `../vendor/cli/src/package-info.ts`, is a
# relative import to a real workspace path outside node_modules, which Node's
# native type-stripping (unflagged since Node 22.18/23.6, and the norm by the
# Node 24 pinned here) handles directly. Confirmed live: `node
# /tmp/typetest.ts` with a typed `const` ran clean under this image's Node
# version with zero flags.
#
# Deliberately NOT ported: pdpp's isolated sigtop and slackdump builder
# stages. sigtop (Signal connector) has zero references anywhere in this
# repo -- no Signal connector exists here to need it. slackdump is used
# (reference-implementation/server/ref-control.ts,
# runtime/connector-child-environment.ts, runtime/scheduler/run-executor.ts),
# but this repo's own docker-compose.yml already documents a different,
# deliberate policy for it: "slackdump is AGPL-licensed and is not bundled
# into the stock reference image; mount a host-provided directory" (see
# docker-compose.yml's SLACKDUMP_BIN / PDPP_DOCKER_SLACKDUMP_DIR). Baking the
# binary into this image would silently reverse that policy, not just port
# pdpp's Dockerfile.

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
# The reference implementation keeps the reference-contract tarball as a
# local compatibility dependency. Connector implementations are not copied
# into this image; production installs resolve them from the signed catalog.
# (@pdpp/polyfill-connectors is a devDependency pinned to a second, excluded
# tarball -- see .dockerignore -- and is dropped below via --omit=dev.)
COPY reference-implementation/vendor/pdpp-reference-contract-0.1.0.tgz reference-implementation/vendor/

# --allow-git=all: this repo declares a git-sourced devDependency
# (@opendatalabs/data-connectors-tools); the manifest-only tree above is
# enough for npm to resolve it. --ignore-scripts here for the same reason
# as the Patchright env vars: native rebuilds happen explicitly below, after
# the full source tree exists, not against a manifest-only skeleton.
RUN npm install --allow-git=all --omit=dev --ignore-scripts \
  && npm rebuild better-sqlite3 esbuild onnxruntime-node protobufjs

FROM deps AS source

COPY . .

# The production install omits the dev-only polyfill package, but the owner
# console still needs its signed manifest metadata to populate /sources/add.
# Keep only those manifests in the runtime tree; connector code and fixtures
# remain outside the Core image and are installed from the signed catalog.
RUN mkdir -p packages/polyfill-connectors/manifests \
  && tar -xzf reference-implementation/vendor/pdpp-polyfill-connectors-0.0.1.tgz \
    --strip-components=2 \
    -C packages/polyfill-connectors/manifests \
    package/manifests

# mcp-server ships as dist/-built output (not source-resolved), and depends
# on both vendor/cli and vendor/read-core (also dist/-built) -- mcp-server's
# own build script builds cli first, but not read-core, so that one needs
# its own explicit build step. Confirmed live: without vendor/read-core's
# build, the server crashes at boot with ERR_MODULE_NOT_FOUND on
# @pdpp/read-core/dist/index.js, imported from mcp-server's own dist output.
RUN npm run build --workspace=packages/connector-protocol --workspace=packages/collector-runtime \
  && npm run build --workspace=reference-implementation/vendor/read-core \
  && npm run build --workspace=reference-implementation/vendor/mcp-server

FROM source AS console-builder

# apps/console depends on the reference-implementation workspace package
# (pdpp-reference-implementation, e.g. next.config.ts's
# manual-upload-limits import) and 5 vendored UI/brand packages (@pdpp/brand,
# @pdpp/brand-react, @pdpp/display, @pdpp/list-envelope, @pdpp/operator-ui) --
# all resolved from the full source tree above via workspace symlinks, not
# rebuilt separately here. Next's own bundler traces and compiles those
# imports directly; no separate `npm run build --workspace` step is needed
# for them the way mcp-server/read-core (consumed at plain-Node runtime, not
# bundled) needed one in the `source` stage above.
RUN npm run build --workspace=apps/console

# Split-service AS/RS reference runtime. Keep this stage browser-free; the
# browser-capable Core payload is assembled by the core stage below.
FROM base AS reference

ARG PDPP_REFERENCE_REVISION=unknown

ENV NODE_ENV=production \
    PDPP_OWNER_AUTH_REQUIRED=1 \
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

# --import tsx, not plain `node`: a bare CLI invocation of this stage's
# server/index.ts reaches reference-implementation/cli/index.ts and vendored
# @pdpp/polyfill-connectors code that (at some import paths) still ships raw
# TypeScript under node_modules — see reference-implementation/vendor/README.md
# and deploy/docker/Dockerfile's own `reference` stage comment for the exact
# ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING crash this avoids. The
# core-supervisor.ts-spawned path (see the `core` stage below) does not hit
# this same reach and runs the equivalent server entry point with plain node.
CMD ["sh", "-c", "export AS_PORT=\"${PORT:-${AS_PORT:-7662}}\"; export PDPP_RS_URL=\"${PDPP_RS_URL:-http://127.0.0.1:${RS_PORT:-7663}}\"; exec node --import tsx reference-implementation/server/index.ts"]

# Operator console: self-hosted dashboard + BFF proxy to the AS/RS. Kept as
# its own standalone target (mirrors pdpp's `console` stage / GHCR `web` tag)
# separate from apps/console/Dockerfile, which builds console alone from a
# standalone `context: ./apps/console` (see root docker-compose.yml's `web`
# service) -- this stage instead builds console from the FULL workspace
# source tree above, which is what the `core` combined stage below needs to
# share layers with (both console and reference come from the same `source`
# stage rather than two independent, differently-pathed builds).
FROM base AS console

ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0 \
    PORT=3000

COPY --from=console-builder /app/apps/console/.next/standalone ./
COPY --from=console-builder /app/apps/console/.next/static ./apps/console/.next/static
COPY --from=console-builder /app/apps/console/public ./apps/console/public

EXPOSE 3000

CMD ["node", "apps/console/server.js"]

# Dedicated browsers stage, cached independently of source changes: only a
# Patchright/Chromium version bump invalidates this layer.
FROM base AS browsers

ARG TARGETARCH

RUN apt-get update \
  && apt-get install -y --no-install-recommends xvfb \
  && rm -rf /var/lib/apt/lists/* \
  && test -x /usr/bin/Xvfb

COPY reference-implementation/package.json /tmp/reference-implementation-package.json

WORKDIR /tmp/patchright-install

# Keep the browser layer tied to the direct runtime dependency, not to a
# connector package that is absent from the production image (see
# deploy/docker/Dockerfile's identical stage and .dockerignore, which
# excludes the devendored polyfill-connectors tarball from the build context).
RUN PATCHRIGHT_VERSION="$(node --input-type=module -e "import { readFileSync } from 'node:fs'; const packageJson = JSON.parse(readFileSync('/tmp/reference-implementation-package.json', 'utf8')); const version = packageJson.dependencies.patchright; if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Patchright dependency must be exact, got: ' + version); process.stdout.write(version)")" \
  && echo '{"name":"patchright-installer","private":true,"version":"0.0.0"}' > package.json \
  && npm install --no-save --ignore-scripts "patchright@${PATCHRIGHT_VERSION}" \
  && npx patchright install --with-deps chromium \
  && test -n "$(find /root/.cache/ms-playwright -type f \( -path '*/chrome-linux64/chrome' -o -path '*/chrome-linux-arm64/chrome' -o -path '*/chrome-linux/chrome' \) -print -quit)" \
  && rm -rf /tmp/patchright-install

WORKDIR /app

FROM browsers AS reference-browser

ARG PDPP_REFERENCE_REVISION=unknown

ENV NODE_ENV=production \
    PDPP_OWNER_AUTH_REQUIRED=1 \
    AS_PORT=7662 \
    RS_PORT=7663 \
    PDPP_REFERENCE_OPERATIONAL_DEFAULTS=1 \
    PDPP_REFERENCE_REVISION=${PDPP_REFERENCE_REVISION}

COPY --from=source /app /app

EXPOSE 7662 7663

CMD ["node", "--import", "tsx", "reference-implementation/server/index.ts"]

# Browser-capable Core payload: one image bundles the operator console and the
# reference AS/RS, run together by deploy/railway/core-supervisor.ts (already
# restored in this repo). The supervisor's own CMD spawns two plain-node child
# processes:
#   node /app/reference-implementation/server/index.ts   (cwd /app)
#   node /console/apps/console/server.js                 (cwd /console)
# so this stage lays out BOTH trees at those exact absolute paths -- the
# `reference-browser` layout for /app, the `console` stage's standalone output
# for /console -- rather than picking one of those two stages' own COPY
# destinations. See this file's header comment for why plain `node` (no
# --import tsx) is safe for the supervisor's reference child specifically.
#
# Mirrors PDP-Connect/pdpp's own `core-browser`/`core` stage split and image
# identity/provenance contract (org.opencontainers.image.revision label,
# PDPP_BUILD_REVISION/PDPP_REFERENCE_REVISION match gate) -- see
# deploy/docker/check-image-identity.sh and deploy/docker/README.md document
# the image identity contract implemented in this stage.
FROM browsers AS core

ARG PDPP_REFERENCE_REVISION=unknown

# Image provenance. Without these the deployed artifact cannot say what source
# it was built from. PDPP_BUILD_REVISION defaults to PDPP_REFERENCE_REVISION
# so a single build-arg is the source of truth for both the OCI label and the
# runtime env; the RUN check below refuses to let them silently diverge.
ARG PDPP_BUILD_REVISION=${PDPP_REFERENCE_REVISION}
ARG PDPP_BUILD_SOURCE=unknown
ARG PDPP_BUILD_CREATED=unknown
ARG PDPP_BUILD_DIRTY=unknown
ARG PDPP_BUILD_COMPOSITION=unknown

RUN if [ "${PDPP_BUILD_REVISION}" != "${PDPP_REFERENCE_REVISION}" ]; then \
      echo "image identity mismatch: PDPP_BUILD_REVISION='${PDPP_BUILD_REVISION}' != PDPP_REFERENCE_REVISION='${PDPP_REFERENCE_REVISION}'" >&2; \
      echo "the OCI revision label and the runtime revision must be the exact same immutable git SHA (or both 'unknown' for a plain local dev build)" >&2; \
      exit 1; \
    fi; \
    if [ "${PDPP_BUILD_REVISION}" != "unknown" ]; then \
      hex_len=$(printf '%s' "${PDPP_BUILD_REVISION}" | tr -d '0-9a-f' | wc -c); \
      full_len=$(printf '%s' "${PDPP_BUILD_REVISION}" | wc -c); \
      if [ "$hex_len" -ne 0 ] || { [ "$full_len" -ne 40 ] && [ "$full_len" -ne 64 ]; }; then \
        echo "image identity is not a real git object id: PDPP_REFERENCE_REVISION='${PDPP_REFERENCE_REVISION}' is not 40 or 64 lowercase hex characters" >&2; \
        echo "a mutable ref name (branch/tag) or an abbreviated SHA is not an immutable commit identity" >&2; \
        exit 1; \
      fi; \
    fi

LABEL org.opencontainers.image.revision="${PDPP_BUILD_REVISION}" \
      org.opencontainers.image.source="${PDPP_BUILD_SOURCE}" \
      org.opencontainers.image.created="${PDPP_BUILD_CREATED}" \
      pdpp.build.dirty="${PDPP_BUILD_DIRTY}" \
      pdpp.build.composition="${PDPP_BUILD_COMPOSITION}"

ENV NODE_ENV=production \
    PDPP_OWNER_AUTH_REQUIRED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    AS_PORT=7662 \
    RS_PORT=7663 \
    PDPP_AS_URL=http://127.0.0.1:7662 \
    PDPP_RS_URL=http://127.0.0.1:7663 \
    PDPP_DB_PATH=/var/lib/pdpp/pdpp.sqlite \
    PDPP_BROWSER_PROFILE_ROOT=/var/lib/pdpp/browser-profiles \
    PDPP_RUNTIME_BROWSER=1 \
    PDPP_CONNECTOR_ARTIFACT_ROOT=/var/lib/pdpp/connector-artifacts \
    PDPP_EMBEDDING_DOWNLOAD_ALLOWED=1 \
    PDPP_EMBEDDING_CACHE_DIR=/var/lib/pdpp/transformers \
    PDPP_REFERENCE_OPERATIONAL_DEFAULTS=1 \
    PDPP_LOCAL_TRANSFORMER_SUPERVISOR_RESTART_CONTRACT=1 \
    PDPP_RECONCILE_POLYFILL_MANIFESTS=1 \
    PDPP_REFERENCE_REVISION=${PDPP_REFERENCE_REVISION}

# /app: the reference-browser layout (full source tree with built dist/
# output), which is exactly what core-supervisor.ts's
# `node /app/reference-implementation/server/index.ts` (cwd /app) needs.
COPY --from=source /app /app
# /console: the console stage's standalone output, which is exactly what
# core-supervisor.ts's `node /console/apps/console/server.js` (cwd /console)
# needs.
COPY --from=console-builder /app/apps/console/.next/standalone /console
COPY --from=console-builder /app/apps/console/.next/static /console/apps/console/.next/static
COPY --from=console-builder /app/apps/console/public /console/apps/console/public
COPY --from=source /app/packages/polyfill-connectors/manifests /console/packages/polyfill-connectors/manifests

EXPOSE 3000

CMD ["node", "--import", "tsx", "/app/deploy/railway/core-supervisor.ts"]
