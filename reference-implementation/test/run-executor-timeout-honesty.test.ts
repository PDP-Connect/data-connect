// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// `run_timed_out` honesty oracle for `runTimedOutError` (runtime/scheduler/
// run-executor.ts).
//
// Bug: when the scheduler's wall-clock watchdog kills a run, `runTimedOutError`
// built a fresh error object carrying only classification fields
// (failure_reason/terminal_reason/message/run_id/trace_id) and silently
// dropped `records_emitted`, `known_gaps`, `reported_records_emitted`, and
// `checkpoint_summary` — even though `runConnector`'s own terminal result
// (`buildClosedRunResult` in runtime/index.ts) had already computed the real
// values from durable ingest accounting before resolving. Every timed-out run
// therefore reported `records_emitted: 0` / `known_gaps: []` regardless of how
// much work it durably committed before being killed. Reproduced against
// production: run_1787407222861 (Slack) durably wrote 402,494 messages +
// 91,202 reactions + 81,857 message_attachments + 19,936 files, and still
// recorded records_emitted: 0, known_gaps_json: [].
//
// This suite runs the real executor, a real child process, a real in-memory
// ingest server and the real kill path against a connector that durably emits
// records and then hangs forever (never sends DONE). The watchdog's timers are
// injected (`WatchdogTimers`), so each test fires the timeout at a chosen point
// rather than racing a wall-clock budget against process startup. What it
// proves: the timed-out result carries the durable counts and gaps. What it
// does not prove: that a real timer elapses. The production default timer path
// is covered only by the single real-timer test at the end of this file.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { projectRunAutomationPolicy } from "../runtime/run-automation-policy.ts";
import {
  createAttemptWatchdog,
  createRunExecutor,
  type RunExecutorDeps,
  type RunExecutorRuntimeState,
  type WatchdogTimers,
} from "../runtime/scheduler/run-executor.ts";
import type { ConnectorSchedule } from "../runtime/scheduler-domain-types.ts";
import { getDb } from "../server/db.ts";
import { startServer } from "../server/index.ts";
import { makeDefaultAccountConnectorInstanceId } from "../server/stores/connector-instance-store.ts";

interface DeviceAuthorization {
  device_code: string;
  user_code: string;
}

interface TokenResponse {
  access_token: string;
}

async function fetchJson<T = unknown>(url: string, opts: RequestInit = {}): Promise<{ status: number; body: T }> {
  const resp = await fetch(url, opts);
  const body = (await resp.json()) as T;
  return { body, status: resp.status };
}

