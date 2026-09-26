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
# The reference implementation keeps the reference-contract tarball as a
# local compatibility dependency. Connector implementations are not copied
# into this image; production installs resolve them from the signed catalog.
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

# The host tree retains the conformance tarball for local tests and packaging,
# but the production image must not carry that connector bundle or its source
# artifact. The reference-contract tarball remains because it is a direct RI
# compatibility dependency.
RUN rm -f /app/reference-implementation/vendor/pdpp-polyfill-connectors-0.0.1.tgz

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

# --import tsx is required because the reference server is TypeScript. The
# runtime connector package is intentionally absent from this image; installed
# catalog artifacts provide executable connector entrypoints at run time.
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

COPY reference-implementation/package.json /tmp/reference-implementation-package.json

WORKDIR /tmp/patchright-install

# Keep the browser layer tied to the direct runtime dependency, not to a
# connector package that is absent from the production image.
RUN PATCHRIGHT_VERSION="$(node --input-type=module -e "import { readFileSync } from 'node:fs'; const packageJson = JSON.parse(readFileSync('/tmp/reference-implementation-package.json', 'utf8')); const version = packageJson.dependencies.patchright; if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Patchright dependency must be exact, got: ' + version); process.stdout.write(version)")" \
  && echo '{"name":"patchright-installer","private":true,"version":"0.0.0"}' > package.json \
  && npm install --no-save --ignore-scripts "patchright@${PATCHRIGHT_VERSION}" \
  && npx patchright install --with-deps chromium \
  && test -n "$(find /root/.cache/ms-playwright -type f \( -path '*/chrome-linux64/chrome' -o -path '*/chrome-linux/chrome' \) -print -quit)" \
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

FROM reference-browser AS core

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
