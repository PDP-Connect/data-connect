# PDPP demo for the Dominican Republic: the consent screen

> **Resumen.** Demostración del flujo de consentimiento PDPP con datos ficticios. Servicios Proactivos (simulado) pide, una sola vez, el control prenatal de María (SNS) y su ficha de hogar (SIUBEN), para un propósito y hasta una fecha. María inicia sesión con una Cuenta Única simulada, ve una sola pantalla de consentimiento, autoriza, y luego ve y revoca el permiso en "Mis autorizaciones". No es una integración con ningún sistema del Estado.

A working demo of the PDPP grant flow, set in a Dominican Republic scenario. Every person and record is fictitious. Nothing here connects to a state system: the sign-in simulates Cuenta Única, the institutions are seeded test data, and one server plays the authorization server and every institution's resource server.

## Try it

| What | URL |
|---|---|
| Start here: Servicios Proactivos (simulated) | https://proactivos-demo-rd.fly.dev (`?lang=en` for English) |
| Mis autorizaciones (simulated Soy Yo RD view) | https://pdpp-demo-rd.fly.dev/owner/autorizaciones |

The password is shared separately. The cédula is pre-filled (`000-1234567-8`); only the password is checked. Every page has an **ES | EN** toggle.

Everyone with the password shares the same citizen, María. To start from a clean slate, press **Reiniciar demostración** at the bottom of Mis autorizaciones: it revokes every authorization and clears the list.

Walkthrough, step by step: [DEMO.md](./DEMO.md).

## The story

María is pregnant. Servicios Proactivos offers to arrange her baby's vaccinations and the child benefit at birth, without her applying. To do that it asks, once, for two records:

| Institution | Record | Fields asked for |
|---|---|---|
| SNS | Prenatal care (`control_prenatal`) | name, health centre, weeks of pregnancy, expected due date |
| SIUBEN | Household classification (`clasificacion_hogar`) | ICV group and description, household size, municipality, province |
| SIUBEN | Household members (`miembros_hogar`) | name, relationship, age |

Purpose: *"Preparar la vacunación de su bebé y el bono por hijo al nacer, sin que usted tenga que solicitarlos."* Until: 31 January 2027.

She can untick the household members and optional fields such as the health centre. Fields the service cannot act without stay locked.

## How it works

```
 browser                 Servicios Proactivos              PDPP server
 (María)                 proactivos-demo-rd                pdpp-demo-rd
 ───────                 ────────────────────              ──────────────────────────
 "Decir sí"        ──▶   registers as a client (once)  ──▶ POST /oauth/register
                   ◀──   redirect: what, why, until when
 ─────────────────────────────────────────────────────────▶ /oauth/authorize
                                                            Cuenta Única-style sign-in
                                                            one consent screen
                                                            Autorizar → one grant per institution
 ◀──────────────────────────────────────────────────────── redirect with code
                         exchange code for a token     ──▶ POST /oauth/token
                         read granted records          ──▶ GET /v1/streams/…/records
                                                            (only granted fields; read logged)
 "Listo": what arrived
 Mis autorizaciones ──────────────────────────────────────▶ what she allowed, what was read, Revocar
```

Mapped to the steps of the grant flow:

| Step | In this demo |
|---|---|
| Sign in; the authorization server learns who this is | Simulated Cuenta Única sign-in. The password stands in for the real login and cédula claim. |
| The recipient asks for fields, purpose, end date; the consent screen shows them | Servicios Proactivos sends the request; one screen shows it. |
| Approve; the grant is recorded; the recipient gets a token | Autorizar. One approval creates one grant per institution, since a PDPP grant is bound to a single source. |
| The recipient calls the institution; only granted fields come back | Reads of the SNS and SIUBEN records, filtered to the granted fields. |
| The release is logged | "Lo que se leyó" in Mis autorizaciones. |

Not shown: X-Road between the recipient and the institutions, the real Cuenta Única, and Soy Yo RD. Mis autorizaciones is a simulated view of how it could look there.

## Where the demo goes beyond the PDPP spec

