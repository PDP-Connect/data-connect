# Other reachable source flows

## Sub-features

This feature is the complete user flow below. The source map's steps, branches, exact visible copy, product forms, and repo-relative code references are retained here.

## How to get to it (user POV)

### 12. Other reachable source flows

**Who starts:** Person. **Where:** source detail stream links, “Open in Explore”, “Health”, `Sources` list panel. **Both forms.**

1. Source detail → stream row shows stream collection facts and link to records; stream page says “Every saved record in this stream, paginated, plus the latest stream-level collection fact the runtime reported.” User can open stream health at `/sources/<source>/<stream>/health`; unavailable/missing stream reads explicit unavailable state rather than invented coverage. V — `apps/console/src/app/(console)/sources/[connector]/[stream]/page.tsx:641-692`; `apps/console/src/app/(console)/sources/[connector]/[stream]/health/page.tsx:1`.
2. Explore is linked from source/add/setup result and filters to connection; user sees/searches collected records. Source setup result also offers “Open in Explore”. V — `apps/console/src/app/(console)/components/source-setup-catalog.tsx:213-216,255-260`; `apps/console/src/app/(console)/connect/status/[connectionId]/page.tsx:772-779`.
3. Source list is one row per connection, grouping/collapsing revoked sources. Clicking row opens a side panel/passport with status, `config`, `auth`, `schedule`, `last run`, `records`, `added`; per-connection actions include sync/revoke/reactivate. Revoke retains records; group counts are by connector type, while source rows remain per account. V — `apps/console/src/app/(console)/sources/sources-view.tsx:143-205,530-575`; `apps/console/src/app/(console)/lib/source-groups.ts:4-17,82-105`.
4. Direct `?peek=<runId>` on `/syncs` redirects to the run detail. It is not a second flow. V — `apps/console/src/app/(console)/syncs/page.tsx:123-127`.

**Rough edges:** some source detail, run, device and stream routes are reachable only through deep links/required-action events; stream health facts describe only what runtime reports; list has one entry per account while Overview aggregates connector types.

## Driving it with Playwright

**Journey status:** `partly`. **Journey file:** `stream-records`, `live-browser`, `sources-list-and-detail`. **Combined isolated run:** `stream-records`: **pass**, `live-browser`: **pass**, `sources-list-and-detail`: **pass**.

**What it verifies:** Each route uses real identifiers from the seeded Spotify connection and run.

**Reaches:** The journey opens a seeded Spotify stream, the run companion route, and the source detail page.

**Stops at:** The routes do not demonstrate active browser assistance, stream health changes, or every relationship link.

**Run one journey:**

```sh
TEST_SANDBOX_REQUIRE=1 scripts/test-sandbox/test-sandbox --net none --pidns --scratch "$VERIFY_DIR/sandbox-scratch" -- node e2e/harness.mjs capture.spec.ts --output "$VERIFY_DIR/playwright-output" --grep "journey: stream-records"
```

**Evidence:** `evidence/stream-records/<run-id>/`, `evidence/live-browser/<run-id>/`, `evidence/sources-list-and-detail/<run-id>/` contains desktop and phone screenshots plus visible text.

## Gotchas

A completed run’s stream page is not a live browser session.
