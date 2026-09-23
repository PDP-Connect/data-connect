# Deploy a PDPP Core node with Docker

Two paths, by intent:

- **Quickstart** — one `docker run`, SQLite on a named volume, running on a
  laptop in under a minute. Start here.
- **Production** — the same one-service Core Compose stack with Postgres +
  pgvector for a node you intend to keep.

Both run the same `core` image the Railway button and the Fly.io launch path
use: the Authorization Server and Resource Server, listening directly on the
published port. The public `core` image also bundles Patchright/Chromium,
enables semantic search downloads, and persists its model cache under
`/var/lib/pdpp`.

**Architecture note (differs from the pdpp original this was ported from):**
pdpp's `core` image bundled the operator console and the reference AS/RS in
one container via a supervisor process (`deploy/railway/core-supervisor.ts`),
with the console on the public port and AS/RS on loopback. data-connect's
`deploy/docker/Dockerfile` `core` stage does **not** do this today — it is
identical to `reference-browser` (reference AS/RS only; see that Dockerfile's
own stage comments). The console (`apps/console`) is a separate standalone
Next.js app with its own `apps/console/Dockerfile`, not bundled into `core`.
This README's instructions below describe the AS/RS-only `core` image as it
exists in this repo now; anywhere the original pdpp docs assumed a bundled
console, that assumption does not hold here yet. See the root
`docker-compose.yml`'s `web` service for how the console is composed
alongside `reference` today, and `deploy/railway/core-supervisor.ts` /
`deploy/railway/core-first-boot.ts` for the ported (but currently unwired)
supervisor that would restore the combined-image behavior if a future change
wires it into the Dockerfile.

## Building from `main` (or any commit) with a real identity

A candidate image built from a specific commit should carry that commit's
exact git SHA as its runtime identity (`PDPP_REFERENCE_REVISION`, the env var
the acceptance receipt reads). Build with:

```sh
docker build -f deploy/docker/Dockerfile --target core \
  --build-arg PDPP_REFERENCE_REVISION="$(git rev-parse HEAD)" \
  -t pdpp:candidate .
```

An ordinary local `docker build -f deploy/docker/Dockerfile --target core .`
with no `PDPP_REFERENCE_REVISION` is still valid: the runtime revision
defaults to the honest value `unknown` rather than a fabricated SHA. That
build is for local development only and must never be treated as
attributable to a commit.

**Known gap in this repo today, verified by actually building the image:**
`deploy/docker/Dockerfile` sets `PDPP_REFERENCE_REVISION` as a runtime `ENV`,
but — unlike the pdpp Dockerfile this tooling was ported from — it does not
set an `org.opencontainers.image.revision` OCI label at all (no
`PDPP_BUILD_REVISION` build-arg, no `LABEL` instruction). Building `--target
core` both with and without `--build-arg PDPP_REFERENCE_REVISION=$(git
rev-parse HEAD)` confirms `deploy/docker/check-image-identity.sh` fails in
**both** `--require-known` and `--allow-unknown` mode against either image:
the script treats a completely absent label as its own violation, distinct
from (and not rescued by) `--allow-unknown`, which only widens acceptance for
a label that is literally present and set to `"unknown"`. This is not a bug
in the check script — it is faithfully reporting an identity contract this
Dockerfile does not implement yet. Adding the label (and ideally a matching
`PDPP_BUILD_REVISION` build-arg, mirroring the pdpp Dockerfile) is a
follow-up to this restoration; until then, this check cannot pass in either
mode against images built from this repo.

## Quickstart

```sh
docker run -d --name pdpp --restart unless-stopped -p 127.0.0.1:7662:7662 \
  -v pdpp_data:/var/lib/pdpp \
  ghcr.io/pdp-connect/data-connect/core:latest && docker logs -f pdpp
```

The command keeps the container running in the background and follows its logs
so the first-boot password is visible immediately. Press `Ctrl-C` to stop
following the logs; it does not stop the container. On first boot the
container generates an owner password, saves it to the `pdpp_data` volume,
and prints a one-time banner:

