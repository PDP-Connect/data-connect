# DR demo: the consent screen (slide 8)

Built to the working-session documents (28 September 2026): the facilitators' guide, the working-session deck (slides 8, 14, 19–23), the technical note and the scoping note. The story is María's, from the deck: Servicios Proactivos offers to arrange her baby's vaccinations and child benefit without an application, and asks, once, to look at her health record and her household file, for that purpose, until a date. She says yes, sees the grant, and can cancel it.

Every page carries a small "Entorno de demostración · datos ficticios" line with an **ES | EN** toggle beside it. The language carries across the whole flow. All people and records are fictitious; no logos or seals.

## URLs

| What | URL |
|---|---|
| Start here: Servicios Proactivos (simulated) | https://proactivos-demo-rd.fly.dev (`?lang=en` for English) |
| Mis autorizaciones (simulated Soy Yo RD view) | https://pdpp-demo-rd.fly.dev/owner/autorizaciones |

The password is shared separately. The cédula field is pre-filled (`000-1234567-8`, María) and is presentational.

## Before presenting (set-up, per the guide)

1. Reset the demo so only today's grant shows (see FLY.md, "Reset before presenting").
2. Run the flow once on the venue screen, on the room's network and on the phone hotspot.
3. Check the fallback recording opens (demo-es.mp4 / demo-en.mp4).

## Script: three to four minutes, slide 8's order

Say first: "The same login you run today, then one screen."

1. **The offer.** Servicios Proactivos: "Cuando nazca su bebé, podemos organizar sus vacunas y el bono por hijo… sin que tenga que solicitarlos." It says what it will need (health record from SNS, household file from SIUBEN) and until when. Click **Decir sí con Cuenta Única**.
2. **Sign in.** The Cuenta Única-style sign-in, as for any GOB.DO service. It names the service she's continuing to. Type the password.
3. **The one screen.** Read it aloud: *who is asking* (Servicios Proactivos), *for what purpose*, *from which institutions* (SNS, SIUBEN), *which fields*, *until when* ("Hasta el 31 de enero de 2027"). "Only what's on this screen is shared." Click **Autorizar**.
4. **The grant, in use.** Back at Servicios Proactivos: the due date from SNS and the household from SIUBEN arrived; nobody carried a paper. The authorization card shows the purpose and the end date.
5. **See it and cancel it.** Click **Ver o revocar en Mis autorizaciones**: what she allowed, until when, and what was read and when. Click **Revocar**.
6. Optional, one line: back on Servicios Proactivos, **Volver a consultar** is now refused; it keeps only the copy it already received.

Back to slide 8: "That screen is what the first implementation builds beside Cuenta Única."

## How it maps to slide 14

| Step | Here |
|---|---|
| 01–02 Sign in to Cuenta Única; it tells the authorisation server who this is | Simulated Cuenta Única sign-in (password stands in for the real login and cédula claim) |
| 03 The recipient asked for fields, purpose, window; the consent screen shows them | Servicios Proactivos sends the request; the one screen shows it |
| 04 Approve; the grant is recorded; the recipient gets a token | Autorizar; one approval, one grant per institution (the spec binds a grant to a single source) |
| 05–06 Recipient calls the service; resource server returns only granted fields | Reads of the SNS and SIUBEN records, only the requested fields |
| 07 Release logged | "What was read" in Mis autorizaciones |

Not shown: X-Road between the recipient and the institutions; the real Cuenta Única; Soy Yo RD itself (Mis autorizaciones is a simulated view of how it could look there, per the scoping note: no change to Soy Yo RD).

## Known limits

- One fictitious citizen is shared by everyone with the password. To start clean, press **Reiniciar demostración** at the bottom of Mis autorizaciones: it revokes and clears every authorization.
- The end date is declared by the requester. The spec's grant has `expires_at`, but its request has no field for it, so this is a reference extension.
- "What was read and when" in Mis autorizaciones is our implementation; the core spec defines no citizen-facing access log (§11–12).
- The citizen can untick any requested stream and optional field; the spec defines owner choice only for streams the client marks optional (§5). Schema-required fields stay locked, as the spec requires.

## Verify

```bash
LANG=es PORTAL_URL=https://proactivos-demo-rd.fly.dev OWNER_PASSWORD=… node scripts/demo-dr/proactivos-e2e.mjs
LANG=en PORTAL_URL=https://proactivos-demo-rd.fly.dev OWNER_PASSWORD=… node scripts/demo-dr/proactivos-e2e.mjs
```
