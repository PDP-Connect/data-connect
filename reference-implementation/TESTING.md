# Testing the reference implementation

How to run the reference implementation (RI) tests, what each tier isolates, and what it costs.
The root `TESTING.md` covers the desktop client, `apps/console`, `packages/*` and `e2e/`.
Run every command below from `reference-implementation/`, or add `--workspace=reference-implementation`
from the repository root.

## Tiers

| Tier | Command | What runs | When | Measured |
|---|---|---|---|---|
| fast (heuristic) | `npm run test:fast` | Test files reachable from the changed code modules through static imports, literal `require` and `new URL(..., import.meta.url)`, ranked by import distance (default 1; `--depth N` widens). Any changed non-code file (JSON, SQL, fixtures), `package.json`, a lockfile, a `tsconfig`, the runner, hermetic guard or accounting code, or a deleted module falls back to the full suite. An added or edited test also runs the inventory tests. A static graph cannot see computed imports or paths, so this is a recall heuristic, never a merge oracle | Edit loop only | An edit to `operations/rs-records-detail/index.ts` runs 1 file (12 tests) in 1.5 s wall. `server/search.ts` selects 37 files and `server/records.ts` 133; an SQL edit falls back to 1,181 |
| full, memory profile | `PDPP_TEST_PROFILE=memory-default npm test` | Every test file against the in-memory profile, inside `test-sandbox` | Before you push, and as the CI gate | 1,159 files, about 11,700 tests. 542.8 s wall, 2,769 CPU-s, 4.4 GB peak, on a 24-core host under 800% CPU (load about 26) |
| PostgreSQL | `npm run test:postgres` | The same files against a disposable PostgreSQL 18 cluster, started for this run only, on `127.0.0.1:55447` inside the sandbox's own network namespace | Before you push a change to storage, migrations, search or records | 1,159 files, 12,072 pass, 19 skip. About 39 min at concurrency 2 on this host |
| CI | pull request and push to `main` | The memory profile is the required RI gate. The PostgreSQL lane runs nightly in `.github/workflows/reference-implementation-postgres.yml`. Mutation testing is advisory and diff-aware. `test-scratch-lifecycle` checks the scratch-directory code | Every PR; nightly for PostgreSQL | Memory gate: test step 1,159 s, job about 21.6 min p50 on success. Nightly PostgreSQL: 12,140 tests, 0 failures, 32.6 min |

CI sets `TEST_SANDBOX_DISABLE=1`, because the hosted VM is the isolation boundary. The PostgreSQL lane
installs pgvector 0.8.7 from PGDG and runs a 300 s idle watchdog. Pull requests into
`testeng/integration` skip CI. The batch PR from that branch into `main` runs it.

The full gate and the PostgreSQL run use the memory and PostgreSQL profiles of one runner,
`scripts/run-tests.ts`. Both commands run under `scripts/test-scratch/run-command.ts` and
`scripts/test-sandboxed.sh`. The sandbox puts the run in a cgroup scope in the shared
`agent-tests` slice with a loopback-only network, so concurrent agents share one CPU and memory
budget. It prints one JSON receipt with wall time, CPU-seconds and peak memory.

### pgvector for local PostgreSQL runs

The semantic tests need pgvector. `npm run test:postgres` uses the server's own copy. If the
server has none, unpack the package and name its root. This works on PostgreSQL 18 and needs no
root access:

```
mkdir -p ~/.tmp/pgvector && cd ~/.tmp/pgvector
apt-get download postgresql-18-pgvector
dpkg-deb -x postgresql-18-pgvector_*.deb .
PDPP_TEST_PGVECTOR_ROOT=$HOME/.tmp/pgvector npm run test:postgres
```

The path must be absolute. `scripts/test-postgres-private.sh` points the private cluster's
`extension_control_path` and `dynamic_library_path` at it and does not touch the system install.

## Isolation contract

| Scope | What | Why |
|---|---|---|
| Shared, read-only | `node_modules`, the toolchain, builds | Immutable inputs; installing or building per worker is pure cost |
| Per run | The sandbox scope and network namespace; the scratch directory (`TMPDIR`), owned by `scripts/test-scratch/run-command.ts`; the private PostgreSQL cluster; one schema template, built only when a template-eligible file is selected | Another run's scratch, network and databases cannot be reached |
| Per file | Its own child process; its own PostgreSQL database, created from the template or cold, as `scripts/postgres-template-eligibility.ts` says; a cold restore database for the backup test | A test file owns its database and cannot see another file's rows |
| Per test | State the test creates and removes itself (temp roots, rows, spawned children) | Tests clean up their own state |
| Locked or serial | File concurrency: 8 for the memory profile, 2 for PostgreSQL, clamped by CPU count and file count | More workers than CPUs only adds memory and trips timeouts |

