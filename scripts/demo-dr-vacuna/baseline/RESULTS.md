# Baseline results: reference implementation, DR vaccination-reminder reads

Measured 2026-10-14 on branch `demo/dr-vacuna` (from `origin/main` d21a9dcb).
Raw data: `results/*.json`; tables below come from `node summarize.ts results/*.json`.

## Summary

- **Stock configuration sustains ~460 authorized reads/s** (three runs: 437,
  492, 451 req/s; ~90.7% are 200s, the rest expected 403/404 denials) with
  0 errors and p95 54-124 ms at the sustaining stage. Throughput is flat from
  16 to 128 concurrent clients; added concurrency only adds latency, and p95
  crosses 500 ms at 128-256 concurrent.
- **Bottleneck: the two synchronous audit (spine) INSERTs per read, funnelled
  through the hard-coded 8-connection interactive pool.** At 16+ concurrent,
  4-7 of the 8 connections are on average waiting on WAL flush
  (`LWLock/WALWrite`, `IO/WALSync`) for `INSERT INTO spine_events`; server
  CPU stays ~50%, Postgres ~1 core.
- **Projection: 4,320,800 requests unpaced at ~460 req/s take ~2.6 h**
  (2.44-2.74 h across runs).
- **Audit:** 100% of answered requests produced a `query.received` row in
  every passing stage; 200s add `disclosure.served`, denials add
  `query.rejected` (exactly 2.0 spine rows per request, ~4.3 KB WAL per
  request, ~1.58 KB stored per row). One gap: when the RS-to-AS introspection
  HTTP call fails, the RS answers 401 and writes no audit row (seen at
  ~1,500 req/s, below).
- Two config experiments: pool 32 gives ~800 req/s (+70%);
  `synchronous_commit=off` gives ~940 req/s with pool 8 (2.0x). Combining both
  hits a different wall at ~1,500 req/s offered: per-request TCP connection
  churn (the server forces `Connection: close`) exhausts loopback ports and
  56% of requests fail.

## Prior facts checked

| Claim | Verdict |
|---|---|
| Postgres pool is 8 connections | True for the interactive lane: `POSTGRES_INTERACTIVE_POOL_MAX = 8` (`server/postgres-storage.ts:119`), a constant, no env var. Plus a 3-connection bulk lane and a 1-connection lock lane. |
| Each read writes 2+ audit rows | Exactly 2 per record read (2.000 rows/request in every passing stage): `query.received` + `disclosure.served`, or `query.received` + `query.rejected` for denials. Separate autocommit INSERTs. |
| Revocation checked per request, no cache | True, and it is an HTTP call: the RS POSTs to the AS `/introspect` on 127.0.0.1 per request (`server/index.ts:6802`), which runs a `tokens` JOIN `grants` query. |
| Only public clients | True: `SUPPORTED_CLIENT_AUTH_METHODS = new Set(["none"])` (`server/auth.ts:869`). |
| Single-owner sign-in | True: `server/owner-auth.ts:12` "single-password, single-owner model". All 980,200 grants here belong to one owner subject. |

## Machine and setup

| | |
|---|---|
| Host | Apple M4 (10 cores: 4P + 6E), 16 GB RAM, macOS 26.6.2 |
| Docker | OrbStack, Docker Engine 29.4.0; VM with 10 vCPU, 7.8 GiB |
| Postgres | `pgvector/pgvector:pg16` (16.15) in that VM; `shared_buffers=1GB`, `max_connections=200`, `track_io_timing=on`, else stock (`max_wal_size=1GB`, `synchronous_commit=on`) |
| Server | Node 24.21.0, one process (AS and RS together), `server/index.ts` `startServer()` via `serve.ts` |
| Load generator | Node + undici, same host, closed loop |
| Noise | Shared workstation: another container (NVR, ~0.6 core) and desktop apps running, host load average 9-16. Fsync in the VM is fast on average (`pg_test_fsync`: fdatasync ~780 us) but stalls: 1-3 s windows with all 8 connections in WAL wait and near-zero throughput (`rps_timeline` in the JSON). |

Treat absolute numbers as indicative for this class of hardware; the ratios
between configurations are the more robust result. The stock configuration
was run twice in the matrix (plus one earlier exploratory ramp: 437 req/s at
8 concurrent, degrading to 178 req/s at 64) to show the spread.

## Dataset and grants

