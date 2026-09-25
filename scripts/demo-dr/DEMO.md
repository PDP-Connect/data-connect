# DR demo: ministry-to-ministry permissioning

The story: MIVHED needs a household's SIUBEN classification to assess a housing application. Instead of asking the citizen for a paper certificate, it asks for permission to read exactly those records, for that stated purpose, until she withdraws it. The citizen signs in with Cuenta Única, reviews the request, approves it, and the form fills itself. When she revokes the permission, MIVHED can no longer read the data.

Every page is marked "Simulación · no es el portal oficial". All people and records are fictitious. No logos or official seals are used.

## URLs

| What | URL |
|---|---|
| MIVHED portal (start here) | https://mived-demo-rd.fly.dev |
| PDPP authorization server | https://pdpp-demo-rd.fly.dev |
| Citizen's grant list (operator console, English) | https://pdpp-demo-rd.fly.dev/grants |

The password is shared separately. The cédula field is pre-filled with `000-1234567-8` and is presentational.

## Script (about 3 minutes)

1. **MIVHED portal.** "A citizen applies for a housing programme. The ministry needs her household's socio-economic classification, which SIUBEN holds." Click **Completar con mis datos del SIUBEN**.
2. **Cuenta Única sign-in.** "Same login she uses for every GOB.DO service. The banner says which service she's continuing to." Type the password.
3. **Authorization request.** "This is the one new screen. It says who is asking, for what purpose, from which institution, exactly which fields, and that access is continuous until she revokes it." Point out that the INTRANT licence is not requested. Click **Continuar**.
4. **Confirmation.** "She confirms the exact request the server recorded, including that it has no end date. The technical record is there for auditors, collapsed." Click **Autorizar**.
5. **Back at MIVHED.** The form is filled from SIUBEN, each field tagged as sourced from SIUBEN, with the authorization's identifier, purpose and access type. "She didn't carry a certificate, and SIUBEN released only what she approved." Click **Volver a consultar el SIUBEN**: "MIVHED re-checks with SIUBEN under the same authorization" (banner: *Datos verificados nuevamente…*).
6. **Revocation.** Click **Ver o revocar esta autorización** (opens a new tab), tick **Confirmo que quiero revocar esta autorización**, click **Revocar autorización**. "Every release is logged and she can withdraw it." Back on the MIVHED tab, click **Volver a consultar el SIUBEN** again: SIUBEN refuses, the portal shows *El ciudadano revocó esta autorización*, marks it **Revocada**, and keeps only the copy already received.

Optional: at step 3 click **Rechazar**. She is returned to MIVHED with a message and the form stays empty.

## How this maps to slide 11

- Steps 1–2: Citizen signs in to Cuenta Única (simulated sign-in page).
- Steps 3–4: PDPP authorisation server shows the request and records the grant.
- Step 5: The recipient (MIVHED) calls the resource server with a token tied to the grant; only the granted fields come back.
- Step 6: The citizen revokes the grant; the recipient's next read is refused.

Not shown: the X-Road hop between MIVHED and SIUBEN. Here the resource server answers directly.

## Known limits

- The requester cannot set an end date; continuous access lasts until revoked. `ACCESS_MODE=single_use` on the portal switches to a single read (expires 24 hours after approval).
- The grant page used for revocation is the operator console: the revoke section is in Spanish, the rest in English.
- The same fictitious citizen is shared by everyone using the demo, so anyone with the password sees everyone's grants.

## Verify before presenting

```bash
PORTAL_URL=https://mived-demo-rd.fly.dev OWNER_PASSWORD=… SHOTS_DIR=/tmp/demo-shots \
  node scripts/demo-dr/mived-e2e.mjs
```

The AI-assistant (MCP) path still works as a backup; see README.md.