The runner owns every database it creates. It registers a database right after `CREATE`, rolls it back if
set-up fails, and never drops a database it did not create. On SIGINT or SIGTERM it stops admitting
files, stops the children, then drops its databases (PR #504).

A hermetic guard blocks non-loopback HTTP inside the test child processes. The sandbox's network
namespace blocks the rest.

## Rules

- The oracle for a PR into `testeng/integration` that changes RI code is the full RI gate in the sandbox (`PDPP_TEST_PROFILE=memory-default npm test`, plus `npm run test:postgres` for storage, search or records changes), not `test:fast`.
- A bug fix comes with a test that fails without the fix. Prove it by seeding the fault (see
  the next section).
- A new PostgreSQL test file must be classified in `scripts/postgres-template-eligibility.ts`.
  The inventory test (`test/postgres-template-eligibility-inventory.test.ts`) fails if it is not.
- Run every test command through `test-sandbox` or `test-receipt` on a shared host. The `npm`
  scripts above already do.
- Never point a test at a shared or production database. The PostgreSQL tests accept only a database
  the runner made and stamped with the guard sentinel.
- No automatic retries. A flaky test is a bug: find the cause and fix it.

## Regression tests for correctness gaps

Every behavior fix ships with a test that fails on the old code and passes on the new code.
A gap test that cannot fail when its guard is removed is not accepted.

How a gap test is proven (2026-10-18 gap pass, 46 rows + 5 scheduler findings):
1. Write the test against current code.
2. Seed the fault named in the gap (remove the guard, move a write out of its transaction,
   drop a CAS predicate), or run against the unfixed product files. The test must fail on the
   named assertion. A crash, transform error or skip is not a failure.
3. Revert the fault. The test must pass with `skipped 0`.
4. Paste both outputs in the PR body.

Running selected RI test files: list them, one RI-relative path per line, and pass the list to
the normal entry points, which keep the sandbox, the per-file databases and the hermetic guard:
- memory profile: `PDPP_TEST_PROFILE=memory-default npm test -- --files-from list.txt`
- PostgreSQL: `npm run test:postgres -- --files-from list.txt` (the private cluster, sentinel and
  per-file database come with it; no manual setup)
- New PG test file: register it in `scripts/postgres-template-eligibility.ts` (eligible if it only uses
  Postgres as seeded data; cold-required if it observes bootstrap or migration), update the counts in
  `PG-PROFILE-51-REPORT.md`, and run `test/postgres-template-eligibility-inventory.test.ts` before the PR.
  Then run `npm run test:postgres` once: it is the check that the file works under the runner.

What the pass found (real product bugs, each fixed with its test):
connector uninstall recovery deleting outside the data directory through a symlink (#466),
journal identity mismatch (#467), lost activation-cleanup retry (#468), lexical rows surviving lost
metadata (#481), dirty mark cleared with orphan vectors (#482), lexical rebuild ignoring abort (#483),
quarantine overwriting a concurrent recovery (#477), leases stranded after a partial claim (#478),
detail-gap pages over their byte budget (#479), plus two contract fixes (#471, #480).

### Crash and race tests (process kill)

`test/helpers/crash-harness.ts` kills a child process at a named point in product code, then the
test reopens the same SQLite file, Postgres database or data directory and checks recovery.
- Product code marks a boundary with `crashPoint("<area>:<before|after>-<step>")`
  (`server/crash-point.ts`; production installs no hook, so it is a null check).
- A child script (`test/fixtures/crash/*-child.ts`) calls `armCrashPoints()` first, then does real work.
- The parent: `killChildAt(script, point, { args, env })`, or `spawnCrashChild(script, { points })` with
  `parked(point)`, `resume()`, `kill()` for multi-point kills and for N processes released together
  (contention). A point the child never reaches fails the test. Parking is a blocking pipe read, not a sleep.
- Children still alive when a test file ends are killed; a child whose parent dies kills itself.
- Each child costs about 100 ms. Postgres children need their own admitted test-database attachment.
- Limit: SIGKILL keeps the kernel page cache. These tests prove recovery after a process crash at each
  boundary; they do not prove that an fsync is present or enough (that needs power loss or a
  fault-injecting filesystem). SQLite runs WAL with `synchronous = NORMAL` (`server/db.ts:6236-6237`).
- In-process await races (storage close and re-init during an await) use the async
  `__set...PhaseHookForTest` seams instead; `crashPoint` is synchronous and cannot pause an await.

Formatting: `reference-implementation/biome.jsonc` has `root: false` and the repo has no root Biome
config, so a bare `npx biome` falls back to defaults (tabs). Format new RI files with the RI config.

What round 2 found (each fixed with its test): uninstall recovery that could never finish after a kill
at the last step, so the server could not start (#498); a symlinked uninstall-journal directory
followed outside the data directory (#499); grant and package revocation committed statement by
statement, so a kill left revoked grants with live tokens (#505; it also takes locks in the same order as
refresh and consent issuance, so the new transaction cannot deadlock with them); deferred index work writing into a replaced
database (#501). Contract questions found by the crash tests are listed for the owners rather than
pinned as behaviour.

Still open by decision, not by missing tooling: Postgres retained-size projection drift after a crash,
SQLite shared-blob orphan after a failed teardown (documented known gap), version-counter healing
parity, restaging a terminal OAuth request, and two install crash states (unregistered unlisted first
install, retained root with no active record).

## Gap to excellence

Compared with the practices in the cross-project survey of mature test suites (Kubernetes, Shopify,
Meta, Django, Chromium, SQLite and others; `test-suite-excellence/` in the divan research corpus).
CI numbers are from `reference-implementation.yml` over the 30 days to 2026-10-18.

| Practice | Exemplar | Ours (measured) | Status |
|---|---|---|---|
| Fast pre-merge gate with a time budget | Kubernetes presubmit under 1 h, preferably under 30 min. Chromium median trybot cycle under 40 min | RI job about 21.6 min p50 on success (p95 22.7 min) | Closed |
| Affected-only selection with measured recall | Shopify 99.94% recall (5 missed failures in 8,360 commits). Meta over 95% of failures | `test:fast` selects by import distance. Recall measured on 1 sample only | Open: replay 100 or more merged commits against full-run results |
| Full-run backstop behind selection | Shopify runs full suites for every deployed commit | A push to `main` runs the full gate | Closed |
| Tiering by cost, with a scheduled tier | OpenJDK tier1 to tier4. CockroachDB nightly lanes | `test:fast`, memory gate on every PR, PostgreSQL lane nightly (32.6 min) | Closed |
| Flake policy: no retries, owned quarantine, flake tracking | Kubernetes bans retries and assigns each flake to an owner. Firefox disables a test at 150 failures in 21 days | No retries. No quarantine owner process and no flake-rate tracking. Known load flakes fixed in #513 (2) | Open |
| Green rate with a stated target | Node.js targets 80% for PRs and 90% for daily master | `main` 90.3% (28 of 31 pushes). PRs 70.9% (596 of 841 completed). 14 of 20 re-run PRs went green after a failed first attempt | Open: no target stated, no tracking |
| Regression test per fix | Django, TypeScript and Node.js require one that fails before the fix | `AGENTS.md` has a soft rule ("when feasible"). Testeng lanes enforce it by review with a seeded-fault proof | Partly closed |
| Coverage ratchet | Dropbox Android non-decreasing coverage; Chromium 70% incremental on some teams | None | Open |
| Multi-backend matrix | Django runs PostgreSQL, MySQL and others, each at its own tier | Memory on every PR, PostgreSQL nightly | Closed |
| Hermeticity and isolation | Kubernetes unit tests must be hermetic. Django reports wall and CPU time apart | Sandbox, per-file databases and the hermetic guard; each run reports wall, CPU-s and peak memory | Closed |
| Harness self-tests | CPython tests the runner's own discovery count | Discovery and accounting tests exist (`run-tests-discovery.test.ts`, `scripts/test-accounting`) | Closed |
| Test the tests (mutation) | SQLite mutation-tests its core | Mutation is advisory and diff-aware. It exposed two latent cohort defects, fixed in #517 | Partly closed |