```
[core] ────────────────────────────────────────────────────────────────
[core] First boot — generated an owner password for this instance.
[core]
[core]   Dashboard:      http://localhost:7662/
[core]   Owner password: hCJ3hQ0X8evNNCH9R9KqL5Ai
[core]
[core] Saved to /var/lib/pdpp/owner-password (on the data volume), so restarts keep
[core] this password. To change it, set the PDPP_OWNER_PASSWORD environment
[core] variable and restart; the environment variable always wins.
[core] This password is printed only on first boot.
[core] ────────────────────────────────────────────────────────────────
```

Open the dashboard URL, sign in with the printed password, and connect your
first source. Records live in SQLite on the `pdpp_data` volume; restarts and
container replacements keep your data and your password. Prefer to choose the
password yourself? Add `-e PDPP_OWNER_PASSWORD=...` when you create the
container. Keep that setting in your deployment configuration for future
replacements; an environment value wins over the password stored on the
volume, and no generated-password banner is printed.

The first request can arrive while the reference services are still warming up.
PDPP shows a startup page and retries automatically; wait for the dashboard
instead of restarting the container. If the page remains unavailable after the
container reports that the reference services are ready, inspect the recent
logs with `docker logs --tail=200 pdpp`.

The quickstart serves plain HTTP on localhost. That is fine on your own
machine; do not port-forward it to the internet as-is. For a public node, put
an HTTPS reverse proxy in front and set
`-e PDPP_REFERENCE_ORIGIN=https://your-domain` so the advertised OAuth
metadata matches the real origin — or use the production path below.

## Production

[`docker-compose.yml`](./docker-compose.yml) runs one Core application service
plus Postgres with pgvector. No repository clone required:

```sh
mkdir pdpp && cd pdpp
curl -fsSLO https://raw.githubusercontent.com/PDP-Connect/data-connect/main/deploy/docker/docker-compose.yml
umask 077
PDPP_OWNER_PASSWORD="$(openssl rand -base64 24)"
PDPP_CREDENTIAL_ENCRYPTION_KEY="$(openssl rand -hex 32)"
printf 'PDPP_OWNER_PASSWORD=%s\nPDPP_CREDENTIAL_ENCRYPTION_KEY=%s\n' \
  "$PDPP_OWNER_PASSWORD" "$PDPP_CREDENTIAL_ENCRYPTION_KEY" > .env
echo PDPP_CORE_IMAGE=ghcr.io/pdp-connect/data-connect/core:latest >> .env
docker compose up -d && printf '\nPDPP is running at http://localhost:7662/\nOwner password: %s\n\nKeep this password with the .env file.\n' "$PDPP_OWNER_PASSWORD"
```

The password is generated in the terminal, saved in `.env`, and printed only
after the stack starts successfully. The encryption key is saved but never
printed.

The compose file refuses to boot until both secrets exist in `.env` — the
owner password gates the dashboard, and the credential encryption key seals
any connector credentials you store. Keep `.env` with your backups.

Configuration knobs (all optional, set in `.env`):

```sh
PDPP_REFERENCE_ORIGIN=https://pdpp.example.com  # public origin; default http://localhost:7662
PDPP_WEB_PORT=7662                              # published reference AS port
PDPP_POSTGRES_PASSWORD=...                      # change if you ever publish Postgres
PDPP_EMBEDDING_DOWNLOAD_ALLOWED=0               # opt out of semantic search model download
```

To enable the API-backed Google Maps Data Portability source, create a Google
OAuth client for your PDPP origin and add the callback URL to Google exactly as
shown:

```sh
GOOGLE_DATAPORTABILITY_CLIENT_ID=...
GOOGLE_DATAPORTABILITY_CLIENT_SECRET=...
GOOGLE_DATAPORTABILITY_REDIRECT_URI=https://pdpp.example.com/_ref/provider-auth/callback
# Optional: comma-separated documented Maps resource groups; blank = connector default.
GOOGLE_DATAPORTABILITY_RESOURCE_GROUPS=
```

These are deployment-level OAuth app settings. They are not per-account Google
credentials, and a Gmail/Google app password cannot authorize the Google Data
Portability API.

