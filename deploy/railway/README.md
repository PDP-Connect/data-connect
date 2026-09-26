# Deploy a PDPP Core node on Railway

This runbook describes the selected Railway pushbutton shape for the PDPP
reference implementation: one public Core app service, one durable Postgres
backend, with browser-backed connectors available in the deployed app.

This is operator documentation for someone running their own instance. The
Docker image at `ghcr.io/pdp-connect/data-connect/core` is the browser-capable
single-container artifact packaged for Railway.

The root `Dockerfile` builds the combined Core image. Its supervisor runs the
console on Railway's `$PORT` and the reference AS/RS on loopback. The console
proxies owner and protocol requests to the reference server. Separate console
and reference artifacts remain available for manual deployments.

## Pushbutton Railway template

The user-facing path is a published Railway Template with this button shape:

```md
[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new/template/pdpp-core-template-source?utm_medium=integration&utm_source=button&utm_campaign=pdpp-core)
```

Published template code: `pdpp-core-template-source`. Do not present a
placeholder template URL as a live deploy button.

The published template uses:

| Service | Source | Public? | Purpose |
|---|---|---:|---|
| `core` | `ghcr.io/pdp-connect/data-connect/core:latest` (or a pinned `<version-tag>`) | yes | Console on Railway `$PORT`; reference AS/RS and browser connectors inside the same container. |
| `Postgres` | Railway plugin | no | Durable records, grants, runs, sessions, and tokens. |

`core:latest` is the moving public image path: it advances only on a successful
release and always resolves to the same manifest as that release's version tag.
Name a concrete immutable release tag instead (for example `core:1.5.1`) when a
template revision must be reproducible. Manual diagnostic images use
`core:dispatch-sha-<rev>` and are separate from the release channel.

Whichever tag the template names, the GHCR package must be anonymously pullable
before the template is published:

```sh
npm run railway:ghcr-public -- --tag <version-tag>
```

## Topology

One public service, one private loopback AS/RS pair, one storage backend.

```
internet ──HTTPS──▶ core (public Railway app service)
                       ├─ console listens on Railway $PORT
                       ├─ AS listens on 127.0.0.1:7662
                       └─ RS listens on 127.0.0.1:7663
                            │
                            ▼
                         Postgres (Railway plugin)
```

Why this is the selected button shape: live Railway testing showed that a
separate private `reference` image service needs an explicit service `PORT` to
boot reliably, and Railway turns that `PORT` variable into a required deploy-page
prompt. The `core` image removes that prompt while preserving the
protocol shape: the public console still fronts the full protocol surface, and
the AS/RS listeners remain non-public loopback endpoints.

The older split-service artifacts (`console.env.example`, `reference.env.example`,
`railway.console.json`, `railway.reference.json`, and `reference.Dockerfile`)
remain available for manual operator experiments. They are not the selected
published-button path.

## Environment

Set these variables on the `core` service. Use
[`core.env.example`](./core.env.example) as the service-specific template and
[`env.example`](./env.example) as a consolidated reference.

```sh
PDPP_REFERENCE_ORIGIN=https://${{core.RAILWAY_PUBLIC_DOMAIN}}
PDPP_CREDENTIAL_ENCRYPTION_KEY=${{ secret(64) }}
PDPP_DATABASE_URL=${{Postgres.DATABASE_URL}}
```

`PDPP_OWNER_PASSWORD` is optional. Leave it unset to claim the install at
`/setup` with the one-time token in the Core deploy logs. Operators who
automate deployment can set it as a Railway secret; a configured value skips
the wizard.

Optional Google Maps Data Portability API support requires deployment-level
Google OAuth app material on the same `core` service:

```sh
GOOGLE_DATAPORTABILITY_CLIENT_ID=<google-oauth-client-id>
GOOGLE_DATAPORTABILITY_CLIENT_SECRET=<google-oauth-client-secret>
GOOGLE_DATAPORTABILITY_REDIRECT_URI=https://${{core.RAILWAY_PUBLIC_DOMAIN}}/_ref/provider-auth/callback
# Optional: comma-separated documented Maps resource groups; blank = connector default.
GOOGLE_DATAPORTABILITY_RESOURCE_GROUPS=
```

These are OAuth app settings for the deployment, not owner account credentials.
Do not use a Gmail/Google app password for this source; Google Data Portability
requires OAuth scopes and a matching redirect URI.

Do not set `PORT`, `AS_PORT`, `RS_PORT`, `PDPP_AS_URL`, or `PDPP_RS_URL` as
Railway variables on the `core` service. Railway injects `PORT`; the image
supervisor owns the internal AS/RS ports and loopback proxy targets. Keeping
those constants out of Railway service variables is what prevents extra
pushbutton prompts.

