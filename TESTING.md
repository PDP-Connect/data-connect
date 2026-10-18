# Testing

How to run the tests in this repository, what each tier isolates, and what it costs.
This page covers the desktop client (`src/`, `src-tauri/` TypeScript, `scripts/`),
`apps/console`, `packages/*` and `e2e/`. The reference implementation has its own
gate; see its section below.

## Tiers

| Tier | Command | What runs | When | Measured (this host, inside `test-sandbox`) |
|---|---|---|---|---|
| fast | `npm run test:fast` | Only the tests affected by your change against `origin/main` (Vitest `--changed` for client files; console tests matched by file, directory or import; whole package for `packages/*`) | Edit loop. Not a gate | first lane 3.6 s; one client and one console file edited: 10.2 s |
| client unit | `npm run test:unit` | Root Vitest suite, no typecheck | Before you push | 23.6 to 28.0 s wall, 83 CPU-s, about 1.0 GB peak |
| client | `npm test` | Typecheck, then the client unit tier | Before you push | typecheck plus the above |
| console | `npm test --workspace=apps/console` | `node --test` over `apps/console` | Before you push | 59.8 s wall, 119 CPU-s, 1.1 GB peak |
| packages | `npm test --workspace=packages/<name>` | That package's `node --test` suite | Before you push | local-collector 3.4 to 4.2 s, connector-protocol 3.2 s, collector-runtime 8.9 s |
| e2e | `npm run test:e2e` | The three Playwright specs against a disposable reference server and console | Before changing owner-facing pages or live settings | 59 to 75 s wall, 66 to 80 CPU-s, 2.3 to 2.8 GB peak (the console build is most of it) |
| CI | pull request | `client-tests` (typecheck 101 s; client and console tests 233 s, of which `npm ci` 81 s and the console build 45 s), `rust-unit-tests` (399 s), OCI e2e (76 s), pack-install-run (115 s), diff-aware mutation (80 to 96 s per cohort, advisory) | Every PR | GitHub-hosted runners |

Every local entry point above runs inside the vendored `scripts/test-sandbox/test-sandbox`
(see its README). It puts the run in a systemd scope under one host-wide slice, so all
test runs on a machine share one CPU and memory budget (default per run: 400% CPU,
8 GiB), gives it a loopback-only network and a private `/tmp`, kills every descendant
when it ends, and prints one JSON receipt with wall time, CPU-seconds and peak memory.
On macOS it runs without those limits and says so in the receipt; CI sets
`TEST_SANDBOX_DISABLE=1` because the hosted VM is the isolation boundary.

`npm run test:e2e` refuses `E2E_BASE_URL`, `E2E_DATA_DIR`, `E2E_OWNER_PASSWORD`,
`E2E_REMOTE_BASE_URL` and `E2E_BUFFERING_BASE_URL` and starts its own stack with its own
data directory, database, password and ports. Do not point these specs at a running
console. See `e2e/README.md` for what the hermetic run cannot cover (the connector
catalog comes from `ghcr.io`). After changing the harness, run
`node --test e2e/harness-cleanup.test.mjs` once outside any sandbox: its real
`test-sandbox` containment case skips when nested and on CI runners.

The reference implementation: `npm test --workspace=reference-implementation` (SQLite
profile) and `npm run test:postgres --workspace=reference-implementation` (a private
PostgreSQL 18 cluster per run). It is large; `test:fast` does not run it and prints a
pointer instead.

## Isolation contract

| Scope | What | Why |
|---|---|---|
| Shared, read-only | `node_modules`, toolchain, Playwright's Chromium, the console build (`apps/console/.next`) within one e2e run | Immutable inputs; building or installing per worker is pure cost |
| Per run | The sandbox scope, network namespace, `/tmp` and `TMPDIR`; the e2e stack (server, console, data dir, SQLite DB, password, ports) | Nothing a run creates can be seen or reached by another run or by a live instance |
| Per worker | Vitest workers (at most 4, matching the 400% CPU budget), `node --test` files (2 at a time) | More workers than CPUs only adds memory and trips 5 s timeouts |
| Per test | Temp roots registered with `t.after` (outbox databases), `:memory:` databases for queue-policy cases, fake timers for UI delays | Tests clean up their own state and do not wait real time |
| Locked or serial | e2e: one Playwright worker, one harness per checkout | The live-settings spec changes stack-wide settings, and the console build directory is shared within a checkout |

Unit tests cannot use the network: `src/test/setup.ts` pins the `VITE_*` endpoints to
`.test` origins and blocks `fetch` and socket connections to any host but `localhost`,
`127.0.0.1` and `::1`. Inside the sandbox the network namespace blocks the rest, such
as subprocesses.

## Rules

- A bug fix comes with a test that fails without the fix (see `AGENTS.md`). Put the
  failing output in the PR.
- No automatic retries. A flaky test is a bug: find the cause (two found this way:
  a test that wrote its `.deb` fixture into the scanned repo tree, and a temp-file race
  in the blob spool's `put()`), fix it, and keep the test. If it cannot be fixed at
  once, skip it with a reason that names an open issue.
- Prefer a test that calls the code over one that matches its source text. Keep
  source-text checks only for absence or layering rules, and start their titles with
  `source:`.
- Measure a test-infrastructure change before and after with interleaved runs under a
  fixed budget, and report wall time, CPU-seconds, peak memory and test counts.

## Gap to excellence

Compared with the practices in the cross-project survey of mature test suites
(Kubernetes, CPython, Django, Bun, SQLite, Google, Meta and others).

| Exemplar practice | Here | Measured | Status |
|---|---|---|---|
| A fast gate on every PR that must pass before merge | CI runs on every PR, but the only required check on `main` is DCO; `client-tests` is not required | 0 required test checks | Open: needs a repository admin to require `client-tests` and `rust-unit-tests` |
| Change-based selection locally, full run as backstop | `test:fast` locally; full suites in CI | 3.6 s first signal vs 23.5 s client and 50 s console suites | Closed |
| Slower tiers on a schedule | Everything runs per PR; e2e runs nowhere in CI | e2e 65 to 70 s locally | Open: the harness's own 20 safety tests run in `client-tests`; a scheduled job that runs the specs is next |
| No retries; flakes are owned work | No retries configured anywhere; no quarantine list | 2 flakes fixed at the cause this round | Partly closed: policy above; no flake tracker yet |
| Regression test for every fix | Required by `AGENTS.md` for reported bugs | every fix this round had a fail-before test | Closed for agents; not tool-enforced |
| Test the tests | Diff-aware mutation on every PR (advisory); empty Vitest collection fails CI | mutation 80 to 96 s per cohort | Closed |
| Hermetic unit tier | Network guard plus sandbox network namespace | guard blocks fetch, net, tls; 4 pinning tests | Closed |
| Host-wide resource budget for concurrent agents | `test-sandbox` slice and per-run receipts | every local run reports `cgroup+netns` | Closed |
| Behavior over structure | About 110 `apps/console` test files still assert on source text, mostly what a page renders | 125 of 263 files at the start; wire contracts converted | Open: render contracts belong in the e2e tier |
| Timeouts sized for a loaded host | `release-atomicity.test.ts` and `App.bootstrap.test.tsx` hit the 5 s default with more workers than CPUs | 0 of 3 failures at 4 workers, 3 of 3 uncapped at 400% CPU | Partly closed by the worker cap |
| Coverage ratchet | None | none | Not adopted: contested in the survey; mutation evidence per PR is the stronger signal here |
