# Deploy a PDPP Core node with Docker

Two paths, by intent:

- **Quickstart** — one `docker run`, SQLite on a named volume, running on a
  laptop in under a minute. Start here.
- **Production** — the same one-service Core Compose stack with Postgres +
  pgvector for a node you intend to keep.

Both use the root `Dockerfile` `core` target. That target builds the same
bundled Core runtime as the Railway button and the Fly.io launch path: the
operator console listens on container port `3000`, and the Authorization
Server and Resource Server listen on loopback inside the container. The
published image is `ghcr.io/pdp-connect/data-connect/core:*`; it bundles
Patchright/Chromium, enables semantic search downloads, and persists runtime
state under `/var/lib/pdpp`.

The repository also still has `deploy/docker/Dockerfile`. Its `core` stage
now builds the bundled console + AS/RS Core runtime (same as root Dockerfile),
and both core build paths enforce the same image identity contract described
below: OCI labels (org.opencontainers.image.revision, source, created),
runtime env matching, and full-SHA validation. The root `Dockerfile` remains
the canonical production path (published to GHCR); `deploy/docker/Dockerfile`
supports manual/Compose builds and must carry the same identity guarantees.

## Building from `main` (or any commit) with a real identity

A candidate image built from a specific commit should carry that commit's
exact git SHA as its runtime identity (`PDPP_REFERENCE_REVISION`, the env var
the acceptance receipt reads). Build with:

```sh
docker build --target core \
  --build-arg PDPP_REFERENCE_REVISION="$(git rev-parse HEAD)" \
  -t data-connect-core:candidate .
```

An ordinary local root `docker build --target core .`
with no `PDPP_REFERENCE_REVISION` is still valid: the runtime revision
defaults to the honest value `unknown` rather than a fabricated SHA. That
build is for local development only and must never be treated as
attributable to a commit.

The root `Dockerfile` `core` target also stamps
`org.opencontainers.image.revision` from `PDPP_BUILD_REVISION`, defaulting it
to the same value as `PDPP_REFERENCE_REVISION`, and fails the build if the two
identities diverge. For release or production builds, pass the full commit SHA
and the OCI metadata together:

```sh
docker build --target core \
  --build-arg PDPP_REFERENCE_REVISION="$(git rev-parse HEAD)" \
  --build-arg PDPP_BUILD_SOURCE="https://github.com/PDP-Connect/data-connect" \
  --build-arg PDPP_BUILD_CREATED="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --build-arg PDPP_BUILD_DIRTY="$(git diff --quiet && git diff --cached --quiet && echo 0 || echo 1)" \
  --build-arg PDPP_BUILD_COMPOSITION=core \
  -t data-connect-core:candidate .
```

## Quickstart

```sh
docker run -d --name pdpp --restart unless-stopped \
  -p 127.0.0.1:7662:3000 \
  -e PDPP_BIND_HOST=127.0.0.1 \
  -e PDPP_REFERENCE_ORIGIN=http://localhost:7662 \
  -e PDPP_TRUSTED_HOSTS=localhost,127.0.0.1 \
  -v pdpp_data:/var/lib/pdpp \
  ghcr.io/pdp-connect/data-connect/core:latest && docker logs -f pdpp
```

The command keeps the container running in the background and follows its logs
so the first-boot setup token is visible immediately. The port flag publishes
the Core container's console port, host `127.0.0.1:7662` to container `3000`;
the AS/RS ports are internal loopback listeners in this image. Press `Ctrl-C`
to stop following the logs; it does not stop the container. On first boot with
no `PDPP_OWNER_PASSWORD`, the reference server creates a one-time setup token
and serves the claim wizard at `/setup`. Find the `setupToken` field in the
reference server's startup logs.

Open `http://localhost:7662/setup`, enter the setup token, and choose the
owner password. Records, browser profiles, connector artifacts, and the
generated credential encryption key live on the `pdpp_data` volume; restarts
and container replacements keep them. Prefer scripted setup? Add
`-e PDPP_OWNER_PASSWORD=...` when you create the container. Keep that setting
in your deployment configuration for future replacements; an environment value
skips the setup wizard.

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

