# PostgreSQL profile #51: failure classification

Date: 2026-09-02

## Status

The attempted 1,034-file PostgreSQL profile was stopped after 265 observed file
headings and 158 `test:fail` events. It did not produce a terminal accounting
receipt. It is invalid as a performance or correctness result and is not used
for any pass/fail, completed-file, assertion-total, or wall-time claim.

The corrected replacement profile subsequently completed and emitted a terminal
accounting receipt; its result is recorded below.

## Replacement-oracle setup

The first replacement launch was rejected before test discovery or execution:
the runner requires the dedicated loopback listener at `127.0.0.1:55447`, and
the initially-created replacement listener was on `55451`. Its complete tail
was `PDPP_TEST_POSTGRES_URL must be a query- and fragment-free dedicated
loopback PostgreSQL test URL`, followed by `WALL_SECONDS=0.31`; it is not a
profile result.

The required listener is now a fresh `postgres:16-alpine` container on
`127.0.0.1:55447`. It reports PostgreSQL server 16.15 and `pg_dump` 16.15.
The prior stopped `pgvector/pgvector:pg16` test container was preserved (not
deleted) before the port swap. Fresh, distinct primary and restore databases
were created and sentinel-provisioned:

```text
Provisioned test database sentinel.
Provisioned test database sentinel.
pdpp_test_pg51_a1b2c3d4_1
pdpp_test_restore51_a1b2c3d4_2
active connections: 0
```

The replacement profile uses Node 22.23.1, `NODE_OPTIONS=--import=tsx`, these
two databases, and `PDPP_TEST_POSTGRES_CLIENT_IMAGE=postgres:16-alpine`.

## Replacement full PostgreSQL profile: terminal receipt

Command environment: Node 22.23.1 from the explicit `PATH`,
`NODE_OPTIONS=--import=tsx`, `postgres:16-alpine` server and client tools on
`127.0.0.1:55447`, the two sentinel-marked dedicated database URLs above, and
concurrency 2.

```text
PDPP_TEST_ACCOUNTING_RESULT
assertions:      10,550
passed:          10,392
failed:             140
skipped:             18
planned_files:    1,034
completed_files:      0
receipt files:    1,034
observed headings:1,034
WALL_SECONDS=2288.87
```

The run completed its process and produced the receipt after 38m 8.87s. The
literal `completed_files: 0` is a known runner-accounting convention, not an
observation that no files ran: `scripts/run-tests.ts` assigns
`completed_files: failed ? 0 : results.length`. The receipt itself lists 1,034
files and the log contains 1,034 file headings. Both values are retained so
the result is not overstated.

The 140 terminal failures are not the previous Node-24 bare-child cascade.
The largest remaining clusters are 60 pending-promise cancellations across six
controller/run tests; 40 missing Docker/site fixture paths; and 13 PostgreSQL
vector-extension/function failures. The latter is an explicit gap in this
exact requested `postgres:16-alpine` oracle: its stock PostgreSQL 16.15 image
does not provide the `pgvector` extension required by the semantic/HNSW tests.
No test was skipped or relabelled by this work. The result is complete but not
green.

The only cap-2 baseline in the sibling report is memory-default, not a
pre-template PostgreSQL profile: 10,252 assertions, 9,690 passed, 209 failed,
353 skipped, and about 10 minutes. Relative to that non-comparable baseline,
this profile has +298 assertions, +702 passes, -69 failures, and -335 skips;
its 38m 8.87s wall time must not be used as a template-performance comparison
because it uses PostgreSQL rather than the memory-default backend.

## Watchdog repair commit

The watchdog repair was verified again immediately before commit with the
corrected Node 22 PostgreSQL oracle, then committed separately as
`0647c2e61bb67c1b3067002821324b1628f7577d`
(`fix(test): fail reconcile race fixture protocol errors promptly`). The commit
is GPG-valid, authored by `tnunamak@gmail.com`, DCO-signed, and ends with the
`Assisted-by: AI` trailer. Only
`reference-implementation/test/polyfill-manifest-reconcile-invalidation-postgres.test.ts`
is in that commit.

The commit was pushed to PR branch `port/gate-speed-278-0902`; the remote head
was verified as `0647c2e61bb67c1b3067002821324b1628f7577d`.

Fresh pre-commit command tail:

```text
test_exit=0
1..8
# tests 8
# pass 8
# fail 0
# cancelled 0
# skipped 0
# duration_ms 7991.609645
```

## Classification of the 158 observed failure events

