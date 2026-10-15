# Audit and throughput fixes: before/after

Measured 2026-10-14/15 on branch `demo/dr-vacuna-audit`, same machine and
seeded database as [RESULTS.md](./RESULTS.md), runs interleaved within one
hour. Raw data: `results/*before-stock*.json`, `results/*after-pool*.json`.

## What changed (reference-implementation)

| Change | Flag | Files |
|---|---|---|
| Every auth-gate rejection (unknown/missing/non-Bearer token, failed introspection, revoked, expired, context errors) writes `query.received` + `query.rejected` with `data.denial_reason` | always on | `server/index.ts` (`auditAuthGateRejection`), `server/auth-middleware.ts` |
| `spine_events.token_id` and `token` object ids store `tkh_` + HMAC-SHA256 of the bearer, never the bearer | always on; key `PDPP_AUDIT_TOKEN_HMAC_KEY` (else random per process) | `server/audit-token-ref.ts`, `lib/spine.ts`, `lib/postgres-spine.ts` |
| Spine inserts drop `RETURNING *`; `emitSpineEvents()` writes a pair in one multi-row INSERT (auth-gate pairs always) | always on | `lib/postgres-spine.ts`, `lib/spine.ts` |
| Record-detail reads hold `query.received` and write it with `disclosure.served` / `query.rejected` in one statement | `PDPP_AUDIT_COALESCE_READ_EVENTS=1` | `server/routes/rs-read.ts`, `server/index.ts` |
| RS calls the AS introspection in process (still a full `tokens`+`grants` lookup per request, no cache) | `PDPP_RS_INPROCESS_INTROSPECTION=1` | `server/introspection-http.ts`, `server/index.ts` |
| HTTP keep-alive instead of forced `Connection: close` | `PDPP_HTTP_KEEP_ALIVE=1` | `server/transport.ts` |
| Interactive Postgres pool size | `PDPP_PG_INTERACTIVE_POOL_MAX` (default 8) | `server/postgres-storage.ts` |

`Connection: close` was there so tests that stop and restart a server on the
same port never reuse a stale pooled socket; it stays the default.

## Load mix

As in RESULTS.md plus `--unknown-ratio 0.0093` (never-issued bearers, expect
401: the pilot's 40,000 expired/malformed tokens): per request 90.74% own
record (200), 4.17% revoked grant (403), 4.17% other child's record (404),
0.93% unknown bearer (401). Stages 8..128 (one run to 256), 30 s each.
"after" runs set all four flags; "before" is commit 7e3318a0 unchanged.

## Results

Host load average was 4-10 during these runs (other worktrees' agents and
servers running), so absolute numbers are below RESULTS.md's 437-492 req/s
stock baseline; compare runs within this table.

| config | sustained req/s | of which 200 | at conc | p50 / p95 / p99 ms | errors | max passing conc | first failing conc | hours for 4,320,800 |
|---|---:|---:|---:|---|---:|---:|---|---:|
| before-stock | 251.8 | 229.1 | 32 | 85.1 / 271.1 / 980.4 | 0.000% | 32 | 64 (p95 1029.8 ms) | 4.77 |
| after-pool8 | 576 | 522.2 | 8 | 11.2 / 24.7 / 52.1 | 0.000% | 128 | none | 2.08 |
| after-pool32 | 751.8 | 679 | 64 | 65 / 154.8 / 252.7 | 0.000% | 128 | none | 1.60 |
| before-stock-2 | 185.9 | 168.2 | 16 | 73.5 / 122.3 / 229.6 | 0.000% | 32 | 64 (p95 1343.1 ms) | 6.46 |
| before-stock-3 | 351.6 | 318.6 | 16 | 42.7 / 74.6 / 112.3 | 0.000% | 64 | 128 (p95 1211.5 ms) | 3.41 |
| after-pool8-2 | 508.3 | 460.5 | 16 | 26.6 / 47.9 / 85.4 | 0.000% | 128 | none | 2.36 |
| after-pool32-2 | 910.3 | 827.7 | 64 | 59.1 / 115.8 / 216.8 | 0.000% | 128 | 256 (p95 630.5 ms) | 1.32 |

Audit coverage (all stages, warm-up included; `query.received` rows vs.
requests answered, and `query.rejected` rows vs. denied requests):

| run | audited / answered | rejected rows / denied | spine rows per request |
|---|---|---|---|
| before-stock | 30,052 / 30,334 (99.07%) | 2,543 / 2,825 | 1.98 |
| before-stock-2 | 22,057 / 22,260 (99.09%) | 1,853 / 2,056 | 1.98 |
| before-stock-3 | 46,649 / 47,095 (99.05%) | 3,966 / 4,412 | 1.98 |
| after-pool8 | 86,748 / 86,748 (100%) | 8,169 / 8,169 | 2.000 |
| after-pool8-2 | 79,244 / 79,244 (100%) | 7,453 / 7,453 | 2.000 |
| after-pool32 | 112,693 / 112,693 (100%) | 10,426 / 10,426 | 2.000 |
| after-pool32-2 | 161,283 / 161,283 (100%) | 14,916 / 14,916 | 2.000 |

Before, exactly the unknown-bearer requests (0.93%) had no audit row. After,
every request has a received row and exactly one outcome row. Denial reasons
recorded after: `grant_revoked`, `not_found` (outside the grant),
`token_unknown`; `reconcile/reconcile.ts` over the after-pool8 window found 0
requests without an outcome and 0 disclosures after revocation.

Summary:

- Stock code: 186-352 req/s sustained under this load, p95 75-271 ms there.
- All fixes, pool 8: 508-576 req/s, p95 25-48 ms; no stage failed up to 128
  concurrent (p95 <= 435 ms). About 1.6-2.7x the interleaved stock runs.
- All fixes, pool 32: 752-910 req/s, p95 116-155 ms at 64 concurrent; at 910
  req/s the pilot volume (4,320,800) takes 1.32 h.
- Pool 32 is now an env var instead of RESULTS.md's preload hack. No
  connection errors in any after run (up to 256 concurrent): with keep-alive
  and in-process introspection a read opens no new TCP connection, which
  removes the cause of RESULTS.md's 1,500 req/s port-exhaustion wall; this
  machine did not reach that rate with durable commits.
- Server CPU stays ~40% of a core; Postgres reaches ~2.5 cores at pool 32.
  WAL per request is 11-24 KB in all runs here (vs ~4.3 KB in RESULTS.md),
  i.e. full-page writes after frequent checkpoints on the now larger spine
  (`max_wal_size=1GB`); raising `max_wal_size` is the next cheap test.

## Spine indexes

Not dropped. On this database, after all runs (`pg_stat_user_indexes`), the
large full-table indexes with 0 scans during the load test are
`idx_pg_spine_events_trace_recent` (416 MB), `idx_pg_spine_events_grant_recent`
(414 MB), `idx_pg_spine_events_source` (385 MB) and
`idx_pg_spine_events_trace` (338 MB, 4 scans). Each backs a correlation or
timeline query (`lib/postgres-spine.ts` recent-correlation listing ordered by
`occurred_at DESC, event_seq DESC`, source-filtered listings, trace
timelines), so dropping them would slow `/_ref` owner views; they are the
candidates if the pilot accepts that or moves those views to a replica. The
`trace_recent` partial predicate (`trace_id IS NOT NULL`) covers every row
because `trace_id` is NOT NULL.