### Use a tunnel for remote MCP access

Keep the Docker port bound to host loopback and point the tunnel at
`http://127.0.0.1:7662`. Set the tunnel's public hostname as the advertised
origin and allow it as a trusted host when you start Core:

```sh
export TUNNEL_HOST=your-subdomain.example-tunnel.com
docker run -d --name pdpp --restart unless-stopped \
  -p 127.0.0.1:7662:3000 \
  -e PDPP_BIND_HOST=0.0.0.0 \
  -e PDPP_REFERENCE_ORIGIN="https://${TUNNEL_HOST}" \
  -e PDPP_TRUSTED_HOSTS="localhost,127.0.0.1,${TUNNEL_HOST}" \
  -v pdpp_data:/var/lib/pdpp \
  ghcr.io/pdp-connect/data-connect/core:latest
```

If the container already exists, recreate it with the same volume and updated
environment. The tunnel needs to forward the public hostname to the local
address above; do not publish the container port directly.

## Production

[`docker-compose.yml`](./docker-compose.yml) runs one Core application service
plus Postgres with pgvector. No repository clone required:

```sh
mkdir pdpp && cd pdpp
curl -fsSLO https://raw.githubusercontent.com/PDP-Connect/data-connect/main/deploy/docker/docker-compose.yml
umask 077
PDPP_CREDENTIAL_ENCRYPTION_KEY="$(openssl rand -hex 32)"
printf 'PDPP_CREDENTIAL_ENCRYPTION_KEY=%s\n' "$PDPP_CREDENTIAL_ENCRYPTION_KEY" > .env
echo PDPP_CORE_IMAGE=ghcr.io/pdp-connect/data-connect/core:latest >> .env
docker compose up -d && printf '\nPDPP is running at http://localhost:7662/\nOpen /setup and use the one-time setup token from: docker compose logs core\n\n'
```

The encryption key is saved but never printed. With no
`PDPP_OWNER_PASSWORD`, the hosted instance boots locked; open
`http://localhost:7662/setup` and use the one-time setup token from
`docker compose logs core` to choose the owner password. For scripted
deployments, add an owner password to `.env` before starting the stack:

```sh
printf 'PDPP_OWNER_PASSWORD=%s\n' "$(openssl rand -base64 24)" >> .env
```

The compose file refuses to boot until the credential encryption key exists in
`.env`; it seals any connector credentials you store. Keep `.env` with your
backups. `PDPP_OWNER_PASSWORD` is optional: set it for scripted deployments or
leave it unset to claim the install at `/setup`.

Configuration knobs (all optional, set in `.env`):

```sh
PDPP_REFERENCE_ORIGIN=https://pdpp.example.com  # public origin; default http://localhost:7662
PDPP_BIND_HOST=127.0.0.1                        # default; use 0.0.0.0 for hosted public-origin setup
PDPP_TRUSTED_HOSTS=localhost,127.0.0.1          # include your tunnel or reverse-proxy host
PDPP_WEB_PORT=7662                              # host port mapped to container port 3000
PDPP_POSTGRES_PASSWORD=...                      # change if you ever publish Postgres
PDPP_EMBEDDING_DOWNLOAD_ALLOWED=0               # opt out of semantic search model download
```

For a public tunnel or reverse proxy, set `PDPP_REFERENCE_ORIGIN` to its HTTPS
origin and add its hostname to `PDPP_TRUSTED_HOSTS`. Keep
`localhost,127.0.0.1` in the list for the Core service's internal requests.

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

- Quickstart: everything (SQLite database, setup state, browser profiles,
  connector artifacts, and the generated credential encryption key) lives on
  the `pdpp_data` volume. Back up the volume.
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
  first-boot credential encryption-key bootstrap. Owner-password setup is
  handled by the reference server's `/setup` flow.
- [`scripts/docker-core-first-boot.test.ts`](../../scripts/docker-core-first-boot.test.ts)
  covers the local Core first-boot contract.
- [`../../docker-compose.yml`](../../docker-compose.yml) — the
  development/owner stack (connector credentials, fixtures, browser services);
  not the self-host entry point.