| | Count | How |
|---|---:|---|
| Child records (`child_immunizations`) | 1,000,000 | 20,000 via `POST /v1/ingest`, 980,000 by SQL |
| Avg doses per record / JSON size | 13.1 / ~1.24 KB | `lib/dataset.ts`, seed 20261014 |
| Grants (one child each, `resources: [child_id]`) | 980,200 | 2,000 via PAR + consent, 978,200 by SQL |
| Revoked grants | 9,802 (every 100th) | real `POST /grants/:id/revoke` |
| Active grants | 970,398 | |
| Reminder client | 1 | DCR, public (`token_endpoint_auth_method: none`) |
| Database size after all runs | 8.0 GB | includes 1.74M spine rows (2.6 GB) from the tests |

### Seeding: what was bypassed

Real API throughput on this machine (relevant for pilot onboarding):

| Path | Rate | Time for full pilot volume |
|---|---:|---:|
| `POST /v1/ingest` (2,000-record batches, serial) | 42 records/s | 1M records: 6.6 h |
| `POST /v1/ingest`, 4 parallel batches | fails: `ingest_batch_storage_error` | |
| PAR -> `/consent/review` -> `/consent/approve` (8 parallel) | 23 grants/s | 980,200 grants: 11.7 h |
| `POST /grants/:id/revoke` (8 parallel) | 84 revocations/s | |

Bypassed, in `seed.ts`:

- **Records 20,001-1,000,000** (`bulk-records`): inserted into `records` and
  `record_changes` with the same connector instance, monotonically increasing
  `version`, and `cursor_value`/`semantic_time` = `updated_at`, matching the
  rows ingest wrote for the first 20,000. Row triggers disabled during the
  load (`session_replication_role=replica`), with the one per-instance
  `source_revision` bump applied afterwards. Not updated: retained-size and
  connector-summary read models, `mutation.*` spine events. The record read
  path does not read those.
- **Grants 2,001-980,200** (`bulk-grants`): `grants` rows cloned from real
  grant #1 (same `grant_json` shape, `storage_binding_json`, client,
  subject, `instance_ids`) with `grant_id` and `streams[0].resources`
  rewritten, plus one `tokens` row each (token = sha256 of a fixed string and
  the child index). Skipped: PAR/pending-consent rows and the
  `request.submitted`, `consent.approved`, `grant.issued`, `token.issued`
  spine events (8,000 such events exist for the 2,000 real grants).
  Introspection reads only `tokens` + `grants`, so reads treat cloned and
  real grants identically (verified: 200 own record, 404 another child, 403
  revoked, for both kinds).
