# DR pilot integrated run: status

Branch `demo/dr-vacuna-integration`, 2026-10-15. The pipeline in
[README.md](./README.md) is built and proven end to end on a 3-child smoke
run. **The load test itself (1% and 100%) has not been run**, by decision:
only the smoke was in scope. Every PRD criterion below is therefore "not yet
run" at pilot volume.

## PRD criteria

| Criterion | Target | Status at pilot volume | Smoke (3 children, two clean runs) |
|---|---|---|---|
| Paid reads equal across PDPP audit log, register read receipts, reminder service received, payments accepted (mock payer) | 3,920,800 in all four | not yet run | pass: 12 = 12 = 12 = 12 (audit `disclosure.served`, receipts log, reminder store, payer ledger) |
| 0 records served after revocation | 0 | not yet run | pass: 0 in window (reconcile), 0 reads started after the revoke response served (probe), 0 served for the revoked-token read |
| Revocation effective within 60 s | <= 60 s | not yet run | pass: 12.9 ms (1 probe; 980-child run: max 12.7 ms over 20) |
| 100% of requests audited, denials included | 4,260,800 RS requests + 60,000 consent refusals | not yet run | pass: 16 `query.received` for 16 client requests (12 reads + 4 injected), 0 without outcome; 1 of 1 consent refusal audited |
| Denials: 200,000 after revocation, 100,000 out-of-grant fields, 60,000 consent refusals, 40,000 expired/malformed tokens | as listed | not yet run | pass: one of each, refused as expected: `grant_revoked` 403, `field_not_granted` 403, `token_expired` 401, `token_unknown` 401; consent refusal `no_relationship` |
| Peak throughput with errors < 0.1% and p95 < 500 ms | report | not yet run (ramp phase built, not executed) | not run |
| Same seed, same counts | identical | not yet run | pass on the smoke: two clean runs (`--fresh`, seed 20261014) gave identical grants, refusals, paid reads, receipts, payments, denials by reason, revocations by disposition, reminder statuses and counters, and criteria results; only the total spine row count differed (244 vs 226), from the probe's timing-dependent number of reads after the window |

Smoke command: `node run.ts --children 3 --revoke-every 2 --probes 1 --label smoke --fresh`.
Per run: 3 grants through the real parent path and code exchange, 1 registry
refusal, 4 simulated weeks of reminder reads (12 paid reads, receipts
verified, mock payer ledger), children 1 and 3 revoked by their parent (keep,
delete), the reminder service's daily job ending one as `ended_keep` and
deleting the other's held data, one denial of each kind, the four-way
reconciliation, and one revocation probe.

An earlier development run at 980 children (scale 0.001, since deleted)
also passed every check: 3,920 paid reads in all four sources, 340 injected
denials, 60 consent refusals audited, 20 revocations (10 keep, 10 delete),
revocation effective in 12.7 ms max over 20 probes. Its phase times are the
basis of the estimates below.

## Fixes made while integrating

| Fix | Where | Test |
|---|---|---|
| A colliding 6-hex `pending_consents.user_code` (duplicate-key 500 on PAR / authorize, ~1% at ~130k rows) is redrawn, up to 8 attempts; other conflicts still fail | `reference-implementation/server/auth.ts` | `test/pending-consent-user-code-collision.test.ts` (SQLite and Postgres drivers) |
| `GET /v1/streams/:s/records/:id?fields=<declared field outside the grant>` was served (200, field silently dropped, receipt issued); it is now 403 `field_not_granted` and audited as `query.rejected`, like the list endpoint | `reference-implementation/operations/rs-records-detail/index.ts` | `test/query-contract.test.ts` |
| A lapsed refresh-issued access token introspected as `grant_expired` (RS 403) while its grant was active; now `token_expired` (RS 401) unless the grant itself expired | `reference-implementation/server/auth.ts` (`introspect`) | `test/hosted-mcp-oauth.test.ts` |
| A 2-3 child registry produced no refusal attempt | `consent/seed-registry.ts` | smoke |

Without the field fix the PRD's 100,000 out-of-grant reads would have been
paid-looking served reads with receipts, breaking the four-way equality.

Integration notes, from the smoke and the 980-child run:

