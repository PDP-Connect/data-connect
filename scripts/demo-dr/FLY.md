# DR demo on Fly.io

Two apps: `pdpp-demo-rd` (PDPP server) and `proactivos-demo-rd` (portal).

`pdpp-demo-rd`: one always-on `shared-cpu-1x` / 1 GB machine in `iad`, SQLite on a 1 GB volume at
`/var/lib/pdpp`. No Postgres. Config: [`fly.toml`](./fly.toml).

```
internet ─HTTPS─▶ console :3000 ─▶ AS 127.0.0.1:7662 / RS 127.0.0.1:7663
                                          │
                               volume pdpp_data → /var/lib/pdpp
                               (pdpp.sqlite, credential key, model cache)
```

Run every command from the repo root. The deploy builds the working tree
(uncommitted changes included), not a branch.

## Create

```sh
APP=pdpp-demo-rd
fly apps create "$APP" --org <org>
fly volumes create pdpp_data --app "$APP" --region iad --size 1 --yes
fly secrets set PDPP_OWNER_PASSWORD='<owner-password>' --app "$APP" --stage
```

## Deploy

```sh
fly deploy --config scripts/demo-dr/fly.toml --ha=false
```

- Build context is the cwd (repo root). `[build] dockerfile` resolves relative to
  `fly.toml`'s directory, hence `../../Dockerfile`.
- `--ha=false`: one machine, one volume.
- Fly's remote builder produces `linux/amd64`. A local Apple Silicon build
  (`docker buildx build --target core .`) is `arm64` and only for local testing;
  don't push it to Fly.
- `PDPP_TRUSTED_HOSTS` must name the public host, or the console returns
  `403 Host not allowed`. The health check is TCP for the same reason.

## Seed and verify

```sh
ORIGIN=https://$APP.fly.dev
curl -fsS "$ORIGIN/.well-known/oauth-authorization-server" | jq .issuer

ORIGIN=$ORIGIN OWNER_PASSWORD='<owner-password>' \
  node --import tsx scripts/demo-dr/seed-remote.ts
```

Verify with the portal e2e once the portal is deployed (below).

Re-running the seed is safe: records upsert by key.

## Operate

```sh
fly logs --app "$APP"
fly ssh console --app "$APP" -C "ls -la /var/lib/pdpp"
fly apps restart "$APP"          # data and grants survive (volume)
```

## Servicios Proactivos portal (second app)

Stateless; its OAuth client registers itself with the PDPP app on first use.

```sh
fly apps create proactivos-demo-rd -o <org>
(cd scripts/demo-dr/proactivos-portal && fly deploy --ha=false)   # one machine: sessions are in memory
LANG=es RESET=1 PORTAL_URL=https://proactivos-demo-rd.fly.dev OWNER_PASSWORD=… node scripts/demo-dr/proactivos-e2e.mjs
# If Playwright's Chromium is missing, add:
#   CHROMIUM_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
```

## Reset

Quick reset, from the browser: **Reiniciar demostración** at the bottom of
Mis autorizaciones revokes every authorization and hides them. Records and
the portal's client stay; no restart.

Full reset, from a terminal: removes every grant and record, re-seeds, and restarts the portal so it re-registers its client. Use it if the data itself needs restoring.

```sh
OWNER_PASSWORD=… scripts/demo-dr/reset-live.sh
```

## Recording

```sh
LANG=es PORTAL_URL=https://proactivos-demo-rd.fly.dev OWNER_PASSWORD=… VIDEO_DIR=./video node scripts/demo-dr/record-demo.mjs
```

Each run creates and revokes a grant, so reset afterwards.

## Tear down after the demo

```sh
fly apps destroy "$APP" --yes    # also deletes the machine and volume
fly apps destroy proactivos-demo-rd --yes
fly volumes list --app "$APP"    # expect: app not found
```
