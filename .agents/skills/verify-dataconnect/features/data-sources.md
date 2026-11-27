# Understand what happened and whether a source is current

## Sub-features

This feature is the complete user flow below. The source map's steps, branches, exact visible copy, product forms, and repo-relative code references are retained here.

## How to get to it (user POV)

### 6. Understand what happened and whether a source is current

**Who starts:** Person. **Where:** `/syncs`, `/syncs/<runId>`, source details, stream routes, and Overview. **Both forms.**

1. `/syncs` is a newest-first run feed with outcome/source filters and one run per row; stream rows and recent histories are projected into source groups. Rows use outcome language, including succeeded, partial/succeeded-with-gaps, failed, cancelled, in progress. No timeline is embedded in list. V — `apps/console/src/app/(console)/syncs/page.tsx:4-27,68-117`; `apps/console/src/app/(console)/syncs/syncs-model.ts:1`; `apps/console/src/app/(console)/syncs/syncs-view.tsx:1`.
2. `/syncs/<runId>` has run status, a timeline, latest progress, record stats, errors, rejected-record receipts, skipped streams, connector stderr tail and diagnostic lines when present. It loads one page of events; “Load more” retrieves older pages. It can show “Latest progress”, “Interactions”, “Rejected records”, “Connector diagnostics” and technical IDs/commands; this is more engineer-oriented than the source’s health summary. V — `apps/console/src/app/(console)/syncs/[runId]/page.tsx:99-223,269-292`; `TimelineDetailView` from `@pdpp/operator-ui`.
3. Live assistance appears above timeline: title, description, message, state, kind, attachments, timeout. Run can be cancelled while active. A browser-required assistance has “Open the streaming companion →”. V — `apps/console/src/app/(console)/syncs/[runId]/page.tsx:194-223,296-377`.
4. Source detail has “Diagnostics”, “Current state”, “Collection rate”, “Schedule”, “Devices”; “More detail”, “Expand” / “Collapse”. Health section shows “Health: [badge]”, a reason code, “Next run: [disposition] (needs you)” when applicable, “What's happening: [condition]”, axis chips, and if evidence is stale/unreliable: “Can't fully verify current state: [reasons].” Missing snapshot: “Projection unavailable.” and fallback badge “unknown” with title “Status unavailable.” V — `apps/console/src/app/(console)/sources/[connector]/connection-diagnostics.tsx:147-189,528-629`.
5. Stream detail shows latest stream-level collection facts (“Latest stream run”, counts, coverage and skip/reason facts); stream health route provides history/coverage evidence. Source list also exposes last run, total records, schedule and freshness-fused status. Overview “Source attention” lists source-specific next actions and “Review in Syncs →”; if no rows: “All assessed sources are healthy.” or “No source rows need review here. Source health is still being checked.” V — `apps/console/src/app/(console)/sources/[connector]/[stream]/page.tsx:641-692`; `apps/console/src/app/(console)/sources/sources-view-model.ts:681-728`; `apps/console/src/app/(console)/components/views/standing-overview.tsx:222-275`.
6. To tell whether it is up to date, user must inspect the source’s verdict and freshness wording (“last updated”/freshness annotation on list, run success, coverage as-of, next-run status and stream counts). There is no universal affirmative “up to date” guarantee; missing or stale evidence can read “unknown”, “Not measured”, “Projection unavailable”, or “Can't fully verify current state”. Server owns verdict label and forward statement. V — `reference-implementation/runtime/rendered-verdict.ts:3134,3181-3217`; `reference-implementation/vendor/display/src/source/source-status.ts:245-323`; source/detail consumers above.

**Rough edges:** (1) raw run timeline/debug terms require engineering knowledge; (2) timeline pagination means a visible page may omit earlier events; (3) there are several health surfaces and their status vocabulary is not identical (see table); (4) “healthy” is not always the same as verified fresh/current; (5) current health depends on server verdict and missing measurements are explicit but not self-resolving.

## Driving it with Playwright

**Journey status:** `partly`. **Journey file:** `sources-list-and-detail`, `source-health-and-freshness`. **Combined isolated run:** `sources-list-and-detail`: **pass**, `source-health-and-freshness`: **pass**.

**What it verifies:** The list/detail journey seeds Spotify, GitHub, and Reddit and opens the source’s own `/sources/cin_…` page. The health journey sees the seeded run feed.

**Reaches:** The source journey opens the list and full Spotify detail page; the health journey opens the Syncs list.

**Stops at:** The fixtures do not create healthy, stale, failed, owner-attention, or in-progress source evidence. Seeded coverage and freshness remain “not measured”.

**Run one journey:**

```sh
TEST_SANDBOX_REQUIRE=1 scripts/test-sandbox/test-sandbox --net none --pidns --scratch "$VERIFY_DIR/sandbox-scratch" -- node e2e/harness.mjs capture.spec.ts --output "$VERIFY_DIR/playwright-output" --grep "journey: sources-list-and-detail"
```

**Evidence:** `evidence/sources-list-and-detail/<run-id>/`, `evidence/source-health-and-freshness/<run-id>/` contains desktop and phone screenshots plus visible text.

## Gotchas

A successful seed run does not prove a source is healthy or current. The seeded connector emits no collection coverage receipt.
