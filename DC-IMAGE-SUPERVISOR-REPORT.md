# DC image supervisor report

Date: 2026-09-03

## Diff summary

- Added `deploy/railway/core-supervisor.ts` as the container PID 1. It starts
  Xvfb (unless `PDPP_BROWSER_HEADLESS=1`), the reference AS/RS on loopback
  ports 7662/7663, and the standalone Next.js console on `$PORT` (3000 by
  default). It propagates termination and publishes a readiness file only when
  both reference ports accept TCP connections.
- Added a `console-builder` Docker stage and copied Next standalone, static,
  and public output into `/console` in the `core` target. The target now
  exposes 3000 and invokes the supervisor.
- Marked browser-capable image stages with `PDPP_RUNTIME_BROWSER=1`; the
  reference runtime requires this marker and `DISPLAY` before it permits headed
  browser connector launches.
- Added `@pdpp/polyfill-connectors` to the console's Next transpilation list.
  The console imports that vendored TypeScript through the reference package;
  without this entry `next build` fails to parse it.
- Updated one console test to use the package's exported
  `@pdpp/polyfill-connectors/static-secret-injection` path. Its former source
  path is not resolvable by TypeScript after the vendoring move.

## Image build

Command:

```sh
docker build --target core --build-arg PDPP_REFERENCE_REVISION=$(git rev-parse HEAD) --tag pdpp-banner-zero:data-connect-$(git rev-parse --short=8 HEAD) -f deploy/docker/Dockerfile .
```

Result: success.

Image ID: `sha256:d023e20eb48876c410b0560df630b98abf48c2fc51f8d0a94e13cceefbab4850`

Entrypoint command:

```text
["node","--import","tsx","/app/deploy/railway/core-supervisor.ts"]
```

Build tail:

```text
#34 [console-builder 1/1] RUN npm run build --workspace=apps/console
#34 ✓ Compiled successfully
#34 Finished TypeScript
#34 DONE 23.3s
#37 [core 1/3] COPY --from=console-builder .../.next/standalone /console
#38 [core 2/3] COPY --from=console-builder .../.next/static /console/apps/console/.next/static
#39 [core 3/3] COPY --from=console-builder .../public /console/apps/console/public
#40 writing image sha256:d023e20eb48876c410b0560df630b98abf48c2fc51f8d0a94e13cceefbab4850
#40 naming to docker.io/library/pdpp-banner-zero:data-connect-3b2d4398
#40 DONE
```

## Isolated runtime proof

Created a throwaway `postgres:16-alpine` database and a dedicated Docker
network. The test image was published only on `127.0.0.1:3009`; it was given
dummy owner/encryption secrets plus the inspected production storage-contract
variables. No production container, port, or database was used.

First boot exposed one required production contract variable:

```text
production local semantic execution requires
PDPP_LOCAL_TRANSFORMER_SUPERVISOR_RESTART_CONTRACT=1
```

The retry supplied that inspected production variable (and disabled embedding
downloads); it completed successfully.

Proof command/result tail:

```text
GET http://127.0.0.1:3009/owner/login
owner_status=200
owner_html=<title>PDPP Reference Provider — Owner sign-in

GET http://127.0.0.1:3009/.well-known/oauth-authorization-server
well_known_status=200
well_known_issuer=http://127.0.0.1:3009

GET /oauth/authorize with the ChatGPT request shape and Accept: text/html
authorize_html_status=302
location: /owner/login?return_to=%2Foauth%2Fauthorize...

POST /owner/login with the dummy owner password and CSRF field
login_post_status=302
location: /oauth/authorize?response_type=code&client_id=https%3A%2F%2Fchatgpt.com...

Authenticated retry of that authorization request
post_login_authorize_status=302
location: http://127.0.0.1:3009/consent?challenge=cc_NEPd99YCSZpk8f8DFr5Pbvnh

GET that consent URL through the console
consent_page_status=200
consent_page_title=<title>PDPP — Personal Data Portability Protocol

Final rerun summary
owner=200 well_known=200 authorize_code=302 login_post_code=302
consent_redirect_code=302 consent_page=200
PDPP_RUNTIME_BROWSER=1
```

The supervisor log included successful AS proxy requests for `/owner/login`,
`/.well-known/oauth-authorization-server`, and the authenticated
`/oauth/authorize` request, followed by the console's request to
`/oauth/authorize/consent-challenges/cc_NEPd99YCSZpk8f8DFr5Pbvnh`.

After proof, the scratch app container, Postgres container, and Docker network
were stopped and removed. `docker image prune -f` was run; it reclaimed 0 B.
An intervening `docker builder prune -f` reclaimed 19.47 GB of dangling build
cache after the disk filled during verification.
