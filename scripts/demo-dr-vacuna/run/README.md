# DR pilot: one orchestrated run

Runs the whole pilot path against the reference server at a scale factor of
the PRD volumes (980,200 children, 3,920,800 paid reads over 4 simulated
weeks, 400,000 denials), then reconciles the counts. Status and results:
[RESULTS.md](./RESULTS.md).

Prerequisites as in [../baseline/README.md](../baseline/README.md) (Node 24,
Docker, dependencies and workspace builds). Everything runs on loopback; no
blockchain or Vana network call is made (mock payer).

## Commands

```sh
cd scripts/demo-dr-vacuna/run

# Smoke: 3 children end to end (children 1 and 3 revoked: keep, delete) (~11 min, most of it waiting for the first
# access tokens to expire so the expired-token denials are real).
node run.ts --children 3 --revoke-every 2 --probes 1 --label smoke --fresh

# 1% (9,802 children)
node run.ts --scale 0.01 --label s1 --fresh
node run.ts --label s1 --phases ramp                       # peak throughput, separate

# 100% (980,200 children)
node run.ts --scale 1 --label full --fresh --grant-concurrency 8 --read-concurrency 64 --pool 32
node run.ts --label full --phases ramp
```

`--fresh` drops and recreates the `pdpp-vacuna-pg` container (port 55432,
`VACUNA_PG_EXTRA_ARGS` default `-c max_wal_size=2GB -c checkpoint_timeout=15min`)
and wipes `.state/<label>/`. Without it a rerun of the same label resumes:
finished phases are skipped, and the grants phase itself resumes where it
stopped. `--phases a,b` reruns named phases only.

The server (AS :7762, RS :7763; `VACUNA_RUN_AS_PORT` / `VACUNA_RUN_RS_PORT`)
is started by `run.ts` as its child with every pilot flag on:
`PDPP_PILOT_DR_VACUNA`, `PDPP_CONFIDENTIAL_CLIENTS`, `PDPP_READ_RECEIPTS`
(+ key and JSONL log in the state dir), `PDPP_RS_INPROCESS_INTROSPECTION`,
`PDPP_HTTP_KEEP_ALIVE`, `PDPP_AUDIT_COALESCE_READ_EVENTS`,
`PDPP_PG_INTERACTIVE_POOL_MAX` (`--pool`, default 32),
`PDPP_AUDIT_TOKEN_HMAC_KEY`, and demo RS introspection credentials. It is
stopped when `run.ts` exits. If something already answers on :7762 the run
refuses to start.

## Phases

| Phase | What | Path |
|---|---|---|
| `records` | owner bootstrap, first 2,000 records by `POST /v1/ingest`, rest by SQL | `baseline/seed.ts` |
| `registry` | civil-registry stub: families, guardianships, refusal set (60,000 x scale) | `consent/seed-registry.ts` |
| `client` | reminder service's confidential client (DCR, `private_key_jwt`) | `reminder-service/cli.ts bootstrap --children 0` |
| `grants` | per child: `/oauth/authorize` (PKCE, `authorization_details` for that child, fields `child_id,birth_date,doses,next_dose_due`) -> parent Cuenta Única login -> `consent/select` (registry check) -> `consent/approve` -> code exchange at `/oauth/token` with `private_key_jwt`; access + refresh token stored in the reminder service's store. Then the refusal set: authorize -> login -> select -> 403 `access_denied`. Resumable; orphan grants (issued, tokens never stored) are revoked by their parent and reissued. The audit window opens here. | `consent/seed-grants.ts` |
| `prepare` | `VACUUM ANALYZE` + `CHECKPOINT` | `baseline/seed.ts --phase prepare` |
| `weeks` | 28 simulated days from 2026-10-05: daily lifecycle checks (introspection), weekly reads of every child, receipt verification, one mock payment per served read (`--payer-ledger`) | `reminder-service/cli.ts simulate` |
| `revoke` | every 50th child (`--revoke-every`), parent sign-in + `POST /pilot/vacuna/autorizaciones/:id/revoke`, keep/delete alternating; the child's tokens are rotated first so later reads are refused for the revocation, not expiry; the parents' recorded choices become the reminder service's disposition stub | `run/revoke.ts` |
| `lifecycle` | reminder service daily job on day 28: learns the revocations, deletes the "delete" ones | `reminder-service/cli.ts daily` |
| `denials` | seeded, shuffled: 200,000 x scale reads with revoked grants' tokens (403 `grant_revoked`), 100,000 x scale reads asking for `fields=updated_at` outside the grant (403 `field_not_granted`), 40,000 x scale bad tokens: half each child's first (expired) access token (401 `token_expired`), half malformed (401) | `run/inject-denials.ts` |
| `reconcile` | closes the window; counts receipts (server JSONL, `served_at` in window), the reminder store's received records, the payer ledger; runs the four-way count and audit checks | `reconcile/reconcile.ts` |
| `probes` | after the window: N grants, back-to-back reads while the parent revokes; time from revoke sent to first refused read; reads started after the revoke response that were served (must be 0) | `run/probe-revocation.ts` |
| `report` | `.state/<label>/report.md` and `report.json`: PRD criteria, counts, phase durations, DB size | `run.ts` |
| `ramp` | (separate) fresh tokens for 3,000 active grants + revoked grants' tokens, then `baseline/loadgen.ts --tokens-file` ramp 8..256 lanes, 30 s stages, stop at errors > 0.1% or p95 > 500 ms | `run/ramp-tokens.ts`, `baseline/loadgen.ts` |

Determinism: the dataset and registry seeds are fixed in
`baseline/lib/dataset.ts` and `consent/lib/families.ts`; `--seed` drives the
revocation-probe choice, the out-of-grant token pool and the order of the
injected denials. The PRD counts depend only on these. Refresh counts depend
on wall-clock time (10-minute access tokens) and are not expected to repeat.

## Outputs (`.state/<label>/`, git-ignored)

`run.json` (plan, phase timings, window), `report.md` / `report.json`,
`reconcile/`, `seed-grants-result.json`, `revoke-result.json`,
`injector-result.json`, `probes-result.json`, `receipts.jsonl` (register
read receipts), `payer-ledger.jsonl`, `reminder/` (reminder store, counters,
client key), `server.log`, one log per phase, `ramp/`.