| Signature | Events | Files | Clean-main comparison | Classification | Root cause |
| --- | ---: | ---: | --- | --- | --- |
| `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` from bare Node child processes | 137 | `cli-ref-wrapper`, `cli`, `compact-record-history-dry-run-all`, `compact-record-history`, `connector-registry-manifest-derivation` | Clean `pdp/main` at `a72cb53a8` reproduces it in `cli-ref-wrapper`, `compact-record-history*`, and registry derivation under the same PostgreSQL variables and Node 24. The clean-main wrapper passes 8/8 under the corrected Node 22 + `NODE_OPTIONS=--import=tsx` launch. | Pre-existing invalid-oracle failure; not template cloning | The run used Node 24.19.0 although the repository declares `>=22.14.0 <24`. Bare `node file.ts` children then attempt unsupported type stripping in linked workspace packages. |
| Assertions/timeouts cascading from that child-process failure | 16 | `cli`, `connector-registry-manifest-derivation` | Clean-main CLI wrapper has the same child-process failure under Node 24; a corrected clean-main CLI run had passed its first 55 subtests when deliberately stopped after the representative proof. | Pre-existing invalid-oracle cascade; not template cloning | Expected command output was replaced by the Node type-stripping error, causing assertion mismatches and device-flow timeouts. |
| Missing `@opendatalabs/remote-surface/.../backend.js` | 1 | `server/streaming/cdp-method-allowlist` | Exact clean-main reproduction: the same file is absent after its clean install. | Pre-existing local dependency-artifact failure; not template cloning | The installed `remote-surface` package has no requested CDP backend artifact. |
| Missing `apps/site/content/docs/reference-implementation-examples.md` | 1 | `b6-single-use-consumption-conformance` | Exact clean-main reproduction after workspace artifacts were built. | Pre-existing repository fixture failure; not template cloning | The unchanged test reads a documentation file that is absent from both worktrees. |
| Missing `spec-collection-profile.md`, plus its umbrella subtest failure | 2 | `collection-profile` | Exact clean-main reproduction after workspace artifacts were built. | Pre-existing repository fixture failure; not template cloning | The unchanged test reads a root-level specification file that is absent from both worktrees. |
| `pnpm --dir apps/console build`: `next: not found` | 1 | `composed-origin` | Clean main also fails before a test result, but with untranspiled linked `@pdpp/polyfill-connectors` source during its console build. | Invalid local build oracle; not template cloning | The current checkout lacks the console's `next` executable; the clean build exposes a separate workspace-artifact setup issue. The template diff does not touch the test, console, or dependencies. |

The table totals 158 events. There is no dominant **new** template-cloning
failure among them, so no test was skipped or relabelled to make the run green.

## Oracle corrections before a replacement profile

Use this launch environment, in addition to the dedicated test URLs:

```sh
PATH=/home/tnunamak/.local/share/mise/installs/node/22.23.1/bin:$PATH
NODE_OPTIONS=--import=tsx
PDPP_TEST_PROFILE=postgres
PDPP_TEST_CONCURRENCY=2
PDPP_TEST_POSTGRES_URL=postgresql://postgres@127.0.0.1:55447/pdpp_test_profile51_a1b2c3d4_1
PDPP_TEST_POSTGRES_RESTORE_URL=postgresql://postgres@127.0.0.1:55447/pdpp_test_restore51_a1b2c3d4_2
PDPP_TEST_POSTGRES_CLIENT_IMAGE=postgres:16-alpine
```

The original host `pg_dump` is PostgreSQL 18.6 while the dedicated server is
PostgreSQL 16.15. It is therefore not an “older client than server” case; it is
still an incompatible major. `postgres:16-alpine` supplies the matching client
through the existing `PDPP_TEST_POSTGRES_CLIENT_IMAGE` path. The URLs name
dedicated, sentinel-marked databases rather than the occupied shared
`pdpp_test`; no shared restore database was used for this classification.

## Watchdog finding and repair

`polyfill-manifest-reconcile-invalidation-postgres.test.ts` is explicitly
cold-required and never receives a template clone. Its prior 120-second
watchdog event was a real silent protocol failure, not slow clone progress:
the race fixture was spawned as bare Node and failed to import TypeScript from
linked `node_modules`; its parent then waited indefinitely for a JSONL line.

The repair starts the fixture with `--import tsx`, captures stderr, and rejects
pending line-protocol waiters when the child exits or errors. Fresh verification
tail:

```text
1..8
# tests 8
# pass 8
# fail 0
# skipped 0
# duration_ms 11360.123334
```

## Scope counts and comparison baseline

`scripts/run-tests.ts` discovers 1,034 profile files. The template equivalence
registry is a different measure: 123 eligible plus 25 cold-required files,
for **148** total. No current tracked source contains a 170-file claim.

The sibling report supplies only a memory-default cap-2 baseline (10,252
assertions, 9,690 passed, 209 failed, 353 skipped; about 10 minutes). It is not
a pre-template PostgreSQL baseline and must not be compared with a future
PostgreSQL receipt.

## Command tails retained for review

```text
$ PATH=.../node/22.23.1/bin NODE_OPTIONS=--import=tsx node --test --import tsx test/cli-ref-wrapper.test.ts
1..8
# tests 8
# pass 8
# fail 0

$ node --import tsx --input-type=module ...
template_equivalence_files=148

$ git diff --check
(no output)
```

The interrupted-run event log is retained at
`/home/tnunamak/.tmp/pg-profile-51/full-profile.log`; clean-main comparison
logs are retained under `/home/tnunamak/.tmp/pg-profile-51/`.
