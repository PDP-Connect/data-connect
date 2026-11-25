# Local collector and device exporters

## Sub-features

This feature is the complete user flow below. The source map's steps, branches, exact visible copy, product forms, and repo-relative code references are retained here.

## How to get to it (user POV)

### 11. Local collector and device exporters

**Who starts:** Person enrolls; local host/device collector runs and sends data. **Where:** `/device-exporters` or local collector’s Add source action. **Both forms;** requires terminal on device with data and a reachable reference server. Certain sources also need a physical Mac, Full Disk Access, export file, or external utility/QR pairing. V — `apps/console/src/app/(console)/device-exporters/page.tsx:108-147`; `apps/console/src/app/(console)/device-exporters/enrollment-form.tsx:66-180`; `packages/local-collector/docs/local-collector.md:8-30`.

1. Page “Local device exporters” description: “Connect a supported local collector to send data from the machine where it is stored. The collector controls when it runs; this server manages enrollment, data receipt, and connection health.” Section “Enrolled devices”; empty state “No local device exporters enrolled” and “Create an enrollment code and run the local collector on the device that has the data. This list updates after the device sends its first heartbeat.” V — `apps/console/src/app/(console)/device-exporters/page.tsx:108-141`.
2. “Create enrollment code” form fields: connector id (placeholder `claude-code`), local binding name (`personal-laptop`), display name (`the owner's laptop`). Submit generates a short-lived code, displays “Enrollment code”, “Expires at [timestamp]”; exact validity comes from code response. V — `apps/console/src/app/(console)/device-exporters/enrollment-form.tsx:66-97`.
3. Instructions: “1. Enroll the device that has the data”; “Run this @pdpp/local-collector command on the device with the data.” Person copies/runs command in terminal; it returns `device_id`, `device_token`, `source_instance_id`. Then “2. Start collection” and command requires these values. Local supervisor (launchd, systemd, cron, etc.) controls future runs, retries, resource limits. Server does not launch arbitrary host processes or set this cadence. V — `apps/console/src/app/(console)/device-exporters/enrollment-form.tsx:149-180`; `packages/local-collector/README.md:8-25`.
4. Special device source instructions can make enrollment nontrivial: Apple Photos requires a physical Mac and manual “File → Export → Export Unmodified Originals” to the configured import directory or `APPLE_PHOTOS_EXPORT_DIR`; iMessage needs the local Messages database and Full Disk Access; Google Messages requires `gmcli`, `GMCLI_BIN`, and prior interactive `gmcli auth` QR pairing with Android. V — `apps/console/src/app/(console)/device-exporters/enrollment-form.tsx:101-145`; collector implementation `packages/polyfill-connectors/connectors/google-messages/index.ts:1`.
5. Page reports device status plus heartbeat (“created”, “heartbeat”, “last ingest”), agent version, source count, queued/accepted/rejected counts, last error. Empty/unavailable counts are represented as unknown rather than fabricated zero. Error formatting can show `none`, exact error message/code, or “error reported”. Revoked/stale/never-heartbeat devices can show “Re-enroll”. V — `apps/console/src/app/(console)/device-exporters/page.tsx:199-300`; `apps/console/src/app/(console)/device-exporters/render.ts:25-99`.
6. “Revoke”/re-enroll flow; active devices can be revoked. Stale/revoked device with an eligible source offers a new enrollment; token/code belongs to that device. Detail diagnostics show “Uploading from the local host”, pending/accepted counts and recovery guidance (e.g. run collector on named host). A device’s failures also appear at `/sources/<connectionId>` → “Devices” / diagnostics; local collector must be restarted/repaired on its own host. V — `apps/console/src/app/(console)/device-exporters/page.tsx:279-319`; `apps/console/src/app/(console)/sources/[connector]/connection-diagnostics.tsx:217-254`.
7. Collector can be checked by local CLI: `pdpp-local-collector status`, `doctor`, `advertise`; these are terminal workflows, not dashboard buttons. Its runtime maintains a durable local outbox and sends data to server. V — `packages/local-collector/README.md:27-30,61-95,156-170`; `packages/collector-runtime/src/local-device-outbox.ts:1`.

**Rough edges:** (1) enrollment generates terminal commands and expects user to copy device secrets; (2) device—not server—owns schedule, so dashboard “Schedules” cannot configure it; (3) first heartbeat is needed before it appears; (4) several exporters require platform/OS permissions and CLI setup; (5) “local device exporter” is internal jargon; (6) local collector health can require troubleshooting on a different machine.

## Driving it with Playwright

**Journey status:** `partly`. **Journey file:** `device-exporters`. **Combined isolated run:** `device-exporters`: **pass**.

**What it verifies:** The capture reaches the signed-in enrollment/list surface.

**Reaches:** The `/device-exporters` page renders with “Local device exporters”.

**Stops at:** No separate collector host, device key, or public callback is started in the sandbox.

**Run one journey:**

```sh
TEST_SANDBOX_REQUIRE=1 scripts/test-sandbox/test-sandbox --net none --pidns --scratch "$VERIFY_DIR/sandbox-scratch" -- node e2e/harness.mjs capture.spec.ts --output "$VERIFY_DIR/playwright-output" --grep "journey: device-exporters"
```

**Evidence:** `evidence/device-exporters/<run-id>/` contains desktop and phone screenshots plus visible text.

## Gotchas

The page is available, but the collector must run on the machine that has the local data.
