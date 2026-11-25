# Start later collection

## Sub-features

This feature is the complete user flow below. The source map's steps, branches, exact visible copy, product forms, and repo-relative code references are retained here.

## How to get to it (user POV)

### 5. Start later collection

**Who starts:** Person or scheduler. **Where:** `/sources/<connectionId>` has “Sync now” or “Retry sync”; schedules run in the background. **Both forms.** V — `apps/console/src/app/(console)/sources/[connector]/page.tsx:780-820`; `apps/console/src/app/(console)/sources/[connector]/sync-now-button.tsx:65-75`; schedule runner is server-side.

1. Source detail has one run action for that connection; local-device push sources do not get the remote “Sync now” action because the collector controls its own run time. Clicking posts `runConnectorNowAction(connectorId, connectionId, {force})`. No per-stream run button or stream parameter appears in the source UI/action; one stream cannot be started by a person from these pages. V — `apps/console/src/app/(console)/sources/[connector]/sync-now-button.tsx:120-181`; `apps/console/src/app/(console)/sources/[connector]/actions.ts:53-80`; `apps/console/src/app/(console)/sources/[connector]/page.tsx:791`.
2. Button changes to “Starting…” then “Syncing…” while busy. On accepted request, “Sync started.” and optionally “View sync →”. When another run exists: “A sync is already in progress.” and optionally “View sync →”. Toast expires after 15 seconds; while running, detail page refreshes every 3 seconds. V — `apps/console/src/app/(console)/sources/[connector]/sync-now-button.tsx:16-17,88-103,120-165`.
3. If connector absent, inline install prompt appears (or “Connector not installed” warning if install prompt already shown). A pre-server failure is marked warning, later failure error; text is server message prefixed by `syncStartFailureLead`. Page does not optimistically claim the new run is active until server confirms. V — `apps/console/src/app/(console)/sources/[connector]/sync-now-button.tsx:167-179`; `apps/console/src/app/(console)/lib/connection-evidence.ts:1`.
4. `/syncs` shows run history newest first; `?status=` and `?connector_id=` filters apply server-side; status values are “any outcome”, “succeeded”, “succeeded with gaps”, “failed”, “cancelled”, “in progress”. Cursor paging is available. V — `apps/console/src/app/(console)/syncs/page.tsx:68-117,141-198`.
5. If active run is cancelled from its detail page, a cancel control exists; user gets in-place action feedback and the timeline is refreshed. V — `apps/console/src/app/(console)/syncs/[runId]/cancel-run-control.tsx:1`; `apps/console/src/app/(console)/syncs/[runId]/actions.ts:72-110`.

**Rough edges:** (1) some statuses use “Sync”/“run”/“collection” interchangeably; (2) per-stream detail reports collection facts but has no single-stream run action; (3) manual runs and source schedules are managed on different pages.

## Driving it with Playwright

**Journey status:** `partly`. **Journey file:** `source-run-actions`. **Combined isolated run:** `source-run-actions`: **pass**.

**What it verifies:** The journey reaches the detail page and verifies the successful response copy.

**Reaches:** The seeded source detail page shows “Sync now for Spotify”; clicking it produces “Sync started.”

**Stops at:** It does not test the already-running, missing-package, failure, retry, or cancellation branches.

**Run one journey:**

```sh
TEST_SANDBOX_REQUIRE=1 scripts/test-sandbox/test-sandbox --net none --pidns --scratch "$VERIFY_DIR/sandbox-scratch" -- node e2e/harness.mjs capture.spec.ts --output "$VERIFY_DIR/playwright-output" --grep "journey: source-run-actions"
```

**Evidence:** `evidence/source-run-actions/<run-id>/` contains desktop and phone screenshots plus visible text.

## Gotchas

The run starts against the disposable server. The seeded source is discarded during harness cleanup.
