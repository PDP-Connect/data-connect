# Vacuna al día walkthrough on Fly.io

A demo the DR team can walk through with test accounts
([TEST-CREDENTIALS.md](../portal/TEST-CREDENTIALS.md)): a parent signs in
with the Cuenta Única stub, approves the "Vacuna al día" reminder service for
a child, then sees and withdraws it in "Mis autorizaciones"; the reminder
service dashboard shows what the service sees, with paid reads on Moksha.

Two Fly apps, one machine each:

```
                         ┌──────────── vacuna-al-dia-demo (fly.toml) ─────────────┐
internet ─HTTPS─▶ :8080 │ portal/server.ts                                        │
                         │  /recordatorio/*        reminder web app (OAuth client) │
                         │  /pilot/*, GET /oauth/authorize, GET /consent,          │
                         │  /.well-known/*  ──▶ AS 127.0.0.1:7662 / RS :7663       │
                         │  anything else  404                                     │
                         │ volume vacuna_state → /data (reminder SQLite, keys)     │
                         └──────────────┬──────────────────────────────────────────┘
                                        │ DATABASE_URL (private network)
                         ┌──────────────▼───────── vacuna-al-dia-db (fly.db.toml) ┐
                         │ pgvector/pgvector:pg16, volume pg_data, no public port  │
                         └─────────────────────────────────────────────────────────┘
reminder service ─HTTPS─▶ https://dp-rpc.moksha.vana.org  /v1/escrow/pay  (chain 14800)
```

The AS runs without an owner password (`PDPP_ALLOW_UNAUTHENTICATED_OWNER=1`):
the walkthrough seed and the reminder service use owner/token endpoints on
loopback, and the public listener forwards only the paths a browser needs
(`portal/public-paths.ts`, tested in `portal/portal.test.ts`). Token, PAR,
registration, ingest, owner and lifecycle endpoints are not reachable from the
internet.

On every boot the server seeds the fixed walkthrough dataset (idempotent) and
registers the reminder service as a `private_key_jwt` client if it has not
yet.

## What a human must decide or provide

| Item | Default in the files | Notes |
|---|---|---|
| Fly organization | — | `--org <org>` on `fly apps create` |
| App names | `vacuna-al-dia-demo`, `vacuna-al-dia-db` | Change `app` in both toml files, `PUBLIC_ORIGIN` in fly.toml, and the host in `DATABASE_URL` |
| Region | `iad` (closest to Santo Domingo) | `primary_region` in both files |
| `POSTGRES_PASSWORD` (db app secret) | — | Random, e.g. `openssl rand -hex 24` |
| `DATABASE_URL` (app secret) | — | `postgres://pdpp:<POSTGRES_PASSWORD>@vacuna-al-dia-db.internal:5432/pdpp` |
| `PDPP_AUDIT_TOKEN_HMAC_KEY` (app secret) | — | At least 32 characters, e.g. `openssl rand -hex 32` |
| `VACUNA_BUILDER_PRIVATE_KEY` (app secret) | — | Moksha key of the builder (payer). Funded escrow deposit needed; testnet only |
| `VACUNA_REGISTER_SERVER_PRIVATE_KEY` (app secret) | — | The register's trusted-server key that signs `RecordDataAccess` |
| Moksha settings | gateway URL and chain id set | Escrow and DataRegistry contract addresses, data owner address, data point scope: from the Moksha registration (below) |
| Demo password | `VacunaAlDia2026` (`portal/walkthrough-data.ts`) | Shared, fictitious. Override with `PDPP_PILOT_DR_VACUNA_DEMO_PASSWORD` and regenerate TEST-CREDENTIALS.md |

Never commit keys. They go only into `fly secrets set`.

## Environment

Set in `fly.toml` (`[env]`) unless marked secret.

