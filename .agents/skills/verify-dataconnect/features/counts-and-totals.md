# Counts and totals

## Sub-features

This feature is the complete user flow below. The source map's steps, branches, exact visible copy, product forms, and repo-relative code references are retained here.

## How to get to it (user POV)

### 3. Counts and totals

**Who starts:** Page load or a person changing filters/pagination. **Where:** Overview `/`, `/sources`, `/explore`, `/sources/<connector>/<stream>`, `/audit`, `/grants`, `/syncs`, `/deployment`. **Code:** `apps/console/src/app/(console)/page.tsx:132-218`; `apps/console/src/app/(console)/components/views/standing-view-model.ts:842-851,1086-1096`; `apps/console/src/app/(console)/components/views/standing-overview.tsx:222-299`; `apps/console/src/app/(console)/sources/page.tsx:98-143`; stream table `apps/console/src/app/(console)/sources/[connector]/[stream]/page.tsx:73-121`; Explore totals `apps/console/src/app/(console)/explore/explore-canvas.tsx:1624-1667,1788-1819`; audit `apps/console/src/app/(console)/audit/page.tsx:1-120`; grants `apps/console/src/app/(console)/grants/page.tsx:187-240`; syncs `apps/console/src/app/(console)/syncs/page.tsx:1-120`; deployment `apps/console/src/app/(console)/deployment/page.tsx:104-158` (V).

1. Overview reads a dataset summary, connector summaries, fleet health, grants, pending approvals, recent traces, owner-issued clients, package count, and web-push subscriptions. These are separate APIs, fetched concurrently and fault-isolated. The Overview’s source count is derived from the complete connector-summary page or fleet health; if it has a continuation, the page offers pagination and does not claim a complete source count. **V** `apps/console/src/app/(console)/page.tsx:95-218`.
2. The Overview’s home blocks show credential counts/overflow, grant package count, recent trace rows, source-work group counts, and notification enrollment state. These measures have different sources. “What’s been read” is a recent trace preview, not the full audit total. **V** `apps/console/src/app/(console)/components/views/standing-overview.tsx:51-121,126-181,185-213,222-299`; `apps/console/src/app/(console)/page.tsx:135-177`.
3. Sources shows per-source record counts/stream summaries from connector summaries; the source detail and coverage/report views show their own server collection figures and run-derived facts. These can differ from Explore’s current loaded-window count because they describe source-held or collection-reported records, while Explore often counts only its reachable loaded page. **V** `apps/console/src/app/(console)/sources/page.tsx:98-143`; `apps/console/src/app/(console)/sources/[connector]/page.tsx:720-765`; `apps/console/src/app/(console)/lib/collection-report.ts:1-92`; `apps/console/src/app/(console)/explore/explore-canvas.tsx:1624-1667`.
4. A stream page shows `page N · X shown`, optionally a backend exact matching count, and optionally total held. Without an exact count it says more is available or identifies current filters; it does not claim an exact overall total. **V** `apps/console/src/app/(console)/sources/[connector]/[stream]/page.tsx:73-121`.
5. Explore uses exact totals only for exact-filter descriptors. Recent feed rows and source/stream facets use loaded-window counts explicitly labelled `in view`; future records can expose an exact upcoming total; date-chart totals come from server aggregation, not by counting loaded rows. **V** `reference-implementation/vendor/operator-ui/src/explore/set-descriptor.ts:110-174`; `apps/console/src/app/(console)/explore/explore-canvas.tsx:1624-1667,1788-1819,2545-2548,2661-2678`; `reference-implementation/vendor/operator-ui/src/explore/over-time-chart.ts:229-246`.
6. Audit trace detail distinguishes total `events` from `page` rows and flags `truncated`; Grants rows show per-grant `events`; grant detail shows timeline page/event counts; sync pages show run/record counts; Deployment displays data-size, records, blobs, and retained bytes from its dataset/size endpoints. These are event/run/storage counts, not one shared “number of records” measure. **V** `apps/console/src/app/(console)/audit/[traceId]/page.tsx:374-380,429-469`; `apps/console/src/app/(console)/grants/page.tsx:229-240`; `apps/console/src/app/(console)/grants/[grantId]/page.tsx:80-90`; `apps/console/src/app/(console)/deployment/page.tsx:104-158`.

**Do totals agree?** They agree only when the underlying scope and freshness agree. Source-held count, one stream’s exact total, current filtered Explore set, loaded Explore page, Overview’s assessed source count, audit event count, and retained byte/record count are distinct. The pages qualify several of these honestly. Two Overview issues remain on this branch: healthy sources are computed by subtraction from source count rather than positive health evidence, and an impossible `can't collect` label comparison misclassifies one source issue. BASECHECK confirms both. **V** `apps/console/src/app/(console)/components/views/standing-view-model.ts:842-851,1158-1162`; `apps/console/src/app/(console)/components/views/standing-overview.tsx:237-239`; BASECHECK §B.

**Rough edges:** Source summary counts can be seen beside exact stream totals and Explore loaded counts with no universal shared denominator. Overview’s “healthy and need no action” count may be wrong under the known subtraction defect. A separate dataset-summary endpoint can be rebuilt from `/deployment`, so summary freshness can diverge from other live reads. **V** cited files above.

## Driving it with Playwright

**Journey status:** `partly`. **Journey file:** `counts-and-totals`. **Combined isolated run:** `counts-and-totals`: **pass**.

**What it verifies:** The home capture runs after the seed connector has emitted 21 Spotify records.

**Reaches:** The seeded Overview page renders and says “One or more sources are not healthy.”

**Stops at:** The journey asserts the headline, not every total or count definition; the seed run has unmeasured coverage and freshness.

**Run one journey:**

```sh
TEST_SANDBOX_REQUIRE=1 scripts/test-sandbox/test-sandbox --net none --pidns --scratch "$VERIFY_DIR/sandbox-scratch" -- node e2e/harness.mjs capture.spec.ts --output "$VERIFY_DIR/playwright-output" --grep "journey: counts-and-totals"
```

**Evidence:** `evidence/counts-and-totals/<run-id>/` contains desktop and phone screenshots plus visible text.

## Gotchas

A record count does not establish complete collection. The seed source has records but no measured coverage or freshness.
