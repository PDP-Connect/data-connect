# Disposable console e2e checks

Install dependencies and Chromium once, with network access:

```sh
npm ci --no-audit --no-fund --allow-git=root
npm --prefix e2e ci --no-audit --no-fund
npm --prefix e2e exec -- playwright install chromium
```

Run from the repository root:

```sh
npm run test:e2e
# Equivalent:
npm --prefix e2e run test:e2e
# Select a spec:
npm --prefix e2e run test:e2e -- live-settings.spec.ts
```

Linux with unprivileged network namespaces is required. The harness uses
`scripts/test-sandbox/test-sandbox --net none` when installed, or `bwrap`
with private network and PID namespaces. It fails closed when isolation is
unavailable. A caller that already provides a loopback-only namespace (for
example `test-sandbox --net none -- npm run test:e2e`) forbids a nested one,
so the harness runs in place. It checks that only loopback interfaces exist
before it starts anything. The servers and browser cannot reach host services
or the internet.

The harness refuses caller-supplied `E2E_BASE_URL`, `E2E_DATA_DIR`,
`E2E_OWNER_PASSWORD`, `E2E_REMOTE_BASE_URL`, and `E2E_BUFFERING_BASE_URL`,
including empty values, before creating files or launching processes. Unset
these variables. Running these specs against a live console is not supported.

Each run starts its own reference server and console with random loopback
ports, a random owner password, and a fresh data directory and SQLite database.
Child environments exclude ambient credentials, backend URLs, and Node loaders.
The reference server starts directly without the development environment loader
or the shared development database defaults. The harness also refuses console `.env` files so Next cannot load ambient configuration.
The console is a production build (`next build --webpack`, then `next start`),
as the desktop app serves it, built once per run and shared by every spec. A
cold run measured a 27 to 90 second build (CPU time 80 seconds, peak 2.6 GB) and
0.5 seconds to start. `next dev` was rejected: its HMR websocket
reconnects after the relay test cuts every socket, and the resulting router
refresh and page reload discard in-flight server actions, which made the
focus-refresh check fail. The build writes the gitignored `apps/console/.next`,
so do not run two harnesses in one checkout at once. No product servers are reused.

All three spec files share one disposable stack, with one Playwright worker
because settings are global to that stack. Each browser context is test-owned.
Live-settings checks loopback isolation, the real data-directory path, and a
random ownership marker before writing or changing settings. Watcher shutdown
waits for its last write; fixture teardown closes contexts and the TCP relay even
when assertions fail. Tunnel-dependent coverage skips in this offline lane.

The harness stops its process groups, waits for exit, and removes scratch state
on success, failure, timeout (ten minutes), SIGINT, and SIGTERM. Signal exits are
130 and 143. Scratch lives under `TEST_TMPDIR`, or the namespace's private `/tmp`.
Failure traces survive in gitignored `e2e/test-results/`, outside scratch. The
next run replaces that directory, keeping failure artifacts bounded. Traces can
contain disposable test credentials; server diagnostics redact passwords and
omit cookie or authorization lines.

Offline harness acceptance checks:

```sh
npm --prefix e2e run test:harness
npm --prefix e2e run test:harness:cleanup
```

The cleanup check records process groups and verifies no descendants survive
normal exit, a failing test process, SIGINT, SIGTERM, or timeout. Outside a sandbox it
exercises the bwrap wrapper; inside `test-sandbox --net none` it exercises the in-place path. It uses synthetic
processes and never connects to a server. The browser specs exercise the HTTP
console, not the Tauri webview or native IPC. These checks are not wired into CI.

## What the hermetic run does not cover

The connector catalog is not reachable offline, and the vault starts empty. `GET
/v1/owner/connector-install/catalog` loads a Sigstore-verified catalog from
`ghcr.io` on every request
(`reference-implementation/server/connector-install/index.ts`,
`loadCatalogFromPinnedCore`). The private namespace blocks it, so `/sources/add`
returns an error page. `PDPP_CONNECTOR_PRELOAD_DIR` does not help: it holds
installer-produced state for already installed connectors, and the catalog is
still fetched from `ghcr.io`. The harness skips only the checks that need it:

- `owner-journey.spec.ts`: the `/sources/add` surface inside "owner routes render
  resolved labels" (annotated "skipped surface"; the other surfaces still run).
- `owner-journey.spec.ts`: "sources/add renders many connectors, not the
  empty-catalog regression" (skipped).
- `owner-journey.spec.ts`: three `/explore` labels in the same test (search hint,
  Filters toggle, newest/oldest sort). A fresh vault has no records, and its
  Explore page renders only the empty state. The Filters label is also hidden by CSS at desktop widths,
  and the search hint text appears nowhere in visible text in the current source, so these three
  labels may be stale as well. They need an owner decision.
- `live-settings.spec.ts`: the tunnel test (needs `E2E_BUFFERING_BASE_URL`, as before).

Connector catalog rendering is therefore checked only on a console that can reach
`ghcr.io`, which this harness does not provide by design.