// `runConnector`'s ingest POSTs (runtime/index.ts flushBatch) send a real
// `Authorization: Bearer <ownerToken>` header the RS validates — a fake
// string 401s, which the runtime folds into `permission_error` and the
// watchdog test would never reach `run_timed_out` at all. Mirrors
// collection-report-projection-e2e.test.ts's issueOwnerToken.
async function issueOwnerToken(asUrl: string, subjectId = "owner_local"): Promise<string> {
  const clientId = "pdpp_cli";
  const { body: device } = await fetchJson<DeviceAuthorization>(`${asUrl}/oauth/device_authorization`, {
    body: new URLSearchParams({ client_id: clientId }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  const approveResp = await fetch(`${asUrl}/device/approve`, {
    body: new URLSearchParams({ subject_id: subjectId, user_code: device.user_code }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  assert.equal(approveResp.status, 200);
  const { body: tokenBody } = await fetchJson<TokenResponse>(`${asUrl}/oauth/token`, {
    body: new URLSearchParams({
      client_id: clientId,
      device_code: device.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  return tokenBody.access_token;
}

type TestServer = Awaited<ReturnType<typeof startServer>> & {
  asServer: { close: (cb: (err?: Error) => void) => void; closeAllConnections: () => void };
  rsServer: { close: (cb: (err?: Error) => void) => void; closeAllConnections: () => void };
};

async function closeServer(server: TestServer) {
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  const closeWithTimeout = (srv: TestServer["asServer"]) =>
    new Promise<void>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        resolve();
      }, 2000);
      srv.close(() => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve();
      });
    });
  await Promise.allSettled([closeWithTimeout(server.asServer), closeWithTimeout(server.rsServer)]);
}

const CONNECTOR_ID = "timeout-honesty";
const OWNER_SUBJECT_ID = "owner_local";
// The RS requires a real, already-provisioned connector_instances row before
// ingest will accept records (connector_instance_not_found otherwise). The
// default-account id is the one path the store auto-provisions without a
// separate registration call — mirrors collection-report-projection-e2e.test.ts's
// fakeAdmitRunConnection, which relies on the same auto-provisioning.
const CONNECTOR_INSTANCE_ID = makeDefaultAccountConnectorInstanceId(OWNER_SUBJECT_ID, CONNECTOR_ID);

const MANIFEST = {
  connector_id: CONNECTOR_ID,
  display_name: "Timeout Honesty",
  manifest_uri: "https://sources.example/timeout-honesty",
  protocol_version: "0.1.0",
  streams: [
    {
      name: "items",
      primary_key: ["id"],
      schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
      selection: { fields: true, resources: true },
      semantics: "append_only",
    },
  ],
  version: "1.0.0",
};

const SCHEDULED_POLICY = projectRunAutomationPolicy({ refreshPolicy: null, triggerKind: "scheduled" });

// `maxRunWallClockMs` is a RESETTABLE no-progress allowance, not a total-run
// budget: `createAttemptWatchdog`'s `markProgress` re-arms the timer on every
// PROGRESS message (run-executor.ts `arm()`), and a `local_only_phase_started`
// boundary replaces it with a ceiling of four allowances.
//
// These tests do not race that allowance against the clock. Process startup,
// the START handshake and the ingest round-trip take a host-dependent time, so
// any real budget either flakes on a loaded host or makes the test slow. The
// watchdog's timers are injected (`WatchdogTimers`): the test waits for the
// event it cares about (records durably ingested, the phase boundary latched),
// asserts the delay the watchdog armed, and fires it explicitly. The value
// below only has to be recognisable as the armed delay.
const WALL_CLOCK_BUDGET_MS = 400;
const LOCAL_ONLY_CEILING_MS = WALL_CLOCK_BUDGET_MS * 4;
const CONNECTOR_SENT_MARKER = "connector-sent";
const CONNECTOR_RELEASE_MARKER = "connector-release";
const WAIT_FOR_TIMEOUT_MS = 30_000;

interface ManualWatchdogTimers {
  /** Delay of the single armed timer, or null when none is armed. */
  armedDelayMs: () => number | null;
  /** Runs the single armed timer's callback, as if its delay had elapsed. */
  fire: () => void;
  timers: WatchdogTimers;
}

function manualWatchdogTimers(): ManualWatchdogTimers {
  const armed = new Map<number, { callback: () => void; ms: number }>();
  let nextId = 0;
  return {
    armedDelayMs: () => {
      assert.ok(armed.size <= 1, `the watchdog arms at most one timer at a time, got ${armed.size}`);
      const [only] = [...armed.values()];
      return only ? only.ms : null;
    },
    fire: () => {
      assert.equal(armed.size, 1, "expected exactly one armed watchdog timer to fire");
      const [entry] = [...armed.entries()];
      assert.ok(entry, "expected an armed watchdog timer");
      const [id, timer] = entry;
      armed.delete(id);
      timer.callback();
    },
    timers: {
      setTimeout: (callback, ms) => {
        nextId += 1;
        const id = nextId;
        armed.set(id, { callback, ms });
        return () => {
          armed.delete(id);
        };
      },
    },
  };
}

async function waitFor(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + WAIT_FOR_TIMEOUT_MS;
  while (!condition()) {
    if (Date.now() > deadline) {
      assert.fail(`timed out waiting for ${what}`);
    }
    // biome-ignore lint/performance/noAwaitInLoops: Polling is sequential by nature.
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * Writes a connector that emits `recordCount` RECORD messages + a STATE
 * checkpoint, then (if `hang` is true) blocks forever without sending DONE or
 * exiting — the only way to reach the watchdog's real `run_timed_out` path
 * rather than a connector-initiated failure. If `hang` is false it sends DONE
 * and exits immediately (used as the "genuinely completed" control).
 */
function writeConnector(tmpDir: string, recordCount: number, hang: boolean): string {
  const sentMarker = join(tmpDir, CONNECTOR_SENT_MARKER);
  const connectorPath = join(tmpDir, "connector.mjs");
  const records = Array.from({ length: recordCount }, (_, i) => ({
    data: { id: `i${i}` },
    emitted_at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
    key: `i${i}`,
    stream: "items",
    type: "RECORD",
  }));
  writeFileSync(
    connectorPath,
    `
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== "START") return;
  // Reset the no-progress allowance now that this process is up. Startup
  // itself still had to fit the initial allowance; this widens what is
  // available after it. See WALL_CLOCK_BUDGET_MS.
  process.stdout.write(JSON.stringify({ message: "connector ready", type: "PROGRESS" }) + "\\n");
  const records = ${JSON.stringify(records)};
  for (const r of records) {
    process.stdout.write(JSON.stringify(r) + "\\n");
  }
  process.stdout.write(JSON.stringify({ cursor: { last: records.length ? records[records.length - 1].key : null }, stream: "items", type: "STATE" }) + "\\n");
  if (${hang ? "true" : "false"}) {
    // Never send DONE, never exit — only the scheduler watchdog can end this
    // run. The marker tells the test every message has been written.
    writeFileSync(${JSON.stringify(sentMarker)}, "");
    setInterval(() => {}, 1000);
  } else {
    process.stdout.write(JSON.stringify({ records_emitted: records.length, status: "succeeded", type: "DONE" }) + "\\n");
    rl.close();
    process.exit(0);
  }
});
`,
    "utf8"
  );
  return connectorPath;
}

/**
 * Writes a connector that emits `recordCount` records, then sends a PROGRESS
 * message with `phase_boundary: "local_only_phase_started"`, then waits until
 * the test releases it (simulating local-only work with no external
 * dependency) and it completes successfully. Used to prove the watchdog stops
 * applying `maxRunWallClockMs` once a connector declares it has left the
 * provider-rate-limited phase.
 */
function writeConnectorWithPhaseBoundary(tmpDir: string, recordCount: number, hangAfterBoundary = false): string {
  const releaseMarker = join(tmpDir, CONNECTOR_RELEASE_MARKER);
  const connectorPath = join(tmpDir, "connector.mjs");
  const records = Array.from({ length: recordCount }, (_, i) => ({
    data: { id: `i${i}` },
    emitted_at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
    key: `i${i}`,
    stream: "items",
    type: "RECORD",
  }));
  writeFileSync(
    connectorPath,
    `
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", async (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== "START") return;
  // Reset the no-progress allowance now that this process is up. Startup
  // itself still had to fit the initial allowance; this widens what is
  // available after it. See WALL_CLOCK_BUDGET_MS.
  process.stdout.write(JSON.stringify({ message: "connector ready", type: "PROGRESS" }) + "\\n");
  const records = ${JSON.stringify(records)};
  for (const r of records) {
    process.stdout.write(JSON.stringify(r) + "\\n");
  }
  process.stdout.write(JSON.stringify({ cursor: { last: records.length ? records[records.length - 1].key : null }, stream: "items", type: "STATE" }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "PROGRESS", message: "entering local-only phase", phase_boundary: "local_only_phase_started" }) + "\\n");
  if (${hangAfterBoundary ? "true" : "false"}) {
    // Deliberately make no further progress. The local-only secondary ceiling
    // must end this attempt; the pre-fix watchdog disarmed itself forever.
    setInterval(() => {}, 1000);
    return;
  }
  // Local-only work: finish when the test releases it, not after a wall-clock sleep.
  while (!existsSync(${JSON.stringify(releaseMarker)})) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  process.stdout.write(JSON.stringify({ records_emitted: records.length, status: "succeeded", type: "DONE" }) + "\\n");
  rl.close();
  process.exit(0);
});
`,
    "utf8"
  );
  return connectorPath;
}

interface SpineEventRow {
  connector_instance_id: string | null;
  data_json: string;
  event_type: string;
  run_id: string | null;
}

function spineEventsForRun(runId: string, eventType: string): SpineEventRow[] {
  return getDb()
    .prepare(
      "SELECT connector_instance_id, data_json, event_type, run_id FROM spine_events WHERE run_id = ? AND event_type = ?"
    )
    .all(runId, eventType) as SpineEventRow[];
}

function freshRuntime(): RunExecutorRuntimeState {
  return {
    announcedBackoffClass: new Map<string, string>(),
    announcedBlockedClass: new Map<string, string>(),
    exhaustedGrants: new Set<string>(),
    history: [],
    running: true,
  };
}

function schedule(connectorPath: string, ownerToken: string): ConnectorSchedule {
  return {
    connectorId: CONNECTOR_ID,
    connectorInstanceId: CONNECTOR_INSTANCE_ID,
    connectorPath,
    intervalMs: 60_000,
    manifest: MANIFEST,
    maxRetries: 0,
    ownerSubjectId: OWNER_SUBJECT_ID,
    ownerToken,
  };
}

function makeHarness(
  runtime: RunExecutorRuntimeState,
  rsUrl: string,
  maxRunWallClockMs: number,
  watchdogTimers?: WatchdogTimers
): ReturnType<typeof createRunExecutor>["launchRun"] {
  const deps: RunExecutorDeps = {
    admitRunConnection: async ({ connectorId, connectorInstanceId, ownerSubjectId }) => ({
      connectorId,
      connectorInstanceId: connectorInstanceId ?? CONNECTOR_INSTANCE_ID,
      ownerSubjectId: ownerSubjectId ?? OWNER_SUBJECT_ID,
    }),
    getState: async () => null,
    handleGrantFailureDisable: () => {
      // Grant-disable side effects are out of scope for this oracle.
    },
    isManagedConnector: () => false,
    markNeedsHuman: () => {
      // Needs-human escalation is out of scope for this oracle.
    },
    maxRunWallClockMs,
    onInteraction: async () => ({ status: "cancelled" }),
    onRunComplete: () => {
      // Completion notification is out of scope for this oracle.
    },
    persistLastRunTime: () => {
      // Last-run stamping is out of scope for this oracle.
    },
    recordAndNotify: (record) => {
      runtime.history.push(record);
      return record;
    },
    referenceBaseUrl: null,
    registerRunCancellation: null,
    resolveStaticSecretRunEnv: null,
    rsUrl,
    runManagedConnectorViaController: null,
    runtime,
    schedulerStore: null,
    setState: async () => {
      // State persistence is out of scope for this oracle.
    },
    ...(watchdogTimers ? { watchdogTimers } : {}),
  };
  return createRunExecutor(deps).launchRun;
}

async function setupConnectorManifest(asUrl: string): Promise<void> {
  await fetch(`${asUrl}/connectors`, {
    body: JSON.stringify(MANIFEST),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
}

function withServerAndTmpDir(
  fn: (ctx: { ownerToken: string; rsUrl: string; tmpDir: string }) => Promise<void>
): () => Promise<void> {
  return async () => {
    const server = (await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 })) as TestServer;
    const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-timeout-honesty-"));
    try {
      const asUrl = `http://localhost:${server.asPort}`;
      const rsUrl = `http://localhost:${server.rsPort}`;
      await setupConnectorManifest(asUrl);
      const ownerToken = await issueOwnerToken(asUrl);
      await fn({ ownerToken, rsUrl, tmpDir });
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
      await closeServer(server);
    }
  };
}

function ingestedRecordCount(): number {
  const row = getDb().prepare("SELECT count(*) AS n FROM records WHERE connector_id = ?").get(CONNECTOR_ID) as {
    n: number;
  };
  return Number(row.n);
}

function localOnlyPhaseLatched(): boolean {
  const row = getDb()
    .prepare("SELECT count(*) AS n FROM spine_events WHERE event_type = 'run.local_only_phase_started'")
    .get() as { n: number };
  return Number(row.n) > 0;
}

/**
 * Launches a connector that emits `recordCount` records and then hangs, waits
 * until every record is durably ingested, and fires the watchdog's armed
 * timer. Returns the terminal record and the delay the watchdog had armed.
 */
async function runHangingConnectorUntilWatchdogFires(
  ctx: { ownerToken: string; rsUrl: string; tmpDir: string },
  recordCount: number
) {
  const watchdog = manualWatchdogTimers();
  const launchRun = makeHarness(freshRuntime(), ctx.rsUrl, WALL_CLOCK_BUDGET_MS, watchdog.timers);
  const pending = launchRun(
    schedule(writeConnector(ctx.tmpDir, recordCount, true), ctx.ownerToken),
    false,
    SCHEDULED_POLICY
  );
  await waitFor(() => existsSync(join(ctx.tmpDir, CONNECTOR_SENT_MARKER)), "the connector to write all its messages");
  await waitFor(() => ingestedRecordCount() === recordCount, `${recordCount} records to be durably ingested`);
  const armedDelayMs = watchdog.armedDelayMs();
  watchdog.fire();
  return { armedDelayMs, record: await pending };
}

test(
  "a run that durably emits N records before being killed by the wall-clock watchdog reports records_emitted: N, not 0",
  withServerAndTmpDir(async (ctx) => {
    // The connector hangs forever after emitting, so ONLY the watchdog can end
    // this run; it is fired once all 5 records are durably ingested.
    const { armedDelayMs, record } = await runHangingConnectorUntilWatchdogFires(ctx, 5);

    assert.equal(armedDelayMs, WALL_CLOCK_BUDGET_MS);
    assert.equal(record.status, "failed");
    assert.equal(record.terminalReason, "run_timed_out");
    assert.equal(
      record.recordsEmitted,
      5,
      "the 5 records were durably ingested before the timeout fired; records_emitted must report that, not 0"
    );
  })
);

test(
  "a run that emits zero records before being killed by the watchdog still reports records_emitted: 0 (no fabrication in either direction)",
  withServerAndTmpDir(async (ctx) => {
    const { record } = await runHangingConnectorUntilWatchdogFires(ctx, 0);

    assert.equal(record.status, "failed");
    assert.equal(record.terminalReason, "run_timed_out");
    assert.equal(
      record.recordsEmitted,
      0,
      "genuinely zero emitted records must still report 0, not a fabricated count"
    );
  })
);

test(
  "a run killed by the watchdog with unfinished work records a typed gap, not an empty known_gaps array",
  withServerAndTmpDir(async (ctx) => {
    const { record } = await runHangingConnectorUntilWatchdogFires(ctx, 5);

    assert.equal(record.status, "failed");
    assert.ok(Array.isArray(record.knownGaps), "knownGaps must be an array");
    assert.ok(
      record.knownGaps.length > 0,
      `a timed-out run with unfinished work must name a typed gap, got: ${JSON.stringify(record.knownGaps)}`
    );
    const gap = record.knownGaps[0] as { kind?: string; reason?: string };
    assert.equal(gap.kind, "run_failed", "the gap must be a typed run_failed gap, not an untyped placeholder");
  })
);

test(
  "a run that genuinely completes (no timeout) is unaffected by the timeout-path fix",
  withServerAndTmpDir(async ({ ownerToken, rsUrl, tmpDir }) => {
    const runtime = freshRuntime();
    const launchRun = makeHarness(runtime, rsUrl, 60_000);

    const record = await launchRun(schedule(writeConnector(tmpDir, 5, false), ownerToken), false, SCHEDULED_POLICY);

    assert.equal(record.status, "succeeded");
    assert.equal(record.terminalReason, null);
    assert.equal(record.recordsEmitted, 5);
    assert.deepEqual(record.knownGaps, []);
  })
);

test(
  "a connector that declares a local-only phase boundary is not truncated by maxRunWallClockMs, even though it runs well past that budget",
  withServerAndTmpDir(async ({ ownerToken, rsUrl, tmpDir }) => {
    // Without the phase-boundary fix the watchdog would stay armed at one
    // budget and kill the run once local-only work outlasted it; with the fix
    // the boundary replaces that timer with the four-budget ceiling. The
    // connector keeps working until released, so the only thing that could end
    // the run is the armed timer, which this test asserts is the ceiling.
    const watchdog = manualWatchdogTimers();
    const launchRun = makeHarness(freshRuntime(), rsUrl, WALL_CLOCK_BUDGET_MS, watchdog.timers);

    const pending = launchRun(
      schedule(writeConnectorWithPhaseBoundary(tmpDir, 5), ownerToken),
      false,
      SCHEDULED_POLICY
    );
    try {
      await waitFor(localOnlyPhaseLatched, "the local-only phase boundary to be latched");
      assert.equal(
        watchdog.armedDelayMs(),
        LOCAL_ONLY_CEILING_MS,
        "after the boundary the primary budget must be replaced by the local-only ceiling"
      );
    } finally {
      // Release the connector even when an assertion above failed, so a failure
      // reports instead of hanging on a connector that waits for this marker.
      writeFileSync(join(tmpDir, CONNECTOR_RELEASE_MARKER), "");
    }
    const record = await pending;

    assert.equal(
      record.status,
      "succeeded",
      `expected the local-only phase to survive past maxRunWallClockMs, got status=${record.status} terminalReason=${String(record.terminalReason)}`
    );
    assert.equal(record.terminalReason, null);
    assert.equal(record.recordsEmitted, 5);

    // The watchdog suppressing maxRunWallClockMs is a decision that must
    // leave a durable trace — without it, an operator watching a run exceed
    // its ceiling cannot tell "legitimately in a local-only phase" from "the
    // watchdog failed to fire" without reading source.
    const { runId } = record;
    assert.ok(runId, "expected the record to carry a run_id to look up its spine events");
    const events = spineEventsForRun(runId as string, "run.local_only_phase_started");
    assert.equal(
      events.length,
      1,
      `expected exactly one run.local_only_phase_started spine event for ${runId}, got ${events.length}`
    );
    const [event] = events;
    assert.ok(event, "expected the queried spine event row to be present");
    const data = JSON.parse(event.data_json) as {
      disarmed_timer_ms?: number;
      elapsed_ms?: number;
      phase_boundary?: string;
    };
    assert.equal(event.connector_instance_id, CONNECTOR_INSTANCE_ID);
    assert.equal(data.phase_boundary, "local_only_phase_started");
    assert.equal(
      data.disarmed_timer_ms,
      WALL_CLOCK_BUDGET_MS,
      "must name the maxRunWallClockMs value the timer was disarmed from"
    );
    assert.ok(
      typeof data.elapsed_ms === "number" && data.elapsed_ms >= 0,
      `expected a non-negative elapsed_ms at latch, got ${String(data.elapsed_ms)}`
    );
  })
);

test(
  "a run with no phase-boundary declaration never emits a local_only_phase_started spine event (control for the durable-trace test above)",
  withServerAndTmpDir(async (ctx) => {
    const { record } = await runHangingConnectorUntilWatchdogFires(ctx, 5);

    assert.equal(record.status, "failed");
    assert.equal(record.terminalReason, "run_timed_out");
    const { runId } = record;
    assert.ok(runId, "expected the record to carry a run_id to look up its spine events");
    const events = spineEventsForRun(runId as string, "run.local_only_phase_started");
    assert.equal(
      events.length,
      0,
      "a run that never declares a local-only phase must not emit a local_only_phase_started event"
    );
  })
);

test(
  "without a phase-boundary declaration, a connector running past maxRunWallClockMs IS killed (control for the phase-boundary test above)",
  withServerAndTmpDir(async (ctx) => {
    // Same shape as the phase-boundary connector but with no phase_boundary
    // PROGRESS message — proves the watchdog's default behavior (kill at
    // maxRunWallClockMs) is still intact and that it is specifically the
    // phase_boundary signal, not merely "the connector kept emitting
    // PROGRESS", that replaces the primary budget. This connector DOES emit a
    // plain "ready" PROGRESS, so that distinction is exercised rather than
    // assumed: a plain PROGRESS re-arms the primary budget, it does not
    // replace it with the local-only ceiling.
    const { armedDelayMs, record } = await runHangingConnectorUntilWatchdogFires(ctx, 5);

    assert.equal(armedDelayMs, WALL_CLOCK_BUDGET_MS);
    assert.equal(record.status, "failed");
    assert.equal(record.terminalReason, "run_timed_out");
  })
);

test(
  "a connector that hangs after the local-only phase boundary is still killed by the secondary ceiling",
  withServerAndTmpDir(async ({ ownerToken, rsUrl, tmpDir }) => {
    const watchdog = manualWatchdogTimers();
    const launchRun = makeHarness(freshRuntime(), rsUrl, WALL_CLOCK_BUDGET_MS, watchdog.timers);

    // hangAfterBoundary=true, so the connector never completes — the secondary
    // ceiling (WALL_CLOCK_BUDGET_MS * 4, see createAttemptWatchdog) is what must
    // end this attempt.
    const pending = launchRun(
      schedule(writeConnectorWithPhaseBoundary(tmpDir, 1, true), ownerToken),
      false,
      SCHEDULED_POLICY
    );
    try {
      await waitFor(localOnlyPhaseLatched, "the local-only phase boundary to be latched");
      assert.equal(watchdog.armedDelayMs(), LOCAL_ONLY_CEILING_MS);
    } finally {
      // Fire even when an assertion above failed, so a failure reports instead
      // of hanging on a connector that never exits.
      if (watchdog.armedDelayMs() !== null) {
        watchdog.fire();
      }
    }
    const record = await pending;

    assert.equal(record.status, "failed");
    assert.equal(record.terminalReason, "run_timed_out");
  })
);

test(
  "the production default timers arm a real timer that kills a hanging connector with run_timed_out",
  withServerAndTmpDir(async (ctx) => {
    // No injected timers: this exercises GLOBAL_WATCHDOG_TIMERS. The budget is
    // tiny, and the assertion waits on the run's own terminal event, so it does
    // not depend on how long startup takes. Only the classification is asserted
    // (the record count depends on how far the connector got before the kill).
    const launchRun = makeHarness(freshRuntime(), ctx.rsUrl, 20);
    const record = await launchRun(
      schedule(writeConnector(ctx.tmpDir, 0, true), ctx.ownerToken),
      false,
      SCHEDULED_POLICY
    );

    assert.equal(record.status, "failed");
    assert.equal(record.terminalReason, "run_timed_out");
  })
);

const BUDGET_ERROR = /maxRunWallClockMs/;

// The watchdog budget contract: a positive finite number arms the ceiling,
// `Infinity` and `0` are the documented ways to disable it
// (runtime/scheduler-config.ts), and anything else is a configuration error.
// A NaN or negative budget used to read as "no ceiling", so a hanging connector
// was never killed and nothing recorded why.
for (const invalid of [Number.NaN, -1, Number.NEGATIVE_INFINITY]) {
  test(`createAttemptWatchdog rejects the invalid budget ${String(invalid)} instead of silently disabling the ceiling`, () => {
    const watchdog = manualWatchdogTimers();
    assert.throws(() => createAttemptWatchdog(invalid, watchdog.timers), BUDGET_ERROR);
    assert.equal(watchdog.armedDelayMs(), null);
  });
}

for (const optOut of [0, Number.POSITIVE_INFINITY]) {
  test(`createAttemptWatchdog treats ${String(optOut)} as the explicit opt-out: nothing is armed`, () => {
    const watchdog = manualWatchdogTimers();
    const attempt = createAttemptWatchdog(optOut, watchdog.timers);
    attempt.markProgress({ phase_boundary: "local_only_phase_started" });
    assert.equal(watchdog.armedDelayMs(), null);
    assert.equal(attempt.timedOut(), false);
  });
}

// setTimeout cannot delay past 2^31 - 1 ms (Node fires it almost at once), and
// `budget * 4` can overflow to Infinity, which reads as "unbounded". A huge but
// finite budget must keep a real, finite ceiling.
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;
for (const hugeBudget of [2 ** 30, 1e308]) {
  test(`the local-only ceiling for a finite budget of ${String(hugeBudget)} ms is clamped to a finite timer delay`, () => {
    const watchdog = manualWatchdogTimers();
    const attempt = createAttemptWatchdog(hugeBudget, watchdog.timers);
    attempt.markProgress({ phase_boundary: "local_only_phase_started" });
    assert.equal(watchdog.armedDelayMs(), MAX_TIMER_DELAY_MS);
  });
}

test("createRunExecutor rejects an invalid wall-clock budget at construction", () => {
  assert.throws(() => makeHarness(freshRuntime(), "http://127.0.0.1:1", Number.NaN), BUDGET_ERROR);
  assert.throws(() => makeHarness(freshRuntime(), "http://127.0.0.1:1", -1), BUDGET_ERROR);
});