| Variable | Value | Purpose |
|---|---|---|
| `PUBLIC_ORIGIN` | `https://vacuna-al-dia-demo.fly.dev` | Issuer, client redirect URI, authorize URL |
| `PORT` | `8080` | Public listener |
| `VACUNA_STATE_DIR` | `/data` | Reminder SQLite, client key, read-receipt key |
| `DATABASE_URL` | secret | Postgres for the AS/RS and the civil-registry stub |
| `PDPP_PILOT_DR_VACUNA` | `1` | Pilot routes (parent consent, Mis autorizaciones, lifecycle) |
| `PDPP_CONFIDENTIAL_CLIENTS` | `1` | `private_key_jwt` for the reminder service |
| `PDPP_READ_RECEIPTS` | `1` | Signed read receipts; their `read_id` is the paid record id |
| `PDPP_RS_INPROCESS_INTROSPECTION` | `1` | RS introspects in process |
| `PDPP_HTTP_KEEP_ALIVE` | `1` | Keep-alive between the reminder service and the RS |
| `PDPP_AUDIT_TOKEN_HMAC_KEY` | secret | Audit rows hold HMACs of tokens, not tokens |
| `PDPP_ALLOW_UNAUTHENTICATED_OWNER` | `1` | See above; safe only behind the path allowlist |
| `PDPP_PILOT_DR_VACUNA_START_URL` | `/recordatorio` | Landing page's start button |
| `VACUNA_PAYER` | `http` (deploy), `mock` (local default) | Gateway payer or local mock |
| `VACUNA_GATEWAY_URL` | `https://dp-rpc.moksha.vana.org` | Existing Vana data gateway |
| `VACUNA_CHAIN_ID` | `14800` | Moksha |
| `VACUNA_ALLOW_REMOTE_GATEWAY` | `1` | The payer refuses a non-loopback gateway without it |
| `VACUNA_ESCROW_CONTRACT`, `VACUNA_DATA_REGISTRY_CONTRACT`, `VACUNA_DATA_OWNER_ADDRESS` | from the Moksha registration | EIP-712 domains and data point id |
| `VACUNA_DATA_POINT_SCOPE`, `VACUNA_DATA_POINT_VERSION` | `dr.vacuna.child_immunizations`, `1` | Data point registered for the register |
| `VACUNA_PAYMENT_AMOUNT_WEI`, `VACUNA_PAYMENT_ASSET` | `10000000000000000` (0.01 VANA), native | Per read |
| `VACUNA_PAYER_ENV_FILE` | `/data/moksha.env` | Optional KEY=VALUE file with the non-secret Moksha settings; env wins; private keys are refused |
| `VACUNA_SHOW_PAYMENTS` | unset | `1` shows per-read payments, amounts and settlement on the dashboard. Unset (the shared demo): hidden; reads are still paid |
| `VACUNA_EXPLORER_TX_URL` | `https://moksha.vanascan.io/tx/` | Dashboard links for settled payments (with `VACUNA_SHOW_PAYMENTS=1`) |
| `VACUNA_MOKSHA_FROM_BLOCK` | unset | `VACUNA_PAYER=moksha`: first block the server's settlement poll scans (once; the cursor is then kept in `VACUNA_MOKSHA_STATE_DIR`). Unset: 100 blocks below the latest on a fresh state, 20,000 if unsettled paid reads already exist |
| `VACUNA_BUILDER_PRIVATE_KEY`, `VACUNA_REGISTER_SERVER_PRIVATE_KEY` | secrets | Payment and access-record signers |

### Moksha registration (hook, not done here)

The builder, the register's server, per-child data points and the escrow
deposit are set up by the scripts under `scripts/demo-dr-vacuna/moksha/`
(separate work). Feed its non-secret output to the app either as `fly secrets
set`/`[env]` values or as a file on the volume:

```sh
fly ssh sftp shell --app vacuna-al-dia-demo   # put moksha.env /data/moksha.env
fly apps restart vacuna-al-dia-demo
```

The deploy uses `VACUNA_PAYER = "moksha"`: the Moksha payer
(`../moksha/lib/payer.ts`) registers each child's server, data point and
grant on the gateway before its first paid read, then pays 0.011 VANA for the
first read (grant fee included) and 0.01 VANA after. It needs the three key
secrets below and a funded escrow deposit for the builder
(`node moksha/cli.ts deposit`, see `../moksha/LIVE-RUNBOOK.md`). Caps in
`fly.toml`: 200 children, 5,000 paid reads.

To bring the demo up without payments, set `VACUNA_PAYER = "mock"` in
`fly.toml` and deploy.

## Create (once)

From the repo root. Deploy from a clean checkout of the branch: `fly deploy`
builds the working tree, and `ignorefile` keeps `node_modules` out of the
upload.

