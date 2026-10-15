# DR vaccination reminder service (demo)

OAuth client of the PDPP reference server for the "Vacuna al día" pilot. One
continuous grant per child. Each simulated week it reads every active child's
record, flags the next due dose on a simplified DR PAI schedule (log only,
nothing is sent), stores the record, and pays once per served read through a
`GatewayPayer`. It meets the held-data duties of PDPP PR #401: a lifecycle
check per grant at least daily (hourly after a failure, immediately after a
401/403 read or a failed refresh), stop use within 48 h of an erasure
instruction and delete within 30 days of receiving it; a revoked grant with
"keep" stops reads but keeps its held record.

Node 24, no build step (`node cli.ts ...`). State: `.state/` (git-ignored) or
`--state-dir` / `$VACUNA_REMINDER_STATE_DIR`.

## Server flags this uses (reference implementation)

| Env | Effect |
|---|---|
| `PDPP_CONFIDENTIAL_CLIENTS=1` | DCR accepts `private_key_jwt` (with `jwks`) and `client_secret_basic`; `/oauth/token` and `/oauth/par` authenticate them (`server/client-authentication.ts`). |
| `PDPP_READ_RECEIPTS=1` | Single-record client reads return a signed `PDPP-Read-Receipt` header (`server/read-receipts.ts`). `PDPP_READ_RECEIPTS_KEY_FILE` (generated with `.pub` if missing), `PDPP_READ_RECEIPTS_LOG` (JSONL). |

## Commands

```sh
node cli.ts bootstrap --children 40 [--ingest] [--public]   # register client (private_key_jwt), real auth-code grants with refresh tokens
node cli.ts week  --now 2026-10-05T08:00:00Z [--receipt-public-key PEM] [--concurrency 64] [--rate 500]
node cli.ts daily --now 2026-10-06T09:00:00Z                  # lifecycle checks + deletion sweep + pending payments
node cli.ts simulate --start 2026-10-05T08:00:00Z --days 28   # daily jobs, weekly reads on a manual clock
node cli.ts import-baseline --from 2001 --to 980200           # bulk-seeded baseline grants (access token only, no refresh)
node cli.ts counters
```

`--now` pins the simulated clock, `--clock-offset-days` shifts real time.
Business deadlines use the simulated clock; access-token expiry uses real
time because the AS mints it in real time. Each `week`/`daily` run appends a
snapshot to `.state/counters.json`: reads attempted/succeeded/denied by
`<status>_<code>`, refresh outcomes, receipts verified, due doses, payments
sent/accepted/rejected, lifecycle and erasure counters, and store totals
(records received, payments by status, receipts stored).

Connection: `VACUNA_AS_URL`, `VACUNA_RS_URL`, `VACUNA_AS_ISSUER` (assertion
`aud`, default the AS URL).

### Grant status source

- `--status lifecycle`: PR #401 `POST <pdpp_grant_lifecycle_endpoint>`
  (`VACUNA_LIFECYCLE_ENDPOINT`), `grant_id` repeated, client assertion; reads
  `held_data` / `erasure`, sends `report=received|completed`. The reference AS
  does not implement this endpoint yet; tests use a fake.
- `--status introspection` (default without `VACUNA_LIFECYCLE_ENDPOINT`): RFC
  7662 introspection of the child's access token with the RS introspection
  credentials (`VACUNA_INTROSPECTION_CLIENT_ID` / `_SECRET`, a demo
  shortcut). Introspection has no keep-or-delete field, so the parent's choice
  is a **stub**: `.state/dispositions.json` (`{ "<grant_id>": "delete" }`),
  default keep.

### Payer

- `--payer mock` (default): records payments locally (settlement off).
  `--payer-ledger <file.jsonl>` makes it keep its own books: one line per
  accepted read id, deduplicated across restarts (the count job reads it as
  the gateway's accepted count).
- `--payer http`: data-gateway `POST /v1/escrow/pay`, `opType: data_access`,
  EIP-712 `GenericPayment` signed with `VACUNA_BUILDER_PRIVATE_KEY`, plus an
  `accessRecord` whose `RecordDataAccess` signature comes from
  `VACUNA_REGISTER_SERVER_PRIVATE_KEY`. Needs `VACUNA_GATEWAY_URL`,
  `VACUNA_CHAIN_ID`, `VACUNA_ESCROW_CONTRACT`, `VACUNA_DATA_REGISTRY_CONTRACT`,
  `VACUNA_DATA_OWNER_ADDRESS`; optional `VACUNA_DATA_POINT_SCOPE`,
  `VACUNA_DATA_POINT_VERSION`, `VACUNA_PAYMENT_AMOUNT_WEI` (default 0.01 VANA),
  `VACUNA_PAYMENT_ASSET` (default native). Loopback only by default: a
  non-loopback gateway must be https and its origin listed in
  `VACUNA_GATEWAY_ALLOWLIST` (comma-separated, e.g.
  `https://dp-rpc.moksha.vana.org`). Use throwaway keys only. Format details
  in `lib/payer.ts`.
- `--payer moksha`: the same endpoint per child on Vana Moksha, with each
  child's server, data point and grant registered on the gateway before its
  first paid read. Config, keys and caps: `../moksha/LIVE-RUNBOOK.md`.

## Refresh rotation

`refresh_state` is committed as `in_flight` before the request. Success
commits the successor refresh token and access token before the access token
is used. `invalid_grant` marks the family dead; a transport error, timeout,
5xx or unparsable answer marks it `lost`, and so does a crash mid-refresh
(on restart). `lost` and `dead` are never retried: replaying a superseded
refresh token revokes the whole family. Those children need re-authorization.

## Tests

```sh
node --test test/reminder-service.test.ts
```

Fakes (`test/fakes.ts`): a PDPP AS/RS with family revocation on replay,
receipts and the lifecycle operation, and an escrow/pay endpoint that
recovers both EIP-712 signers.
