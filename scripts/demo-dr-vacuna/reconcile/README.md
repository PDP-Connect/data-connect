# DR pilot reconciliation

Count job for the pilot success criteria: paid reads must be equal across the
PDPP audit spine, the register stub's signed read receipts, the reminder
service's received count and the gateway's accepted payments; every request
must be audited with an outcome; no record may be served after revocation.

```sh
node reconcile.ts --run-id <id> --from <iso> --to <iso> \
  --register-receipts <n|file|url> [--register-receipts-field <key>] \
  --reminder-received <n|file|url> [--reminder-received-field <key>] \
  --gateway-accepted  <n|file|url> [--gateway-accepted-field <key>] \
  [--client-id <reminder client id>] [--database-url <postgres url>] [--out out]

node export-audit.ts --children DR-0000001,DR-0000050 [--from <iso> --to <iso>] \
  [--out out/audit-sample.csv]

node --test reconcile.test.ts
```

`reconcile.ts` reads all spine counts in one read-only snapshot and writes
`reconcile-<run>.json` and `reconcile-<run>.md`; it exits 1 on any failed
check. External counts accept an integer, a JSON file or URL (number, array
length, or an object field, default `count`), a `.jsonl`/`.ndjson` file (one
line per item) or a `.csv` file (rows after the header).

Denial reasons come from `query.rejected`: `data_json.denial_reason` for
auth-gate rejections (`token_unknown`, `bearer_missing`, `bearer_malformed`,
`grant_revoked`, `grant_expired`, `context.authentication_failed`, ...) and
`data_json.error.code` otherwise (`not_found` is a read outside the grant).
Consent refusals never reach the resource server; they are reported from
`consent.denied` events for information only.

Outputs go to `out/` (git-ignored). Database default:
`postgres://pdpp:pdpp@localhost:55432/pdpp` (the baseline harness container).
