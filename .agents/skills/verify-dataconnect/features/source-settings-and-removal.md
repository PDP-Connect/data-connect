# Change settings/name, multiple accounts, revoke/delete

## Sub-features

This feature is the complete user flow below. The source map's steps, branches, exact visible copy, product forms, and repo-relative code references are retained here.

## How to get to it (user POV)

### 10. Change settings/name, multiple accounts, revoke/delete

**Who starts:** Person. **Where:** `/sources/<connectionId>` → Configuration, rename pencil, Danger zone. **Both forms.** No outside account except provider credential change. V — `apps/console/src/app/(console)/sources/[connector]/page.tsx:1`; local components and actions listed below.

1. Rename: pencil button has accessible name “Rename [displayName]” and title “Rename”. Field aria-label “Connection label”, placeholder “e.g. [type] · personal”; buttons “Save” / “Cancel”; while saving “Saving…”. Success toast `Renamed to "[name]"`; server errors appear in place. Empty/whitespace cannot save. V — `apps/console/src/app/(console)/sources/[connector]/rename-connection.tsx:39-140`.
2. Configuration section says “What this source collects, and how collection runs.” Editable manifest fields are grouped “What to collect”, “How it runs”, “Advanced”. Edits stage a review (“What changes”), ask “Why are you changing this?” with placeholder “e.g. Include the project launch period”; state can say “Awaiting your confirmation”, with “Confirm” action. History lists reason and revision; “Technical details” hides raw revision/config JSON. V — `apps/console/src/app/(console)/sources/[connector]/connection-configuration.tsx:119-…` (changes/review/history at `:577-729`).
3. Multiple accounts: Add source card lists existing accounts and supports separate add action. New static secret/browser setup creates a distinct connection; replacing credential/repair uses existing `connection_id`, preserving its records/schedule/history. V — `apps/console/src/app/(console)/components/source-setup-catalog.tsx:218-269`; `apps/console/src/app/(console)/connect/static-secret/[connectorId]/page.tsx:23-30,81-101`; `apps/console/src/app/(console)/connect/browser-session/[connectorId]/page.tsx:14-16`.
4. Danger zone explains actions affect only that connection; siblings and their browser sessions are untouched. “Reset and re-sync” clears cursor/checkpoints and starts full sync, keeping records, credentials and browser profile. Checkbox “Clear sync state and start a full sync for [id].” Button “Reset and re-sync”; result “Sync state cleared. Full sync started.” V — `apps/console/src/app/(console)/sources/[connector]/connection-danger-zone.tsx:47-131`.
5. “Revoke” stops future collection and signs out saved browser session; records, grants, audit history retained; to resume, reconnect. Checkbox “Stop future collection for [id]; keep its records.” Button “Revoke connection”. Revoking a source stops future provider collection, not the third-party permission or consumer app grant. V — `apps/console/src/app/(console)/sources/[connector]/connection-danger-zone.tsx:135-157`.
6. Delete permanently erases collected records, sync position, saved browser session and removes connection; cannot undo. Apps previously granted access stay authorized and retain copies already received. Person types exact connection id; button “Delete connection and erase its records”. If run active: “Cancel run and delete”; paragraph says existing records saved by active run are erased too. V — `apps/console/src/app/(console)/sources/[connector]/connection-danger-zone.tsx:159-203`.

**Rough edges:** raw connection id is required to delete; deleting does not revoke app grants or their copies; “Revoke” may sound like provider permission revocation although it is DataConnect’s source lifecycle action.

## Driving it with Playwright

**Journey status:** `partly`. **Journey file:** `sources-list-and-detail`, `pause-and-resume-source`. **Combined isolated run:** `sources-list-and-detail`: **pass**, `pause-and-resume-source`: **pass**.

**What it verifies:** The pause/resume journey exercises the reversible source-level pause action; the list journey opens the full detail page.

**Reaches:** The capture opens the Spotify detail page, pauses it, observes “This source is paused”, then resumes it and observes “Collection resumed”.

**Stops at:** It does not rename, stage configuration changes, reset, revoke, or delete the connection.

**Run one journey:**

```sh
TEST_SANDBOX_REQUIRE=1 scripts/test-sandbox/test-sandbox --net none --pidns --scratch "$VERIFY_DIR/sandbox-scratch" -- node e2e/harness.mjs capture.spec.ts --output "$VERIFY_DIR/playwright-output" --grep "journey: sources-list-and-detail"
```

**Evidence:** `evidence/sources-list-and-detail/<run-id>/`, `evidence/pause-and-resume-source/<run-id>/` contains desktop and phone screenshots plus visible text.

## Gotchas

The destructive actions need deliberate confirmation controls and are not included in this journey. Pause/resume restores the seed source before the harness exits.
