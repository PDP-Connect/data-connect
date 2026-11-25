# Home page

## Sub-features

This feature is the complete user flow below. The source map's steps, branches, exact visible copy, product forms, and repo-relative code references are retained here.

## How to get to it (user POV)

### 12. Home page

**Who starts:** Person opens `/` or the logo. **Code:** `apps/console/src/app/(console)/page.tsx:95-218,265-301`; `apps/console/src/app/(console)/components/views/standing-overview.tsx:24-49,51-299`; `apps/console/src/app/(console)/components/views/standing-view-model.ts:1` (V).

1. The hero is one dynamic block; a pending approval takes priority, then a fleet-health alert, stale totals, partial-load errors, and finally the calm state. For one pending request it says “A request is waiting on you”, “<app> wants to read <requested data>.”, and “No data is shared until you approve this request.” For multiple requests the kicker is “N requests are waiting”; the subtext adds “Review each request one at a time. N more after this one.” CTA: `Review the request` → `/grants`. Fleet alert: “Source fleet needs attention”; “One or more sources are not healthy.”; “Review source status to see the typed cause and the next available action.” CTA `Review sources` → `/sources`. Stale totals say `Totals update delayed` or `Totals updating`, `Records are still available.`, with “Dashboard totals are using the last completed update.” or “Dashboard totals may use the last completed update for a few minutes.” CTA `View status` → `/deployment`. Partial reads say “Overview is incomplete”, `N dashboard checks did not load.`, and “Refresh this page; if it keeps happening, check deployment. This page will not claim all-clear from partial data.” CTA `Check deployment` → `/deployment`. Calm says “Where you stand”, “N records from N sources — all yours to read.”, then varies with owner-token and live-grant counts. Development only supports seeded `?demo=calm|alarm|decide`; production blocks it. A seeded demo notice is “Seeded demo · <scenario> state · fictional data”. **V** `apps/console/src/app/(console)/components/views/standing-view-model.ts:1024-1149`; `apps/console/src/app/(console)/page.tsx:16-18,265-301`; `apps/console/src/app/(console)/components/views/standing-overview.tsx:24-48`.
2. “What can act as you” lists owner bearers, issuer/client IDs, “reads everything”, issue date and `Manage →`; it links to owner tokens. Empty copy: “No token can act as you. Nothing has full access — only your signed-in owner session reads everything here.” Note: “An owner token reads everything — every source, every field, exactly what you see. Keep the list short; revoke anytime.” **V** `apps/console/src/app/(console)/components/views/standing-overview.tsx:51-123`.
3. “Who can read parts of you” lists active grant/client relationships. Each row says `reads only <granted scope>` or `reads a scoped slice of your data`, and `last active <relative day> · N grant(s)`. Row links say `Review grant →` or `Review N grants →`. Header links are `<N> grant package(s) →` when any exist and `all grants →`; empty copy: “No grants are active. No connected app can read this instance yet.” There is no separate pending-approval block; a pending request changes the hero and its `Review the request` link. **V** `apps/console/src/app/(console)/components/views/standing-view-model.ts:628-657,669-688,1024-1037`; `apps/console/src/app/(console)/components/views/standing-overview.tsx:126-181`.
4. “What’s been read” is a preview of up to six recent traces, grouped when actor, result and relative day match. Rows say `<app> read N record(s).` or `<app> tried to read — turned away, <reason>.`, with relative time. Repeats change to `twice` or `N times`. Header link is `audit log →`; empty copy: “Nothing has been read yet. When an app reads a record, it shows up here.” **V** `apps/console/src/app/(console)/components/views/standing-view-model.ts:738-811`; `apps/console/src/app/(console)/components/views/standing-overview.tsx:185-213`.
5. “Source attention” shows a healthy-source count and grouped work. Group labels are `Needs you`, `Available actions`, `System or connector issue`, `PDPP is working`, `Not measured`, and `Status unavailable`, each with a count. Each row links to that source’s detail and shows a generated what/why sentence; the footer link is `Review in Syncs →`. With no rows, it says “All assessed sources are healthy.” when fleet health is healthy, otherwise “No source rows need review here. Source health is still being checked.” **V** `apps/console/src/app/(console)/lib/source-actionability.ts:128-153`; `apps/console/src/app/(console)/components/views/standing-view-model.ts:868-895,953-1019`; `apps/console/src/app/(console)/components/views/standing-overview.tsx:222-277`.
6. “Notifications” says one of: “At least one device is enrolled for alerts on source reconnects, syncs waiting on you, and other owner-action events.” / “No device is enrolled yet. Enable browser or installed-app alerts for source reconnects, syncs waiting on you, and other owner-action events.” / “Could not check whether any device is enrolled for alerts right now.” Its link says `manage →` when configured, otherwise `setup →`, and opens `/notifications`. **V** `apps/console/src/app/(console)/components/views/standing-overview.tsx:280-299`.

**Data sources and links:** Dataset summary (`/_ref`), up to 12 grants, up to 6 traces, pending approvals, owner-issued clients, one bounded connector-summary page/fleet verdict, grant-package count, and web-push subscriptions. These reads load concurrently; failures fall back independently. The dataset summary supplies calm-hero records/source totals; grant/client/package data supplies access and bearer blocks; traces supply “What’s been read”; connector summaries and fleet health supply source attention and health; web-push subscriptions supply notification setup state; pending approvals supply the decision hero. Source pagination may appear below the Overview. Outbound links include the logo `/`, hero CTA (state dependent), `/deployment`, `/notifications`, `/syncs`, `/deployment/tokens`, `/grants`, `/grants/packages`, `/audit`, and source-detail pages. **V** `apps/console/src/app/(console)/page.tsx:60-73,132-218,235-301`; `apps/console/src/app/(console)/components/views/standing-view-model.ts:1` and `apps/console/src/app/(console)/components/views/standing-overview.tsx:1` above.

**Rough edges:** The health “healthy/no action” number has the known subtraction defect described in Counts. Recent audit is a sample. Bearer rows say “reads everything” even though only owner-level REST APIs are intended and `/mcp` rejects them; destination page clarifies. **V** cited files.

## Driving it with Playwright

**Journey status:** `partly`. **Journey file:** `home-page`. **Combined isolated run:** `home-page`: **pass**.

**What it verifies:** The capture sees a real page with seeded source data and its current advisory state.

**Reaches:** The signed-in Overview route renders after the seed connector runs and displays “One or more sources are not healthy.”

**Stops at:** It does not exercise every card, navigation affordance, or health branch. The title’s CSS rendering uses uppercase lettering.

**Run one journey:**

```sh
TEST_SANDBOX_REQUIRE=1 scripts/test-sandbox/test-sandbox --net none --pidns --scratch "$VERIFY_DIR/sandbox-scratch" -- node e2e/harness.mjs capture.spec.ts --output "$VERIFY_DIR/playwright-output" --grep "journey: home-page"
```

**Evidence:** `evidence/home-page/<run-id>/` contains desktop and phone screenshots plus visible text.

## Gotchas

The seeded sources lack measured coverage and freshness, so the Overview reports attention. That is not a provider failure.
