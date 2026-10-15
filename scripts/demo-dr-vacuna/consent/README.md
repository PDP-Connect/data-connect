# DR pilot: parent approval of a child's vaccination-record grant

Pilot-only. The reference server keeps its single instance owner as the data
holder (the vaccination register). A second kind of principal, a parent or
legal guardian, signs in through a Cuenta Única stub and may approve or revoke
grants only for children the civil-registry stub says they have authority
for. Server code: `reference-implementation/server/pilot-dr-vacuna/`, inert
unless `PDPP_PILOT_DR_VACUNA=1` (Postgres only).

## Flow

1. The client starts as usual: `POST /oauth/par` or `GET /oauth/authorize`
   with one `child_immunizations` stream. `resources: [child_id]` names the
   child; without it the parent picks from their own registry children.
   `GET /consent` for a request on the pilot source redirects to
   `/pilot/vacuna/consent`.
2. Parent signs in at `/pilot/cuenta-unica/login` (cédula + demo password
   `vacuna-demo-2026`, override with `PDPP_PILOT_DR_VACUNA_DEMO_PASSWORD`).
3. `POST /pilot/vacuna/consent/select`: the registry check
   `isGuardian(cédula, child)` runs before anything about the child is read.
   - Refused: the pending request is denied, the client gets a plain
     `access_denied` (OAuth redirect with `state`, or device-code poll), and the
     spine gets `representative.authority_refused` with
     `reason: "registry_refusal"` and the registry reason.
   - Confirmed: the core review is finalized for subject = child, resources
     narrowed to that child, `expires_at` capped at the 18th birthday. The page
     says "Usted está actuando como madre o padre de …" / "You are acting as
     parent of …".
4. `POST /pilot/vacuna/consent/approve` re-checks the registry, then issues the
   grant with `subject: { id: child }` and
   `grantors: [{ id: <client-specific>, capacity: urn:pdpp:pilot:dr-vacuna:capacity:parent|legal-guardian }]`.
5. `/pilot/vacuna/autorizaciones` lists grants for the children the person has
   authority for today. Revoking requires `disposition=keep|delete` (no
   default), re-checks the registry, and records the choice on
   `pilot_rep_grants` and in `representative.grant_revoked`.

Every route answers JSON with `Accept: application/json`; that is the
headless path.

## Run

```sh
cd ../baseline
./db.sh up                                   # or your own Postgres; see VACUNA_DATABASE_URL
PDPP_PILOT_DR_VACUNA=1 ./start-server.sh &
node seed.ts --phase bootstrap
node seed.ts --phase records --records 2000   # creates the connector instance
node seed.ts --phase registry                 # = node ../consent/seed-registry.ts
cd ../consent
node headless-grants.ts --grants 20000 --refusals 12000 --concurrency 8 --label c8
```

`seed-registry.ts` (deterministic, ~50 s): 980,200 children, 566,953
families, 650,371 adults, 1,124,335 guardianships (144,135 children with two
parents, 29,082 with a legal guardian), and a 60,000-row refusal set
(10,000 suspended authorities, 50,000 parent-asks-for-someone-else's-child).
Flags: `--children`, `--refusals`, `--suspended`.

## Headless rate (this workstation, shared with other load tests)

Real path per grant: PAR, Cuenta Única login (once per parent), select
(registry check + core review), approve (grant, token, spine events).

| run | grants/s | refusals/s | mean ms: PAR / select / approve | 980,200 grants |
|---|---:|---:|---|---:|
| 8 concurrent, 20k grants, 12k refusals | 128.6 | 287.4 | 9.8 / 14.5 / 37.3 | 2.1 h |
| 16 concurrent, 20k grants, 12k refusals | 91.2 | 85.5 | 33.9 / 59.3 / 78.8 | 3.0 h |

0 errors after retrying PAR on `pending_consents_user_code_key` collisions
(167 and 192 retries): the reference AS draws a 6-hex-digit `user_code` that
must be unique across every pending-consent row ever written, so collisions
grow with volume (~1% of PARs at ~130k rows). Raw: `results/*.json`.
