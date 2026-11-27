# First collection after adding a source

## Sub-features

This feature is the complete user flow below. The source map's steps, branches, exact visible copy, product forms, and repo-relative code references are retained here.

## How to get to it (user POV)

### 4. First collection after adding a source

**Who starts:** Person submitting auth/credential/import/browser setup; runtime/server starts the first sync. **Where:** setup redirects to `/connect/status/<connectionId>` (static secret can use `/connect/static-secret/<connectorId>/status/<connectionId>`). Page polls while pending. **Both forms.** How long depends on provider, export size and runtime; no universal duration is shown. V — `apps/console/src/app/(console)/connect/status/[connectionId]/page.tsx:22-32,708-799`; static setup path `apps/console/src/app/(console)/connect/static-secret/[connectorId]/status/[connectionId]/page.tsx:1`.

1. Credential source states: “First sync starting” / “The provider credential is captured and the first sync is queued. It will start automatically.” Then “First sync running” / “The provider credential is captured and the first sync is running. It will continue automatically.” Browser source states “Sign-in needed” / “Continue in the secure browser to finish signing in. The first sync starts after login.” Running says “If the browser is still showing a sign-in page, finish signing in there — this page can't confirm the login by itself.” V — `apps/console/src/app/(console)/connect/status/[connectionId]/page.tsx:193-309`.
2. Manual upload has “Import starting” / “The import file is captured and the import is queued. It will start automatically.”, “Import running” / “The import file is captured and the import is running. It will continue automatically.” and “Import progress” with phases “Captured”, “Parsed”, “Deduplicated”, “Committed”, “Indexed”, “Health projected”. Phase details state whether records/receipt facts are committed and indexed. V — `apps/console/src/app/(console)/connect/status/[connectionId]/page.tsx:139-190,574-654`.
3. Status results: success “Connection active” / “Records are available for this account.”; zero yield “No records collected” / “The first sync finished without saving records. Retry if you expected data.” Browser and import versions name the correct retry action. Verified empty says “First sync verified empty”; unverified no counts says “First sync incomplete”; zero not proven empty says “No records confirmed”. V — `apps/console/src/app/(console)/connect/status/[connectionId]/page.tsx:70-137`.
4. Failed setup shows “First sync failed” or “Import failed”, with server-supplied remediation (fallback “Start the first sync again.” / “Start the import again.”) and a callout with “Reason: [reason]”. Retry actions vary: “Re-enter credential and retry”, “Start browser setup again”, “Choose another file and retry”, “Review setup result”, “Review setup”. V — `apps/console/src/app/(console)/connect/status/[connectionId]/page.tsx:362-380,801-804`.
5. Active result offers “Open in Explore”, “Source details”; import also “Import another file”. A newly created browser source reaches the run detail/stream flow for login first. V — `apps/console/src/app/(console)/connect/status/[connectionId]/page.tsx:772-795`.

**Partial results / duration:** status page shows import receipt counts, formats, coverage windows, warnings and media coverage when supplied. Runs can be long and show partial/per-stream progress through `/syncs/<runId>`, but the setup-status page does not promise a duration or percentage. For manual import, indexing/health projection follows commit. V — `apps/console/src/app/(console)/connect/status/[connectionId]/page.tsx:389-485,621-654`.

**Rough edges:** (1) “active” means source records available, but first sync outcomes can be empty/unverified; (2) browser run existence means an attempt, not successful login; (3) generic setup status shows raw fields such as state/run metadata; (4) time estimate is absent.

## Driving it with Playwright

**Journey status:** `partly`. **Journey file:** `first-collection`. **Combined isolated run:** `first-collection`: **pass**.

**What it verifies:** The capture opens the result page for a connection created by the seed fixture after a successful real connector run.

**Reaches:** The seeded Spotify setup-status page says “Connection active” and “Records are available for this account.”

**Stops at:** It does not create a new provider connection or follow an actual sign-in, authorization, credential, or export flow.

**Run one journey:**

```sh
TEST_SANDBOX_REQUIRE=1 scripts/test-sandbox/test-sandbox --net none --pidns --scratch "$VERIFY_DIR/sandbox-scratch" -- node e2e/harness.mjs capture.spec.ts --output "$VERIFY_DIR/playwright-output" --grep "journey: first-collection"
```

**Evidence:** `evidence/first-collection/<run-id>/` contains desktop and phone screenshots plus visible text.

## Gotchas

The setup-result page is backed by seeded data. It does not prove a provider account was connected.
