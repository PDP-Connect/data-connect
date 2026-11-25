# When a source needs the person (reauth, permission/site change, stale connector)

## Sub-features

This feature is the complete user flow below. The source map's steps, branches, exact visible copy, product forms, and repo-relative code references are retained here.

## How to get to it (user POV)

### 8. When a source needs the person (reauth, permission/site change, stale connector)

**Who starts:** Provider, connector/runtime or person opening Sources. **Where:** source list/detail, Overview, Syncs run detail, and Add source for package updates. **Both forms.** Usually provider account required for login/consent. V — source status model, actionability projection and detail routes.

1. Sources list status reflects lifecycle first (archived, setup never completed, revoked, paused, syncing, setup in progress) and then server verdict/freshness. The server’s pill label/forward statement and action are consumed; Console does not infer exact provider cause from raw signals. List next-action text can link into detail. V — `reference-implementation/vendor/display/src/source/source-status.ts:245-323`; `apps/console/src/app/(console)/lib/source-actionability.ts:462-542`; `apps/console/src/app/(console)/sources/sources-view.tsx:617-640`.
2. For auth/OTP/manual intervention during a run, source detail surfaces `required action` and links to that run’s stream; run detail gives the exact interaction and timeout, as in flow 2. If another company changed its site or connector fails, run timeline can include error, stderr, diagnostic lines and next action. There is no product-wide “site changed” screen; exact text comes from connector error/remediation. V — `apps/console/src/app/(console)/sources/[connector]/page.tsx:1230-1260`; `apps/console/src/app/(console)/syncs/[runId]/page.tsx:163-223`.
3. Credential reconnect entry uses `/connect/static-secret/<connectorId>?connection_id=...`; title “Reconnect [name]”, text says records, history and schedule stay attached to same connection. Secret is re-entered; non-secret fields may be retained in query parameters after validation failure, secret is not. V — `apps/console/src/app/(console)/connect/static-secret/[connectorId]/page.tsx:23-30,48-68,128-145`.
4. Browser reconnect entry uses `/connect/browser-session/<connectorId>?connectionId=...`; “Reconnect [name]”, “Log in to [name] in the secure browser to restore collection. Your existing records and history are preserved.” Steps say browser session stored and collection resumes after detected login. V — `apps/console/src/app/(console)/connect/browser-session/[connectorId]/page.tsx:14-21,177-190,254-300`.
5. Revoked source callout states “Future collection is stopped. Revoke signs out the saved browser session; already-collected records stay visible and searchable.” It offers “Reconnect”/Add source recovery only where route is supported. A package missing from server offers install prompt; stale package/version offers Update via Add source. V — `apps/console/src/app/(console)/sources/sources-view.tsx:559-564`; `apps/console/src/app/(console)/sources/[connector]/connector-install-prompt.tsx:1`; `apps/console/src/app/(console)/sources/add/connector-install-row.tsx:1`.
6. Permission withdrawn/provider authorization errors remain provider/server supplied. Revoke is a local owner action and does not itself revoke third-party provider authorization; Delete also does not revoke consumer app grants. No generic “provider permission revoked” repair dialog was found. I — based on state route/copy.

**Rough edges:** (1) provider-specific error words/remedies vary; (2) some required action summaries include raw kind/axis names; (3) a missing connector package is repaired in Add source rather than on the source detail; (4) provider permission and DataConnect’s “Revoke” mean different things; (5) stale site shape is visible only if connector/runtime reports it.

## Driving it with Playwright

**Journey status:** `partly`. **Journey file:** `source-health-and-freshness`, `source-run-actions`. **Combined isolated run:** `source-health-and-freshness`: **pass**, `source-run-actions`: **pass**.

**What it verifies:** The capture sees a seeded source and a successful manual-run request.

**Reaches:** The source health journey opens Syncs and the run-actions journey starts a seeded sync, showing “Sync started.”

**Stops at:** It does not produce expired credentials, provider permission loss, stale connector artifacts, or a “Sign in again” interaction.

**Run one journey:**

```sh
TEST_SANDBOX_REQUIRE=1 scripts/test-sandbox/test-sandbox --net none --pidns --scratch "$VERIFY_DIR/sandbox-scratch" -- node e2e/harness.mjs capture.spec.ts --output "$VERIFY_DIR/playwright-output" --grep "journey: source-health-and-freshness"
```

**Evidence:** `evidence/source-health-and-freshness/<run-id>/`, `evidence/source-run-actions/<run-id>/` contains desktop and phone screenshots plus visible text.

## Gotchas

A successful seed source cannot stand in for the owner-repair state. Use the deterministic interaction test as evidence for the model only.
