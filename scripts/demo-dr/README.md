# DR citizen-assistant demo

A contextualised demo of the PDPP grant flow for the Dominican Republic. It is not an integration with any state system: the login simulates Cuenta Única, the citizen and every record are fictitious, and one laptop plays every box in the architecture diagram.

What the audience sees:

1. In Claude or ChatGPT, the citizen asks a question about their benefits and licence.
2. The assistant has no access yet, so the connector opens a Cuenta Única-style sign-in (cédula + password).
3. A Spanish consent screen lists two sources: **SIUBEN** (household classification, household members) and **INTRANT** (driving licence). The citizen approves SIUBEN only.
4. The assistant answers from the SIUBEN records. Asked about the licence, it is refused (`stream_not_allowed`).
5. The console's **Grants** page shows every read, including the refused one. Revoking the package there cuts the assistant off.

How this maps to the slide-11 diagram: the simulated login stands in for Cuenta Única (steps 1–2); the consent screen and grant ledger are the PDPP authorisation server (steps 3–4); the resource server that serves granted fields only is the same process (step 6). There is no X-Road hop (step 5) and no institution database (step 7).

## Fictitious data

One citizen, cédula `000-1234567-8` (the `000` prefix is never issued):

| Source | Stream | Contents |
|---|---|---|
| SIUBEN | `clasificacion_hogar` | ICV-2 (pobreza moderada), score 38.6, 4 members, Aliméntate + Bono Gas Hogar, Santo Domingo Este |
| SIUBEN | `miembros_hogar` | 4 members: jefa de hogar, cónyuge, two school-age children |
| INTRANT | `licencias_conducir` | Categoría 2, expires **2026-11-14** (soon), corrective lenses |

Edit `reference-implementation/connectors/seed/index.ts` (the "Dominican Republic demo fixtures" block) and the manifests in `reference-implementation/fixtures/seed-manifests/{siuben,intrant}.json` to change it, then `demo.sh reset && demo.sh seed`.

## Setup (once)

```bash
npm ci
scripts/demo-dr/demo.sh seed
```

`npm ci` note: `@opendatalabs/data-connectors-tools` is pinned to a commit (`6c71697`) that is not on any branch of `PDP-Connect/data-connectors`, so npm's mirror clone can fail with `reference is not a tree`. If it does, install with a git wrapper that fetches the SHA on demand:

```bash
cat > /tmp/gitwrap.sh <<'EOF'
#!/bin/bash
git "$@"; rc=$?
last="${@: -1}"
if [ $rc -ne 0 ] && [[ " $* " == *" checkout "* && "$last" =~ ^[0-9a-f]{40}$ ]]; then
  git fetch -q origin "$last" && git "$@"; rc=$?
fi
exit $rc
EOF
chmod +x /tmp/gitwrap.sh && npm ci --git=/tmp/gitwrap.sh
```

## Run

Hosted instance for the team: see [FLY.md](./FLY.md) (`https://pdpp-demo-rd.fly.dev`).


The connectors in Claude and ChatGPT need a public HTTPS URL. Start the tunnel first, because the server must know its public origin at boot:

```bash
cloudflared tunnel --url http://localhost:3000        # note the https://….trycloudflare.com URL
PDPP_OWNER_PASSWORD='choose-one' scripts/demo-dr/demo.sh start https://….trycloudflare.com
```

A quick tunnel gets a new URL every run, which means re-adding the connector each time. For the event, use a named Cloudflare tunnel or a reserved ngrok domain so the URL stays fixed.

Local only (no connectors, browser flow and e2e check only): `PDPP_OWNER_PASSWORD=… scripts/demo-dr/demo.sh start`.

## Connect the assistants

- **Claude**: add a custom connector with the URL `https://<origin>/mcp`. Claude registers itself (dynamic client registration) and opens the sign-in page.
- **ChatGPT**: add an MCP connector (developer mode) with the URL `https://<origin>/mcp` and OAuth authentication.

Menu names in both products change often; the only input either needs is the `/mcp` URL. Try both at least a day before the demo.

## Suggested script

1. *"¿Para qué programas sociales podría calificar mi hogar? ¿Y cuándo vence mi licencia de conducir?"*
2. Sign in (cédula is pre-filled; type the password). On the consent screen, tick SIUBEN, leave INTRANT unticked, optionally open SIUBEN to narrow fields or dates, pick when access ends (90 días / 1 año / sin fecha de fin), then **Autorizar acceso**.
3. The assistant answers about the household (ICV-2, current programmes, school-age children) and says it cannot see the licence.
4. Open `https://<origin>/grants`: every read is listed, including "Query rejected" for the licence.
5. Open the grant package, tick the confirmation, **Revoke package**. Ask the assistant again: it can no longer read.

## Verify before presenting

With the demo running (`start`), this plays an MCP client end to end in headless Chromium and saves screenshots:

```bash
REVOKE=1 AS_URL=http://localhost:3000 RS_URL=http://localhost:3000 \
OWNER_PASSWORD='choose-one' SHOTS_DIR=/tmp/demo-dr-shots node scripts/demo-dr/e2e-check.mjs
```

Set `CHROMIUM_PATH` if Playwright's bundled browser is not installed. Run it against a fresh database (`reset` + `seed`): the revoke step opens the newest grant package.

## Known gaps (say them out loud)

- The server-assigned purpose is the same for every app.
- The cédula field is decorative; the password is the real check. There is no Cuenta Única, OIDC or `cedula` claim involved.
- The console (grants, revoke) is in English; only the citizen-facing pages are in Spanish.
- `pdpp seed` prints "Dataset summary … records: 0"; that summary call has no owner session. The records are there.

## What changed on this branch

- `reference-implementation/fixtures/seed-manifests/{siuben,intrant}.json`: the two sources.
- `reference-implementation/connectors/seed/index.ts`: the fictitious records.
- `reference-implementation/server/owner-auth.ts`: sign-in page styled as simulated Cuenta Única.
- `reference-implementation/server/routes/as-consent-ui-helpers.ts`: consent picker in Spanish.
- `reference-implementation/server/hosted-ui.ts`: `lang="es"`, `#003876` primary colour, "datos ficticios" banner.

Existing tests that pin the English copy of those pages fail on this branch; that is expected for a demo branch and is why this should not be merged into the main line as is.