**Browser-backed connectors:** the `core` image includes full Patchright
Chromium and Xvfb. Core defaults every local browser session to headed mode
under the managed virtual display while preserving per-connector persistent
profiles and direct-CDP streaming. Set `PDPP_BROWSER_HEADLESS=1` only for the
advanced deployment-wide headless/minimal path. n.eko remains optional and
headed: when configured, the runtime attaches to its remote CDP browser.
`reference` and `reference-browser` remain split-runtime compatibility images.

Serve a real domain through your HTTPS reverse proxy (Caddy, Traefik, nginx)
pointed at the Core port, and set `PDPP_REFERENCE_ORIGIN` to that domain so
owner-session cookies and OAuth metadata are correct.

## Verification

```sh
curl -fsS "$ORIGIN/.well-known/oauth-authorization-server" | head -c 200; echo
curl -s -o /dev/null -w '%{http_code}\n' "$ORIGIN/"   # 307 -> /owner/login (gated)
```

Sign in at `$ORIGIN/`, then check Deployment in the console for the
runtime diagnostics surface (`GET /_ref/deployment`).

## Storage and upgrades

- Quickstart: everything (SQLite database, owner password, credential
  encryption key) lives on the `pdpp_data` volume. Back up the volume.
- Bulk connector artifacts that must survive an upgrade — the Slack workspace
  archive, downloaded statement PDFs — live under
  `/var/lib/pdpp/connector-artifacts`, on that same volume. One volume covers
  them; do not add a second mount.
- Production: records live in the `pdpp-postgres-data` volume, semantic model
  files and first-boot state live in `pdpp-data`, and secrets live in `.env`.
  Back up all three together.

Upgrade by pulling and recreating; volumes persist:

```sh
docker pull ghcr.io/pdp-connect/data-connect/core:latest && docker rm -f pdpp && <your docker run>
# or, compose:
docker compose pull && docker compose up -d
```

`:latest` is the released channel: it moves only when a release succeeds, and
it always resolves to the same image as that release's own version tag. Prefer
it for a node you want to keep current.

For a reproducible deployment — pinning a known-good build, or reproducing a
bug against one exact image — name an immutable tag instead. Both the release
version (`core:1.5.1`) and the commit build (`core:sha-<rev>`) are published
and never move; browse GHCR for the available tags. `:main` also exists and
tracks the default branch, ahead of any release; it is a development tag, not
an onboarding target.

## Revision drift monitoring

Production images bake `PDPP_REFERENCE_REVISION` at build time (see the
Dockerfile). `check-prod-revision-drift.sh` reads that value back out of a
running container, fetches origin, and confirms the running revision is
actually reachable from origin and not too far behind `main`:

```sh
deploy/docker/check-prod-revision-drift.sh <container-name>
```

Exits nonzero on either finding, with the revision-not-on-origin case called
out loudest since it means the running image cannot be traced to any
reviewed commit:

- revision missing, `unknown`, or not a resolvable commit, or not reachable
  from any origin branch — the loudest failure
- revision resolves and is on origin, but more than
  `PDPP_DRIFT_THRESHOLD_DAYS` (default 7) behind `main`

Run it on a schedule (e.g. a daily systemd timer) and alert on nonzero exit.

## Teardown

```sh
docker rm -f pdpp && docker volume rm pdpp_data        # quickstart
docker compose down --volumes                          # production (deletes data)
```

## Related

- [`deploy/railway/README.md`](../railway/README.md) — the Railway pushbutton
  Core target this image was proven on.
- [`deploy/flyio/README.md`](../flyio/README.md) — the Fly.io `fly launch`
  path for the same image.
- [`deploy/railway/core-first-boot.ts`](../railway/core-first-boot.ts) — the
  first-boot owner-credential bootstrap. In pdpp this was tested by
  `pnpm docker:first-boot:test` (`scripts/docker-core-first-boot.test.ts`);
  that test file was not part of this deploy-tooling restoration and does not
  exist in this repo yet.
- [`../../docker-compose.yml`](../../docker-compose.yml) — the
  development/owner stack (connector credentials, fixtures, browser services);
  not the self-host entry point.
