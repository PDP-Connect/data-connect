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
unavailable. Only loopback interfaces may exist inside the namespace, so the
servers and browser cannot reach host services or the internet.

The harness refuses caller-supplied `E2E_BASE_URL`, `E2E_DATA_DIR`,
`E2E_OWNER_PASSWORD`, `E2E_REMOTE_BASE_URL`, and `E2E_BUFFERING_BASE_URL`,
including empty values, before creating files or launching processes. Unset
these variables. Running these specs against a live console is not supported.

Each run starts its own reference server and console with random loopback
ports, a random owner password, and a fresh data directory and SQLite database.
Child environments exclude ambient credentials, backend URLs, and Node loaders.
The reference server starts directly without the development environment loader
or the shared development database defaults. The harness also refuses console `.env` files so Next cannot load ambient configuration.
The console uses `next dev --webpack`:
its first measured login readiness took 17.70 seconds, and a warm start took
5.61 seconds. It compiles routes on demand, once per run, rather than building a
second production bundle for each spec. No product servers are reused.

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
normal exit, a failing test process, SIGINT, SIGTERM, or timeout. It uses synthetic
processes and never connects to a server. The browser specs exercise the HTTP
console, not the Tauri webview or native IPC. These checks are not wired into CI.

## Current offline limit

At the baseline revision for this harness, connector discovery fetches its signed
catalog from `ghcr.io` on each catalog request. The private namespace blocks that
request, so the full owner journey and catalog checks fail. The tab-to-tab
settings and offline link checks pass. The relay check also has an unresolved
failure in its focus-refresh assertion. Keep the isolation boundary in place;
these gaps must be resolved before this command can pass all non-tunnel checks.
