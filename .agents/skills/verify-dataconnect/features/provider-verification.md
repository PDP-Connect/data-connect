# Answer provider verification (including OTP)

## Sub-features

This feature is the complete user flow below. The source map's steps, branches, exact visible copy, product forms, and repo-relative code references are retained here.

## How to get to it (user POV)

### 2. Answer provider verification (including OTP)

**Who starts:** An outside provider triggers an interaction while a sync runs. **Where:** `/syncs/<runId>`; source detail may show a required-action link to `/syncs/<runId>/stream`. The server can send best-effort ntfy and Web Push notifications; Web Push is configured per browser/installed app. The OTP itself comes from the provider. **Both forms.** Outside provider account/phone/email/authenticator is required depending on provider. V — `apps/console/src/app/(console)/syncs/[runId]/page.tsx:296-377`; `apps/console/src/app/(console)/notifications/page.tsx:45-69`; `reference-implementation/runtime/controller.ts:1888-1945,2088-2105`.

1. Runtime records a `run.interaction_required` or assistance event with kind, message, fields/schema, timeout and response contract. The console reads timeline events plus run status. The provider text is usually server/connector supplied; fallback is “Waiting for the requested run assistance.” Legacy fallback: “Awaiting operator response.” V — `apps/console/src/app/(console)/lib/run-assistance.ts:231-263,319-374`; `apps/console/src/app/(console)/syncs/[runId]/page.tsx:99-128`.
2. A new pending interaction triggers two independent best-effort channels: ntfy (if the connector runtime and ntfy configuration are available) and Web Push (if this browser/app is enrolled). ntfy title is exactly `PDPP [connector display name]: [kind] needed`; body is the provider-supplied interaction message. For `credentials`/`otp`, it uses a key tag, high priority, and click URL `/syncs/<runId>`; manual action opens `/syncs/<runId>/stream?interaction_id=<id>`. Ntfy failure is swallowed and does not stop the interaction. Web Push is described as “Only owner-action alerts”, “Headline only”, and “Per device”; payloads route back to the owner-authenticated console. `NTFY_TOPIC` can be supplied in deployment config. Provider, not DataConnect, sends the code. V — `reference-implementation/runtime/controller.ts:1887-1945,2088-2105`; `docker-compose.yml:153`; `apps/console/src/app/(console)/notifications/page.tsx:55-69`; `reference-implementation/runtime/attention-writer.ts:128-159`.
3. On run detail, an assistance callout renders a title and description based on event posture. It displays “message”, “state”, “kind”, optional “attachments”, optional “timeout”. Timeout is displayed only if the event provides positive `timeout_seconds` (for example “45s”, “2m”, “2m 15s”); there is no UI countdown. For value-entry interactions, a form shows connector-provided field labels/required flags. For OTP with no field schema the field label is “Code”; submit label is “Submit code”. An explicit note says “These values are used only for this run and are not saved as connection credentials.” V — `apps/console/src/app/(console)/syncs/[runId]/page.tsx:342-375`; `apps/console/src/app/(console)/syncs/[runId]/interaction-form.tsx:58-70,72-118`.
4. Person enters code/details, clicks “Submit code” (other kind: “Submit credentials”), or “Cancel interaction”. While submitting: “Submitting…”. DataConnect sends values as the current interaction response; server-side action says values are not stored in dashboard cookies, logs or localStorage. Errors appear inline from the server response. For a bad OTP the Console does not locally validate the code; it submits it, then the connector/provider decides whether to accept, fail, or request another step. V — `apps/console/src/app/(console)/syncs/[runId]/interaction-form.tsx:30-45,103-118`; `apps/console/src/app/(console)/syncs/[runId]/actions.ts:24-69`; I — wrong-code provider outcome.
5. The time limit is the event’s displayed timeout, not a Console-added default. On expiry, the interaction times out in runtime; event/run status then refreshes. No separate “late code” wording or resend action is guaranteed by the form. `Cancel interaction` sends `status=cancelled`. If timeout is absent, the user sees no limit. V — `apps/console/src/app/(console)/lib/run-assistance.ts:364-374`; runtime timeout handler `reference-implementation/runtime/controller.ts:579-585,762-768`; I — exact terminal text depends on connector event. A subsequent interaction can be shown if provider asks again.

If the code is entered in the remote browser instead of the run-detail form, the streaming companion provides “Submit code” and “I entered it in the browser” (the latter acknowledges that the step is complete without submitting a code field). It also has an OTP-only validation message: `Enter the code, or use "I entered it in the browser" after completing 2FA there.` V — `apps/console/src/app/(console)/syncs/[runId]/stream/stream-viewer.tsx:5779-5786,5792-5796,5864-5867`.

**Other provider steps:** Web push and run assistance are generic; actual data sources may ask for OTP, credentials, manual browser action, or provider-side approval. A provider-side approval with `ownerAction=act_elsewhere` and no response contract shows “Waiting for approval outside this dashboard”, “Approve the request with the provider.” plus provider message, and “The run will continue automatically after the provider confirms your approval. No browser controls are waiting here.” The app does not provide a separate in-app choose-account/security-question/captcha taxonomy; these appear only as connector/provider text in browser or interaction fields. V — `apps/console/src/app/(console)/syncs/[runId]/page.tsx:381-405`; `apps/console/src/app/(console)/syncs/[runId]/stream/page.tsx:384-405`.

**Rough edges:** (1) the run form’s “kind” is raw (`otp`, `credentials`, etc.); (2) no countdown even when timeout is shown; (3) Web Push requires separate per-device setup, while ntfy is best-effort and requires server-side configuration; (4) invalid/late code wording and retries are provider/runtime-specific, not a uniform Console contract.

## Driving it with Playwright

**Journey status:** `partly`. **Journey file:** `provider-verification`. **Combined isolated run:** `provider-verification`: **pass**.

**What it verifies:** The capture opens a completed run using the seeded run identifier.

**Reaches:** The seeded run detail shows “SUCCEEDED” and “View records in Explore”.

**Stops at:** No provider interaction, OTP, pending prompt, or live account is created.

**Run one journey:**

```sh
TEST_SANDBOX_REQUIRE=1 scripts/test-sandbox/test-sandbox --net none --pidns --scratch "$VERIFY_DIR/sandbox-scratch" -- node e2e/harness.mjs capture.spec.ts --output "$VERIFY_DIR/playwright-output" --grep "journey: provider-verification"
```

**Evidence:** `evidence/provider-verification/<run-id>/` contains desktop and phone screenshots plus visible text.

## Gotchas

The journey proves a completed-run screen only. Existing server tests cover deterministic interaction fixtures.