- Before the third fix the AS introspected every lapsed 10-minute access
  token as `inactive_reason: grant_expired` and the RS answered 403
  `grant_expired`, although the grant was active. The reminder service's
  daily lifecycle check trusts that reason, so in any run longer than 10
  minutes it would have marked every grant ended after week 1 and stopped
  reading (the 980-child run finished inside 10 minutes and did not show
  it). Expired tokens now get 401 `token_expired`.
- Grants come from `GET /oauth/authorize` (PKCE, `authorization_details`),
  which stores the request as the same PAR-backed pending consent that
  `POST /oauth/par` creates. `/oauth/par` itself cannot carry `redirect_uri` /
  PKCE for a later code exchange in the reference AS, so it is not used for
  the code flow.
- Access tokens live 10 minutes. The reminder service rotates refresh tokens
  before a read when needed; its daily lifecycle check introspects the access
  token it holds and does not refresh first, so at volume (runs longer than
  10 minutes) most daily checks will report `inactive_token:token_expired`
  and count as failed attempts (`status.failed_grant`, retried); reads are
  unaffected because a read refreshes first. The PR #401 lifecycle endpoint
  (not in the reference AS yet) removes this. The revocation step rotates the sampled children's
  tokens just before revoking so the following lifecycle check sees
  `grant_revoked`.
- The expired-token denials need each child's first access token to have
  expired, so `denials` waits up to 10 minutes after the last grant; in the
  smoke that wait is almost the whole run time.

## Running 1% and 100% later

```sh
cd scripts/demo-dr-vacuna/run
node run.ts --scale 0.01 --label s1 --fresh        # then: node run.ts --label s1 --phases ramp
node run.ts --scale 1    --label full --fresh      # then: node run.ts --label full --phases ramp
# determinism: a second clean run under another label, then compare report.json counts
node run.ts --scale 0.01 --label s1b --fresh
```

Expected durations (estimates, not measurements of these runs):

| Phase | Basis | 1% (9,802 children) | 100% (980,200) |
|---|---|---|---|
| records | 980-child run 5.7 s; baseline bulk load of 1M records | < 1 min | ~15-20 min |
| registry | consent track: ~50 s for the full registry | seconds | ~1 min |
| grants | 980-child run ~127 grants/s incl. refusals; consent track 128.6 grants/s at 8 concurrent without the code exchange | ~1.5 min | ~2.2-2.5 h |
| weeks | 980-child run 7.5 s for 3,920 reads + ~27k daily introspections; audit-fix track 750-910 reads/s (pool 32); after 10 minutes every read also needs a refresh | ~2-5 min | 4-8 h (reads 1.2-1.5 h at the measured rate, plus 27.4M daily introspections and ~2.9M refreshes, not measured at volume) |
| revoke + lifecycle | 980-child run < 1 s for 20 revocations; consent track 84 revocations/s | seconds | ~4-5 min for 19,604 revocations, plus one daily check over all children |
| denials | 980-child run ~990 req/s | ~5 s (+ up to 10 min token-expiry wait) | ~6 min |
| reconcile + probes + report | | < 1 min | ~5 min (receipts log ~4M lines) |
| ramp | 6 stages x 35 s | ~4 min | ~4 min |
| total | | ~15-20 min | ~7-11 h |

Disk: the 980-child run's database was 0.06 GiB (~19 spine rows per child).
Extrapolated linearly, 1% needs ~0.6 GiB and 100% roughly 40-60 GiB of
Postgres (spine ~18M rows plus grants, tokens, refresh tokens, pending
consents, authorization codes), plus ~1.5 GiB of receipts log and ~4 GiB of
reminder-service SQLite. This workstation had ~17 GiB free, so the 100% run
does not fit here as it stands; 1% does.

## Machine

Apple M4 (10 cores), 16 GB RAM, macOS 26.6.2; OrbStack Docker (10 vCPU,
7.8 GiB VM); Postgres `pgvector/pgvector:pg16` with `shared_buffers=1GB`,
`max_connections=200`, `max_wal_size=2GB`, `checkpoint_timeout=15min`;
Node 24.21.0. Shared workstation (another container and other agents' work
running).
