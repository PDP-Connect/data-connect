# Audit: what apps read and when

## Sub-features

This feature is the complete user flow below. The source map's steps, branches, exact visible copy, product forms, and repo-relative code references are retained here.

## How to get to it (user POV)

### 10. Audit: what apps read and when

**Who starts:** Person, or product after an app read/write creates trace events. **Where:** `/audit` via sidebar `Audit`, Overview `audit log →`, or linked trace. **Code:** `apps/console/src/app/(console)/audit/page.tsx:1`; `apps/console/src/app/(console)/audit/[traceId]/page.tsx:128-215,264-499`; Overview `apps/console/src/app/(console)/components/views/standing-overview.tsx:185-213` (V).

1. Audit list loads recent trace summaries and shows each trace as a human-readable who/what/outcome row, with status filters and pagination/peek. Recent reads and mutations emit trace events. **V** `apps/console/src/app/(console)/audit/page.tsx:1` comments and rendering; trace mapping modules in `apps/console/src/app/(console)/audit/trace-kind-label.ts:1`, `apps/console/src/app/(console)/audit/trace-timeline-status.ts:1`.
2. Opening a trace shows trace ID, actor, status, related grant and run links, `events`, `page`, optional grant/run counts, and `truncated yes`. Timeline columns are `#`, `event · actor`, `status`, `occurred at`, and `data`. **V** `apps/console/src/app/(console)/audit/[traceId]/page.tsx:327-380,429-455`.
3. Each event can expand `data` JSON; known secret keys (`access_token`, `refresh_token`, `device_code`, `user_code`, etc.) are rendered as `<redacted>`. Five or more adjacent `run.progress_reported` events group as a collapsible progress row; the row shows report count, message, first/last time, and `N individual reports`. **V** `apps/console/src/app/(console)/audit/[traceId]/page.tsx:70-90,139-164,170-260`.
4. Person can follow related grant and sync links; `load more timeline events →` reads later pages. Page includes CLI `pdpp ref trace show <traceId>`, `@pdpp/cli` note, and raw server trace URL. **V** `apps/console/src/app/(console)/audit/[traceId]/page.tsx:383-499`.
5. A non-engineer can learn which actor/client caused a read, when it happened, status, related grant/run, and redacted event details. The page uses protocol event names (for example `record.read`) and identifiers; understanding raw `data` JSON may require technical help. **V** trace detail code.

**Failures:** Missing trace goes to not-found. Unreachable server shows “Reference server unreachable”; empty page says “No events on this page.” Truncated timeline exposes load-more. **V** `apps/console/src/app/(console)/audit/[traceId]/page.tsx:101-126,276-292,438-469`.

**Rough edges:** Overview only shows a recent grouped preview, not the complete log. Event type and raw IDs are technical. Some event payload is redacted, so the person cannot inspect secret values (intentionally). **V** cited files.

## Driving it with Playwright

**Journey status:** `partly`. **Journey file:** `audit-history`. **Combined isolated run:** `audit-history`: **pass**.

**What it verifies:** The capture proves that the audit list route loads.

**Reaches:** The signed-in `/audit` page renders with its “Audit” heading at both viewports.

**Stops at:** The fresh server has no app read activity, so it does not prove an app-read trace or trace detail.

**Run one journey:**

```sh
TEST_SANDBOX_REQUIRE=1 scripts/test-sandbox/test-sandbox --net none --pidns --scratch "$VERIFY_DIR/sandbox-scratch" -- node e2e/harness.mjs capture.spec.ts --output "$VERIFY_DIR/playwright-output" --grep "journey: audit-history"
```

**Evidence:** `evidence/audit-history/<run-id>/` contains desktop and phone screenshots plus visible text.

## Gotchas

The empty audit list is a valid page result. It is not evidence that an app read was recorded.