- **End date.** Requested by the recipient. The spec's grant has `expires_at`, but its request has no field for it, so this is a reference extension.
- **Read log for the citizen.** "What was read and when" is this implementation's. The core spec defines no citizen-facing access log (§11–12).
- **Unticking.** The citizen can untick any requested stream and optional field. The spec defines owner choice only for streams the client marks optional (§5). Schema-required fields stay locked, as the spec requires.

## Fictitious data

One household, keyed by cédula `000-1234567-8` (the `000` prefix is never issued):

| Institution | Record | Contents |
|---|---|---|
| SNS | `control_prenatal` | María Altagracia Rosario Peña, 32 weeks, due 20 November 2026, Hospital Materno Infantil (demo) |
| SIUBEN | `clasificacion_hogar` | ICV-2 (pobreza moderada), 2 members, Aliméntate, Santo Domingo Este |
| SIUBEN | `miembros_hogar` | María (jefa del hogar), Luis Manuel Pérez Santos (cónyuge) |
| INTRANT | `licencias_conducir` | Seeded but not requested; shows that nothing unasked is shared |

## Where the code is

This branch is the PDPP reference implementation plus the demo. The demo-specific parts:

| Part | Path |
|---|---|
| Servicios Proactivos portal (zero-dependency Node) | [`proactivos-portal/`](./proactivos-portal) |
| Cuenta Única-style sign-in | `reference-implementation/server/owner-auth.ts` |
| Consent screen (Spanish/English, unticking) | `reference-implementation/server/routes/as-consent-ui-helpers.ts`, `as-consent.ts` |
| Mis autorizaciones (list, revoke, reset) | `reference-implementation/server/routes/owner-autorizaciones.ts`, `citizen-grants.ts` |
| Page shell, language toggle | `reference-implementation/server/citizen-ui.ts`, `demo-i18n.ts` |
| Institutions (source manifests) | `reference-implementation/fixtures/seed-manifests/{sns,siuben,intrant}.json` |
| Fictitious records | `reference-implementation/connectors/seed/index.ts` ("Dominican Republic demo fixtures") |

Demo branch, not production code: some existing tests pin English copy that the demo changed to Spanish.

## Run it locally

Needs Node 24.15 or later.

```bash
npm ci
scripts/demo-dr/demo.sh seed                                   # load the fictitious records (once)
PDPP_OWNER_PASSWORD='choose-one' scripts/demo-dr/demo.sh start # PDPP server on http://localhost:3000

# second terminal
cd scripts/demo-dr/proactivos-portal
PDPP_ORIGIN=http://localhost:3000 node server.mjs              # portal on http://localhost:8080
```

Open http://localhost:8080. `scripts/demo-dr/demo.sh reset` deletes the local database.

If `npm ci` fails with `reference is not a tree`: `@opendatalabs/data-connectors-tools` is pinned to a commit that npm's mirror clone cannot fetch. Install with a git wrapper that fetches the SHA on demand:

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

## Check it end to end

Plays the whole flow in a headless browser (offer, sign-in, consent, data received, revoke, refused re-read, denial) and saves screenshots. `RESET=1` finishes with a demo reset.

```bash
LANG=es RESET=1 PORTAL_URL=http://localhost:8080 OWNER_PASSWORD='choose-one' \
  node scripts/demo-dr/proactivos-e2e.mjs
```

Set `CHROMIUM_PATH` if Playwright's bundled browser is not installed. `DESELECT=1` also checks that unticked items never leave the institution.

## Other files

| File | Purpose |
|---|---|
| [DEMO.md](./DEMO.md) | Step-by-step walkthrough |
| [FLY.md](./FLY.md) | Hosting on Fly.io: deploy, seed, reset, tear down |
| `record-demo.mjs` | Records the flow as video, paced for narration |
| `reset-live.sh` | Full reset of the hosted demo (wipe and re-seed) |
| `seed-remote.ts` | Seeds a hosted server over HTTPS |
| `e2e-check.mjs` | Checks the MCP client path; not part of this demo |
