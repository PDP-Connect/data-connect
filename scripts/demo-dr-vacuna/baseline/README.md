# DR vaccination reminders: reference-implementation throughput baseline

Measures how many authorized single-record reads per second the PDPP
reference implementation (`reference-implementation/`) sustains on Postgres
with the DR pilot access pattern: one reminder service (public OAuth client),
one grant per child, each grant limited to that child's record via
`resources: [child_id]`. Results: [RESULTS.md](./RESULTS.md).

No server code is changed. The harness only sets env vars the server already
reads, plus one experiment-only preload (see "Pool-size experiment").

## Prerequisites

- Node 24 (`mise` has 24.21.0; the root `package.json` wants >= 24.15).
- Docker (tested with OrbStack). Uses `pgvector/pgvector:pg16`, as
  `reference-implementation/docs/migrate-storage.md` recommends.
- Dependencies installed and the workspace packages the server imports built:

```sh
npm install --ignore-scripts          # postinstall fetches connectors; not needed
npm rebuild better-sqlite3
(cd reference-implementation/vendor/read-core && npm run build)
(cd reference-implementation/vendor/mcp-server && npm run build)   # also builds vendor/cli
npm run build --workspace=@pdpp/connector-protocol --workspace=@pdpp/collector-runtime
```

## Run

All commands from this directory. State (owner token, client id, real-flow
tokens, server logs) goes to `.state/` (git-ignored) or `$VACUNA_STATE_DIR`.

```sh
./db.sh up                         # Postgres on 127.0.0.1:55432 (pdpp/pdpp)
./start-server.sh &                # AS :7662, RS :7663, loopback only
node seed.ts                       # ~20 min; see "Seeding" below
node loadgen.ts --label my-run     # ramp 4..128 concurrency, 30 s stages
./run-matrix.sh                    # the five configurations in RESULTS.md
./db.sh stop                       # keep the seeded data; ./db.sh start reuses it
./db.sh down                       # remove the container and its data
```

`start-server.sh` sets `PDPP_STORAGE_BACKEND=postgres`,
`PDPP_DATABASE_URL`, `AS_PORT`/`RS_PORT`, `PDPP_DB_PATH` (scratch),
`PDPP_SEMANTIC_EMBEDDING_BACKEND=disabled`, `PDPP_EMBEDDING_DOWNLOAD_ALLOWED=0`
(no model downloads), `PDPP_SKIP_AUTO_SCHEDULE_ENROLLMENT=1`,
`PDPP_RECONCILE_POLYFILL_MANIFESTS=0`, `PDPP_RUNTIME_QUIET=1`, and unsets
owner-password variables. It does not load any `.env` file. `serve.ts` calls
the exported `startServer()` with `bindHost: "127.0.0.1"`: the CLI entry
binds all interfaces and this instance has no owner password.
`VACUNA_SERVER_LOGS=1` turns server logging on.

## Seeding

`node seed.ts` runs these phases (`--phase <name>` runs one):

| Phase | What | Path |
|---|---|---|
| `bootstrap` | register the synthetic registry source manifest, owner token via device flow, reminder client via DCR (`token_endpoint_auth_method: none`) | real HTTP API |
| `records` | first 20,000 children | real `POST /v1/ingest/child_immunizations` (serial; parallel batches fail) |
| `bulk-records` | remaining children up to 1,000,000 | **direct SQL** into `records` + `record_changes` |
| `real-grants` | grants for children 1..2,000 | real `POST /oauth/par` -> `/consent/review` -> `/consent/approve` |
| `bulk-grants` | grants for children 2,001..980,200 | **direct SQL**: clones grant #1's row, rewrites `grant_id` and `resources` |
| `revoke` | every 100th grant (9,802) | real `POST /grants/:id/revoke` with the grant's own bearer |
| `prepare` | `VACUUM ANALYZE` + `CHECKPOINT` | SQL |

Why the bypasses, and exactly what they skip, is in RESULTS.md ("Seeding").
Bulk-inserted tokens are `sha256("vacuna-baseline-token:<i>")` so the load
generator can rebuild them; real-flow tokens are kept in
`.state/real-tokens.json`.

Data (`lib/dataset.ts`) is a pure function of a fixed seed and the child
index: birth dates over the five years before 2026-10-01, a simplified
PAI schedule (BCG, HepB, Pentavalente x3, Polio x3 + 2 boosters, Rotavirus
x2, Neumococo x3, SRP x2, DPT boosters x2), per-dose coverage 78-97%, a
missed dose halting that series, 1,400 centre codes (85% of a child's doses
at one home centre), and `next_dose_due`.

## Load generator

`loadgen.ts` is closed-loop (N lanes, each sends the next request as soon as
the previous one returns) using undici with N keep-alive connections. Mix
per request, matching the pilot's 400,000 denied of 4,320,800:

- 90.74% `ok`: child i's token reads child i's record (expect 200)
- 4.63% `revoked`: a revoked grant's token (expect 403)
- 4.63% `cross`: child i's token reads child j's record (expect 404)

Anything else (wrong status, connection error, 10 s timeout) is an error.
Each stage: 5 s warm-up, 30 s measured. The ramp stops at the first stage
with error rate > 0.1% or p95 > 500 ms. Per stage it records throughput,
p50/p95/p99, server process CPU (`ps`), Postgres container CPU
(`docker stats`), mean `pg_stat_activity` wait events, WAL bytes, checkpoints,
a per-second throughput timeline, and the audit check: spine rows written
during the stage vs. requests answered (`query.received` must equal requests).
Output: `results/<timestamp>-<label>.json`.

## Pool-size experiment

The interactive pool size is a constant
(`reference-implementation/server/postgres-storage.ts`,
`POSTGRES_INTERACTIVE_POOL_MAX = 8`), not configurable. To measure what a
bigger pool would do without editing server code,
`experiment-pool-override.ts` is a Node `--import` preload that wraps
`pg.Pool` and replaces `max: 8` with `VACUNA_PG_POOL_MAX`. It is a
measurement aid only, not a supported knob. `experiment.sh <label> <pool|default> <synchronous_commit>`
restarts the server with or without it and sets Postgres
`synchronous_commit` via `ALTER SYSTEM`.
