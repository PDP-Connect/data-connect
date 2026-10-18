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

Linux with unprivileged network namespaces is required. The one supported
isolation is the vendored `scripts/test-sandbox/test-sandbox --net none --pidns`,
run with `TEST_SANDBOX_REQUIRE=1`. If it is missing, fails, or cannot enforce
cgroups and `bwrap`, the harness exits non-zero before it starts anything; there
is no other fallback. When the caller is already inside `test-sandbox` (it exports
`TEST_SANDBOX_ACTIVE=1`) and only loopback interfaces exist (for example
`test-sandbox --net none -- npm run test:e2e`), a nested namespace is refused,
so the harness runs in place. In-place mode trusts the caller: it refuses only
`TEST_SANDBOX_DISABLE=1`, because `test-sandbox` exports `TEST_SANDBOX_ACTIVE=1`
before it checks that variable or enforcement. Loopback-only interfaces alone never
suffice: an offline host would pass that check. `test-sandbox` does not export its network
mode yet; a `TEST_SANDBOX_NET=none` export would let the harness check it instead
of inferring it from the interfaces. Inside the namespace, TCP and UDP reach only
loopback. Unix-domain sockets on the shared filesystem (for example D-Bus) remain
reachable.

The harness refuses caller-supplied `E2E_BASE_URL`, `E2E_DATA_DIR`,
`E2E_OWNER_PASSWORD`, `E2E_REMOTE_BASE_URL`, and `E2E_BUFFERING_BASE_URL`,
including empty values, before creating files or launching processes. Unset
these variables. Running these specs against a live console is not supported.

Each run starts its own reference server and console with random loopback
ports, a random owner password, and a fresh data directory and SQLite database.
Child environments exclude ambient credentials, backend URLs, and Node loaders.
The reference server starts directly without the development environment loader
or the shared development database defaults. The harness also refuses every `apps/console/.env*` file that is not `*.example`
(Next loads a different set for dev, build and start), so Next cannot load ambient
configuration.
The console is a production build (`next build --webpack`, then `next start`),
built once per run and shared by every spec. The desktop app runs a staged
standalone `server.js` through `launch.mjs` (`scripts/ensure-console-stack.js`);
staging through `stageConsoleStack` into a scratch directory is a follow-up. `next
start` warns because `next.config.ts` sets `output: "standalone"`. A
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

The harness stops its process groups, waits for each leader to exit (bounded, so a
descendant that holds the pipes cannot hang teardown), and removes scratch state
on success, failure, timeout (ten minutes), SIGINT, and SIGTERM. Signal exits are
130 and 143. The outer process passes a signal to the inner one by closing file
descriptor 3 (`test-sandbox` runs its command with `&`, so stdin is `/dev/null`);
end of file means SIGTERM. Descendants that leave the process group, such as
Playwright's detached browsers, are not owned by the harness. The PID namespace
(`--pidns`) reaps them; in place, the caller's `test-sandbox` scope must. The in-place run has the
same ten-minute deadline and a bounded teardown. Scratch lives under the namespace's private `/tmp`, or `TEST_TMPDIR` in place.
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
normal exit, a failing test process, SIGINT, SIGTERM, timeout, or a TERM-resistant
descendant that calls `setsid` and holds the pipes. Each case runs twice: through a
stub wrapper that mimics `test-sandbox` (`cmd & wait`), and in place. The stub
makes the wrapper path testable inside a sandbox. The detached-descendant case
runs only on the real `test-sandbox` and asserts the process is gone as soon as
the wrapper returns, before any cleanup by the test; it skips where `test-sandbox`
cannot enforce (inside another sandbox, run it under `test-receipt`). In the signal cases the test
asserts that the inner process reported the signal. The checks use synthetic
processes and never connect to a server, so only the detached-descendant case
needs `bwrap` and cgroups. CI runs them (`client-tests`, without a browser). The browser specs
exercise the HTTP console, not the Tauri webview or native IPC.

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
