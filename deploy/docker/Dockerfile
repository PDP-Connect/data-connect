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

# The image owns where Chromium lives. Patchright reads PLAYWRIGHT_BROWSERS_PATH
# once at module load and expects <path>/chromium-<revision>/.../chrome, so the
# install below and every runtime stage built on this one (reference-browser,
# core) must agree on one fixed path. /opt/patchright-browsers matches the
# deployed env and deploy/docker/check-image-secrets.sh. The install is
# asserted against the revision the pinned Patchright expects, so a version bump
# that leaves the browser behind fails the build. The server also falls back to
# this path when a deploy env points at one without the executable (see
# reference-implementation/runtime/browser-executable.ts).
# PDPP_BROWSER_CHANNEL=chromium makes every Patchright launch, headed or
# headless, use this full Chromium. Without a channel, a headless launch runs
# Chrome Headless Shell, a separate build that ignores managed policy such as
# the CA distrust list below, so the install also leaves that build out.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/patchright-browsers \
    PDPP_BROWSER_CHANNEL=chromium

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
  && npx patchright install --with-deps --no-shell chromium \
  && EXPECTED_REVISION="$(node -e "const b = require('./node_modules/patchright-core/browsers.json').browsers.find((entry) => entry.name === 'chromium'); if (!b) process.exit(1); process.stdout.write(b.revision)")" \
  && case "$(dpkg --print-architecture)" in amd64) CHROME_BIN=chrome-linux64/chrome ;; arm64) CHROME_BIN=chrome-linux-arm64/chrome ;; *) echo "unsupported architecture for Patchright Chromium" >&2; exit 1 ;; esac \
  && test -x "${PLAYWRIGHT_BROWSERS_PATH}/chromium-${EXPECTED_REVISION}/${CHROME_BIN}" \
  && if ls -d "${PLAYWRIGHT_BROWSERS_PATH}"/chromium_headless_shell-* 2>/dev/null; then echo "Chrome Headless Shell must not be installed" >&2; exit 1; fi \
  && rm -rf /tmp/patchright-install

# Chromium reads CA distrust policy from a machine policy directory chosen by
# its branding: Chrome for Testing (Patchright's amd64 build) reads
# /etc/opt/chrome_for_testing, a Chromium-branded build reads /etc/chromium.
# Install the policy in both so a branding change cannot silently drop it. See
# docker/chrome-policy/README.md.
RUN --mount=type=bind,source=docker/chrome-policy/distrusted-cas.json,target=/tmp/pdpp-distrusted-cas.json \
  for dir in /etc/opt/chrome_for_testing/policies/managed /etc/chromium/policies/managed; do \
    install -D -o root -g root -m 0644 /tmp/pdpp-distrusted-cas.json "${dir}/pdpp-distrusted-cas.json" || exit 1; \
  done

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