- All grants are approved by the single owner `owner_local`: the reference AS
  has one owner (`server/owner-auth.ts`, "single-password, single-owner
  model"), so 650k distinct parents cannot be represented.

## Access pattern

Per request (`loadgen.ts`): 90.74% a random active child's token reading its
own record (expect 200); 4.63% a revoked grant's token (expect 403); 4.63% a
child's token reading a different child's record (expect 404). This is the
pilot's 400,000 denied of 4,320,800. Records are picked uniformly from
980,200, so the working set (~1.2 GB of records plus grant/token indexes)
mostly fits in `shared_buffers` plus the VM page cache. Stage: 5 s warm-up,
30 s measured; stop at errors > 0.1% or p95 > 500 ms.

## Results

"Sustained" = highest-throughput stage meeting both criteria.

| config | sustained req/s | of which 200 | at conc | p50 / p95 / p99 ms | errors | max passing conc | first failing conc | hours for 4,320,800 |
|---|---:|---:|---:|---|---:|---:|---|---:|
| pool 8, sync commit on (stock), run a | 492.4 | 446.4 | 16 | 29.6 / 53.6 / 95 | 0.000% | 128 | 256 (p95 861 ms) | 2.44 |
| pool 8, sync commit on (stock), run b | 450.6 | 408.4 | 32 | 63.6 / 124.3 / 195.2 | 0.000% | 64 | 128 (p95 605 ms) | 2.66 |
| pool 32*, sync commit on | 799.6 | 725.4 | 32 | 33.6 / 78.1 / 138.9 | 0.000% | 128 | 256 (p95 603 ms) | 1.50 |
| pool 8, sync commit off | 944.3 | 855.8 | 16 | 15.5 / 29 / 43.6 | 0.000% | 256 | none | 1.27 |
| pool 32*, sync commit off | 892.6 | 808.9 | 8 | 7.9 / 16 / 24.6 | 0.000% | 8 | 16 (55.9% errors) | 1.34 |

\* Pool size is not configurable; 32 was set by the experiment-only preload
`experiment-pool-override.ts`. `synchronous_commit` is a Postgres setting
(`ALTER SYSTEM`); turning it off risks losing the last few hundred ms of
committed audit rows on a Postgres crash.

Stock run a, every stage:

| conc | req/s | ok/s | p50 | p95 | p99 | err | server CPU | PG CPU | audited / answered | rejected / denied | WAL B/req |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 4 | 466.7 | 423.6 | 7.6 | 14.7 | 26.5 | 0.000% | 55.5% | 85.6% | 16254 / 16254 | 1500 / 1500 | 9533 |
| 8 | 395.5 | 358.5 | 15.5 | 33.4 | 92.7 | 0.000% | 47.3% | 87.8% | 14887 / 14887 | 1375 / 1375 | 4359 |
| 16 | 492.4 | 446.4 | 29.6 | 53.6 | 95 | 0.000% | 54.1% | 104.3% | 17279 / 17279 | 1633 / 1633 | 4274 |
| 32 | 435.8 | 396 | 61.8 | 105.1 | 292.6 | 0.000% | 48.1% | 89.9% | 15482 / 15482 | 1428 / 1428 | 4252 |
| 64 | 483.8 | 436.9 | 125.1 | 201.2 | 257 | 0.000% | 53.3% | 97.1% | 16720 / 16720 | 1592 / 1592 | 4262 |
| 128 | 469.4 | 427.4 | 241.8 | 420.1 | 1740.7 | 0.000% | 49.7% | 107% | 16668 / 16668 | 1508 / 1508 | 4261 |
| 256 | 441.7 | 402.6 | 574.8 | 861.4 | 1435.3 | 0.000% | 53.9% | 104.4% | 16895 / 16895 | 1496 / 1496 | 9227 |

CPU columns are percent of one core (`ps` for the Node process,
`docker stats` for Postgres). WAL per request is ~4.3 KB in steady state and
9-19 KB right after a checkpoint (full-page writes); the first stage of each
run starts just after a forced `CHECKPOINT` and is the noisiest.

## Bottleneck evidence

Per authorized read the server does (traced with
`log_min_duration_statement=0` on one request):

1. Loopback HTTP `POST http://127.0.0.1:7662/introspect` from the RS to the
   AS in the same process (`server/index.ts:6802`,
   `server/introspection-http.ts:259`), which runs one `tokens` JOIN `grants`
   query (`server/auth.ts:8038`). No cache: revocation is checked on every
   request.
2. Three more SELECTs: connector manifest, connector instance, the record
   (`idx_pg_records_lookup`).
3. Two separate autocommit `INSERT INTO spine_events ... RETURNING *`
   (`lib/postgres-spine.ts:1155`): `query.received`
   (`server/routes/rs-read.ts:1958`) and `disclosure.served`
   (`rs-read.ts:2022`), each awaited before the response. Each insert
   maintains 15 indexes and runs 2 row triggers on `spine_events`
   (`server/postgres-storage.ts:2928` onward), and each commit waits for a
   WAL flush.

Evidence the audit commits saturate the pool:

- Throughput is flat at ~430-490 req/s from 16 to 256 concurrent while server
  CPU stays at ~50% and Postgres at ~1 core of 10. Latency grows linearly
  with concurrency (p50 30 -> 575 ms): requests queue for the 8 connections.
- `pg_stat_activity` sampled every second (both stock runs, 16+
  concurrent): 5.5-7.6 of the 8 interactive connections busy on average, of
  which 3.3-6.3 in `LWLock/WALWrite` and 0.9-1.0 in `IO/WALSync`, on
  `INSERT INTO spine_events`. A separate 0.3 s sampler over 45 s at 8
  concurrent: 68% of active-backend samples were spine INSERTs in WAL waits,
  8% spine INSERTs on CPU, 13% the introspection SELECT, 6% the record
  SELECT.
- Removing the flush wait (`synchronous_commit=off`) doubles throughput at
  the same pool size (470 -> 940 req/s) and server CPU rises to ~90%.
- Quadrupling the pool with flushes on gives +70% (800 req/s): more commits
  share each WAL flush (group commit).
- First probe right after the bulk load ran at 7 req/s: autovacuum of the
  1M new rows plus checkpoint WAL starved the spine commits. `seed.ts --phase
  prepare` (VACUUM + CHECKPOINT) fixes it for the test; in production any
  large import or vacuum will compete with audit commits the same way.

Next limits once commits are cheaper:

- **Node CPU (single process).** At ~940 req/s server CPU is 88-97% of one
  core. CPU profile at ~780 req/s (pool 32, sync off): no single hotspot. Of
  busy time, ~12% is undici (the `fetch` client for the loopback
  introspection call) plus ~5% TCP connect/write, ~12% the pg driver, ~5%
  re-parsing grant and manifest JSON (`server/auth.ts`
  `parseAndValidateConnectorManifestRow`, `requirePersistedGrantState`),
  ~4% GC.
- **Connection churn.** The server sets `Connection: close` on every response
  and `keepAliveTimeout: 1` (`server/transport.ts:301-326`, there to avoid
  stale sockets across test restarts). Every read therefore opens two TCP
  connections: client -> RS and RS -> AS introspection. At ~1,500 req/s
  offered (pool 32, sync off, 16 concurrent) ~26k sockets sat in TIME_WAIT,
  the 16k-port ephemeral range ran out, and 55.9% of requests failed:
  client-side connect errors and RS 401s with `context.authentication_failed`
  because the introspection fetch failed. Those 401s carry no trace id, so
  no spine row is written: 233 answered requests in that stage were not
  audited. A real reminder service over TLS would also pay a full TLS
  handshake per request.

## Configuration changed for the test

Only env vars the server reads (`start-server.sh`): `PDPP_STORAGE_BACKEND`,
`PDPP_DATABASE_URL`, `AS_PORT`, `RS_PORT`, `PDPP_DB_PATH`,
`PDPP_SEMANTIC_EMBEDDING_BACKEND=disabled`, `PDPP_EMBEDDING_DOWNLOAD_ALLOWED=0`,
`PDPP_SKIP_AUTO_SCHEDULE_ENROLLMENT=1`, `PDPP_RECONCILE_POLYFILL_MANIFESTS=0`,
`PDPP_RUNTIME_QUIET=1`; owner-password vars unset. `serve.ts` passes
`bindHost: "127.0.0.1"` and `quiet` to `startServer()`. Postgres:
`shared_buffers`, `max_connections`, `track_io_timing` at container start;
`synchronous_commit` per experiment. The pool size is not an env var; the
pool-32 runs used the experiment-only preload.

## Recommended tuning, ranked by expected gain

1. **Cut the audit commit cost per read (expected ~2x; measured ceiling 470
   -> 940 req/s when flush waits are removed).** Write `query.received` and
   `disclosure.served` / `query.rejected` in one transaction (one commit
   instead of two), or as one multi-row INSERT when the response is decided;
   drop `RETURNING *` where the row is not used; review the 15 indexes and 2
   triggers on `spine_events` for this hot path (most serve run/trace
   queries). If the audit policy allows a bounded loss window, use
   `SET LOCAL synchronous_commit = off` for these inserts only, instead of
   database-wide. Files: `lib/postgres-spine.ts` (`postgresEmitSpineEvent`,
   line 1155), `server/routes/rs-read.ts` (record detail, lines 1958 and
   2022), `server/request-helpers.ts:166` (`emitQueryReceived`), spine DDL in
   `server/postgres-storage.ts:2928`.
2. **Make the interactive pool size configurable and raise it (expected
   +70%: 470 -> 800 req/s at pool 32 with durable commits).**
   `server/postgres-storage.ts:119` (`POSTGRES_INTERACTIVE_POOL_MAX = 8`,
   used at lines 1418 and 1477). Mostly buys group commit, so it stacks only
   partly with item 1; keep `max_connections` headroom.
3. **Stop the per-request loopback HTTP introspection and forced
   `Connection: close` (expected: removes the ~1,500 req/s connection-churn
   wall, ~10-15% server CPU, and the unaudited-401 failure mode).** When AS
   and RS share a process, call `introspect()` from `server/auth.ts`
   directly instead of `createRemoteIntrospector` (`server/index.ts:6802`,
   `server/introspection-http.ts:259`); this keeps the per-request
   revocation check. Allow keep-alive outside tests
   (`server/transport.ts:307` and `321-326`). Write an audit row when
   introspection itself fails (`requireTokenWithIntrospection`,
   `server/index.ts:1927`).

After these, the single Node process (~950 req/s at ~95% CPU here) is the
next limit; the pilot volume would then need either a run longer than
~1.3 h or more than one RS process.