```sh
ORG=<org>
fly apps create vacuna-al-dia-db --org "$ORG"
fly apps create vacuna-al-dia-demo --org "$ORG"
fly volumes create pg_data --app vacuna-al-dia-db --region iad --size 1 --yes
fly volumes create vacuna_state --app vacuna-al-dia-demo --region iad --size 1 --yes

PG_PASSWORD=$(openssl rand -hex 24)
fly secrets set --app vacuna-al-dia-db POSTGRES_PASSWORD="$PG_PASSWORD" --stage
fly secrets set --app vacuna-al-dia-demo --stage \
  DATABASE_URL="postgres://pdpp:$PG_PASSWORD@vacuna-al-dia-db.internal:5432/pdpp" \
  PDPP_AUDIT_TOKEN_HMAC_KEY="$(openssl rand -hex 32)" \
  VACUNA_BUILDER_PRIVATE_KEY="$(cat ~/.config/dr-vacuna/builder.key)" \
  VACUNA_REGISTER_SERVER_PRIVATE_KEY="$(cat ~/.config/dr-vacuna/register.key)" \
  VACUNA_CHILD_KEY_SEED="$(cat ~/.config/dr-vacuna/child-seed.key)"
```

Contract addresses default to the live Moksha deployment
(`../moksha/lib/config.ts`).

Alternative to the db app: Fly Managed Postgres (`fly mpg create`), then set
`DATABASE_URL` to its connection string. pgvector is optional for this demo.

## Deploy

```sh
fly deploy --config scripts/demo-dr-vacuna/deploy/fly.db.toml --ha=false
fly deploy --config scripts/demo-dr-vacuna/deploy/fly.toml --ha=false
```

- `--ha=false`: one machine per app. Cuenta Única sessions and OAuth state
  are in memory, so the app must stay on one machine.
- Fly's builder produces `linux/amd64`. A local Apple Silicon build is arm64
  and only for local testing.

## Verify

```sh
ORIGIN=https://vacuna-al-dia-demo.fly.dev
curl -fsS "$ORIGIN/healthz"                      # ok
curl -s -o /dev/null -w '%{http_code}\n' "$ORIGIN/oauth/token"   # 404: not exposed
fly logs --app vacuna-al-dia-demo                 # "walkthrough seed: 10 adults, 15 children"

# Full browser walkthrough with screenshots (system Chrome works):
BASE_URL=$ORIGIN DEMO_LANG=es VIEWPORT=desktop \
  CHROMIUM_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  node scripts/demo-dr-vacuna/portal/walkthrough-e2e.ts
scripts/demo-dr-vacuna/deploy/reset.sh fly        # the run leaves grants behind
```

With `VACUNA_SHOW_PAYMENTS=1` and the gateway payer, the dashboard's "Pagos por lectura" table links each
payment to the Moksha explorer once the gateway response carries a
transaction hash; until then it shows "aceptado, sin transacción todavía".

## Reset

```sh
scripts/demo-dr-vacuna/deploy/reset.sh fly        # APP=… to override the app name
```

It writes `/data/reset-requested` and restarts the app; the next boot drops
the database schema, clears `/data` (keeping `*.env` files such as
`moksha.env`, the Moksha chain state in `/data/moksha` and the volume's
`lost+found`), re-seeds and re-registers the reminder client. Takes about a
minute. Payments already settled on Moksha are not undone.

## Run locally (same image)

```sh
docker compose -f scripts/demo-dr-vacuna/deploy/docker-compose.yml up --build -d
open http://localhost:8080                        # mock payer
scripts/demo-dr-vacuna/deploy/reset.sh compose
docker compose -f scripts/demo-dr-vacuna/deploy/docker-compose.yml down -v
```

`HOST_PORT=8098 PUBLIC_ORIGIN=http://localhost:8098` publishes another port.
Without Docker: `DATABASE_URL=postgres://… node --import tsx
scripts/demo-dr-vacuna/portal/server.ts` (Node 24, after `npm install
--ignore-scripts` and the vendored package builds in ../baseline/README.md).

## Tear down

```sh
fly apps destroy vacuna-al-dia-demo --yes
fly apps destroy vacuna-al-dia-db --yes
```