Preflight the selected env locally before deploying:

```sh
node --import tsx scripts/check-railway-deploy-env.ts --core deploy/railway/core.env.example
```

The committed example passes without an owner password. The wizard creates the
first owner credential after deployment.

## Storage

The selected template uses Railway Postgres:

```sh
PDPP_DATABASE_URL=${{Postgres.DATABASE_URL}}
```

The runtime selects Postgres automatically when `PDPP_DATABASE_URL` is present
and bootstraps the schema idempotently at startup. No separate migrate step is
required for first boot.

SQLite on a mounted Railway volume is a manual fallback. If used, set
`PDPP_STORAGE_BACKEND=sqlite` and point `PDPP_DB_PATH` onto the mounted volume;
the unmounted default path is not durable across redeploys.

## Security posture

- With no `PDPP_OWNER_PASSWORD`, the public instance boots locked and prints a
  one-time setup token in the Core logs. Use it at `/setup` to choose the
  owner password; owner routes remain closed until the install is claimed.
  Setting `PDPP_OWNER_PASSWORD` explicitly is the scripted alternative and
  takes precedence over the setup wizard.
- `PDPP_CREDENTIAL_ENCRYPTION_KEY` is generated by the Railway template. It is
  the instance-level wrapping key for owner-captured static-secret connector
  credentials; it is not a per-connector source credential.
- Railway terminates HTTPS and forwards the protocol; owner-session and CSRF
  cookies are marked `Secure`.
- The bundled Core browser is full Patchright Chromium. Core starts a managed
  Xvfb display and defaults every local browser session to headed mode while
  preserving direct-CDP streaming and persistent profiles. Set
  `PDPP_BROWSER_HEADLESS=1` only for the advanced deployment-wide headless
  path. n.eko remains optional and headed when remote CDP is configured.

## First-live-test gate

Run local checks before requesting or publishing a live Railway template:

```sh
npm run railway:template:test
npm run railway:env-check:test
npm run railway:mcp-query-smoke:test
```

(pdpp's original gate also ran `pnpm docker:smoke`, a composed-origin metadata
smoke script. That script — `scripts/docker-smoke.sh` — was not part of this
deploy-tooling restoration and does not exist in this repo; port it separately
if this gate needs it.)

For a live source project or scratch template deploy:

1. Deploy `core` from `ghcr.io/pdp-connect/data-connect/core:latest` (or a pinned
   `<version-tag>`) and add Railway Postgres.
2. Set `PDPP_REFERENCE_ORIGIN` and `PDPP_DATABASE_URL` as above. Leave
   `PDPP_OWNER_PASSWORD` unset for the setup wizard, or set it for scripted
   deployments.
3. Generate a public domain for `core`.
4. Confirm `/.well-known/oauth-authorization-server` returns HTTP 200 at the
   public origin.
5. Confirm AS `issuer`, RS `resource`, and RS `authorization_servers[0]` all
   equal the public origin.
6. Open `/setup`, use the setup token from the Core logs, and choose an owner
   password. Confirm anonymous owner routes stay locked before the claim.
7. Set `OWNER_PASSWORD` in your shell to the password chosen in the wizard,
   then run the deterministic MCP smoke:

   ```sh
   node --import tsx scripts/railway-mcp-query-smoke.ts \
     --origin https://<core-domain> \
     --owner-password "$OWNER_PASSWORD"
   ```

8. Restart the `core` service, then rerun the smoke with `--no-seed` to prove
   stored records and owner login survive restart.

## Template publication

Use [`template.md`](./template.md) for the publication handoff. The button is
ready for user-facing placement after the 2026-06-06 live gate:

- `npm run railway:ghcr-public` passed against the tag current at that gate
  (`sha-6581820`, since superseded and no longer published).
- A source project with exactly `core` plus Postgres passes the live gate above.
- Railway generates and publishes the template.
- A fresh scratch project deployed from the published template passes the live
  smoke and restart smoke.

## Rollback and cleanup

- Roll back a bad deploy from Railway's Deployments tab by redeploying the prior
  known-good image tag. Stored data lives in Postgres, not the app container.
- Tear down by deleting the `core` service and Postgres plugin. Removing
  Postgres removes stored data.

## Cost note

The selected button runs one always-on application service plus a storage
backend on the operator's Railway account.

## Related

- [`scripts/railway-mcp-query-smoke.ts`](../../scripts/railway-mcp-query-smoke.ts)
- [`scripts/check-railway-deploy-env.ts`](../../scripts/check-railway-deploy-env.ts)
- [`scripts/check-railway-ghcr-public.ts`](../../scripts/check-railway-ghcr-public.ts)
