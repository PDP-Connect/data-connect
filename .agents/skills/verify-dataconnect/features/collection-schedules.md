# Set/change/pause/resume a schedule

## Sub-features

This feature is the complete user flow below. The source map's steps, branches, exact visible copy, product forms, and repo-relative code references are retained here.

## How to get to it (user POV)

### 7. Set/change/pause/resume a schedule

**Who starts:** Person; timer starts subsequent runs. **Where:** `/schedules`; source detail has a schedule section/links. **Both forms.** No outside account. V — `apps/console/src/app/(console)/schedules/page.tsx:28-83`; `apps/console/src/app/(console)/schedules/schedule-row.tsx:250-399`.

1. Page header “Schedules”; description “Set automatic refresh cadences for your connectors. Keep high-friction ones (banks, browser-based) manual or infrequent.” It has scheduled and unscheduled sections. Unscheduled description says “These connectors run only when you ask. Use 'Set schedule' to add a cadence, or sync manually from the Records page.” V — `apps/console/src/app/(console)/schedules/page.tsx:46-83`.
2. Row shows mode, automation, “Every: [interval]”, recommended mode/interval, “Last success”, “Last attempt”, total records, “needs human input”, and active run link “running →”. High-friction warning: “This connector typically requires an OTP or manual login. Frequent automatic runs will keep prompting for it.” Or manual browser warning / credentials warning. V — `apps/console/src/app/(console)/schedules/schedule-row.tsx:280-366,420-433`.
3. “Set schedule” opens inline form with “Every” (placeholder “e.g. 30m”), “Jitter (optional)” (“e.g. 5m”), “Save”, “Cancel”; recommended interval may appear. V — `apps/console/src/app/(console)/schedules/schedule-row.tsx:319-322,436-501`.
4. Existing schedule has “Pause” or “Resume”, “Edit schedule”, “Delete”. Changes call connection-scoped schedule endpoints when connection id exists, otherwise connector-level endpoints; page revalidates. V — `apps/console/src/app/(console)/schedules/schedule-row.tsx:293-322`; `apps/console/src/app/(console)/schedules/actions.ts:20-79`; API client in `apps/console/src/app/(console)/lib/operator-runs.ts:1`.
5. Scheduler ineligibility can show “not runnable” and “Manual runs only. [reason] You can still sync this source by hand; pause or delete the schedule to match.” Minimum interval warnings are server-supplied. Local device collector is excluded from server schedules; its own host supervisor controls cadence. V — `apps/console/src/app/(console)/schedules/schedule-row.tsx:272-278,369-383`; `packages/local-collector/README.md:8-20`.

**Rough edges:** schedule is connector- or connection-scoped depending on server data; collector cadence is outside this UI; no exact next-run countdown is guaranteed on every row.

## Driving it with Playwright

**Journey status:** `partly`. **Journey file:** `collection-schedules`. **Combined isolated run:** `collection-schedules`: **pass**.

**What it verifies:** The capture reaches the schedule overview with a seeded source.

**Reaches:** The signed-in `/schedules` page renders with its “Schedules” heading at both viewports.

**Stops at:** It does not create, edit, pause, resume, or delete a schedule.

**Run one journey:**

```sh
TEST_SANDBOX_REQUIRE=1 scripts/test-sandbox/test-sandbox --net none --pidns --scratch "$VERIFY_DIR/sandbox-scratch" -- node e2e/harness.mjs capture.spec.ts --output "$VERIFY_DIR/playwright-output" --grep "journey: collection-schedules"
```

**Evidence:** `evidence/collection-schedules/<run-id>/` contains desktop and phone screenshots plus visible text.

## Gotchas

A route capture does not prove schedule mutations or timer execution. The local collector owns its own cadence.
