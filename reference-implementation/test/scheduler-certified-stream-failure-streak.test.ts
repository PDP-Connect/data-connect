// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * A "certified stream-scoped failure" is a run that ends DONE failed with
 * `error.code = stream_collection_failed` plus an in-scope SKIP_RESULT for each
 * failed stream. The runtime commits the cursors of the sibling streams and
 * withholds only the failed streams' cursors (`checkpoint_commit_status` is
 * `committed` or `partially_committed`). The source IS making progress.
 *
 * Every DONE-failed run shares the streak class
 * `terminal:connector_reported_failed`, so before this change a stream that
 * failed on every run stopped automatic sync of the whole source after
 * `BLOCKED_PROMOTION_THRESHOLD` (7) runs, even though its siblings committed
 * on each run. These tests pin that such a run does not count toward the
 * back-off or `blocked` thresholds, and that every other failure keeps counting.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { emitSpineEvent } from "../lib/spine.ts";

import { BLOCKED_PROMOTION_THRESHOLD } from "../runtime/connection-health-policy.ts";
import { createScheduler } from "../runtime/scheduler.ts";
import {
  computeNextRunWithBackoff,
  DEFAULT_BACKOFF_THRESHOLD,
  isCertifiedStreamFailureWithCommittedSiblings,
} from "../runtime/scheduler-backoff.ts";
import type { RunRecord } from "../runtime/scheduler-domain-types.ts";
import { closeDb, initDb } from "../server/db.ts";
import { startServer } from "../server/index.ts";
import { createRunManagedConnectorViaController } from "../server/scheduler-manager-factory.ts";
import type { SchedulerRunHistoryRecord } from "../server/stores/scheduler-store.ts";
import { closeTestServer } from "./helpers/close-test-server.ts";

const BASE_INTERVAL_MS = 60_000;
const CONNECTOR_ID = "scheduler-certified-stream-failure-streak";
const NOW_MS = Date.parse("2026-05-16T00:00:00.000Z");
const SEVEN_GENUINE = BLOCKED_PROMOTION_THRESHOLD;

type CommitStatus = "committed" | "disabled" | "not_committed" | "partially_committed";

interface RunShape {
  readonly commitStatus?: CommitStatus | null;
  readonly errorCode?: string | null;
  readonly index?: number;
  readonly status?: "failed" | "skipped" | "succeeded";
}

function runRecord({ commitStatus = null, errorCode = null, index = 0, status = "failed" }: RunShape): RunRecord {
  const startedAt = new Date(NOW_MS + index * 1000).toISOString();
  return {
    attempt: 1,
    checkpointSummary: commitStatus === null ? null : { commit_status: commitStatus },
    completedAt: new Date(NOW_MS + index * 1000 + 500).toISOString(),
    connectorError:
      errorCode === null ? null : { code: errorCode, message: "stream collection failed", retryable: true },
    connectorId: CONNECTOR_ID,
    knownGaps: [],
    recordsEmitted: 0,
    source: { id: CONNECTOR_ID, kind: "connector" },
    startedAt,
    status,
    terminalReason: status === "failed" ? "connector_reported_failed" : null,
  };
}

/** Certified failure; sibling streams committed (`partially_committed`). */
function certifiedWithSiblings(index: number, commitStatus: CommitStatus = "partially_committed"): RunRecord {
  return runRecord({ commitStatus, errorCode: "stream_collection_failed", index });
}

/** Any other DONE failed run: same streak class, no stream-scoped certificate. */
function genuineFailure(index: number): RunRecord {
  return runRecord({ commitStatus: "not_committed", errorCode: "something_else", index });
}

function history(count: number, build: (index: number) => RunRecord): RunRecord[] {
  return Array.from({ length: count }, (_, index) => build(index));
}

function decide(records: readonly RunRecord[]) {
  const last = records.at(-1);
  return computeNextRunWithBackoff(records, BASE_INTERVAL_MS, last ? Date.parse(last.completedAt) : 0);
}

// ─── Predicate ──────────────────────────────────────────────────────────────

test("certified-with-siblings predicate needs a failed run, the certified code and committed sibling state", () => {
  assert.equal(isCertifiedStreamFailureWithCommittedSiblings(certifiedWithSiblings(0, "partially_committed")), true);
  assert.equal(isCertifiedStreamFailureWithCommittedSiblings(certifiedWithSiblings(0, "committed")), true);

  // Certified code, but no sibling cursor moved: not progress, keeps counting.
  assert.equal(isCertifiedStreamFailureWithCommittedSiblings(certifiedWithSiblings(0, "not_committed")), false);
  assert.equal(isCertifiedStreamFailureWithCommittedSiblings(certifiedWithSiblings(0, "disabled")), false);
  // Certified code with no checkpoint summary at all (nothing proves a commit).
  assert.equal(
    isCertifiedStreamFailureWithCommittedSiblings(runRecord({ errorCode: "stream_collection_failed" })),
    false
  );
  // Committed state but a different error code.
  assert.equal(
    isCertifiedStreamFailureWithCommittedSiblings(runRecord({ commitStatus: "committed", errorCode: "other" })),
    false
  );
  // Not a failed run.
  assert.equal(
    isCertifiedStreamFailureWithCommittedSiblings(
      runRecord({ commitStatus: "committed", errorCode: "stream_collection_failed", status: "succeeded" })
    ),
    false
  );
});

// ─── Streak walk ────────────────────────────────────────────────────────────

test("repeated certified failures with committed siblings never back off or block", () => {
  const counts = [1, DEFAULT_BACKOFF_THRESHOLD, BLOCKED_PROMOTION_THRESHOLD, BLOCKED_PROMOTION_THRESHOLD + 5, 40];
  for (const count of counts) {
    const decision = decide(history(count, (index) => certifiedWithSiblings(index)));
    assert.equal(decision.backoffApplied, false, `${count} runs: no back-off`);
    assert.equal(decision.recommendedHealthState, null, `${count} runs: not cooling_off or blocked`);
    assert.equal(decision.consecutiveFailures, 0, `${count} runs: not counted`);
    assert.equal(decision.effectiveIntervalMs, BASE_INTERVAL_MS, `${count} runs: base interval`);
  }
});

test("repeated certified failures where no sibling committed still back off and block (unchanged)", () => {
  const atBackoff = decide(
    history(DEFAULT_BACKOFF_THRESHOLD, (index) => certifiedWithSiblings(index, "not_committed"))
  );
  assert.equal(atBackoff.backoffApplied, true);
  assert.equal(atBackoff.recommendedHealthState, "cooling_off");

  const atBlocked = decide(
    history(BLOCKED_PROMOTION_THRESHOLD, (index) => certifiedWithSiblings(index, "not_committed"))
  );
  assert.equal(atBlocked.consecutiveFailures, BLOCKED_PROMOTION_THRESHOLD);
  assert.equal(atBlocked.recommendedHealthState, "blocked");
});

test("repeated genuine failures still back off and block (unchanged)", () => {
  const decision = decide(history(BLOCKED_PROMOTION_THRESHOLD, genuineFailure));
  assert.equal(decision.consecutiveFailures, BLOCKED_PROMOTION_THRESHOLD);
  assert.equal(decision.recommendedHealthState, "blocked");
});

test("a certified-with-siblings run ends a genuine-failure streak: the source collected and committed", () => {
  // Six genuine failures, then a run that committed siblings. The cause of the
  // whole-run failures is gone (the run reached sibling collection), so the next
  // genuine failure starts a new streak at 1 and the source is not blocked.
  const records = [...history(6, genuineFailure), certifiedWithSiblings(6), genuineFailure(7)];
  const decision = decide(records);
  assert.equal(decision.consecutiveFailures, 1);
  assert.equal(decision.backoffApplied, false);
  assert.equal(decision.recommendedHealthState, null);

  // And while the newest run is the certified one, the stale streak is not live.
  const afterCertified = decide([...history(6, genuineFailure), certifiedWithSiblings(6)]);
  assert.equal(afterCertified.consecutiveFailures, 0);
  assert.equal(afterCertified.backoffApplied, false);
});

test("genuine failures after certified runs count only themselves", () => {
  const records = [...history(10, (index) => certifiedWithSiblings(index)), genuineFailure(10), genuineFailure(11)];
  assert.equal(decide(records).consecutiveFailures, 2);
});

test("a certified-with-siblings run is not a success: it does not pose as one for the external success anchor", () => {
  // `lastSuccessAtMs` is the only way a success is recorded off the scheduler's
  // own history. A certified run must not be turned into one by the walk.
  const records = history(10, (index) => certifiedWithSiblings(index));
  assert.equal(records.every((record) => record.status === "failed"), true);
  const decision = computeNextRunWithBackoff(records, BASE_INTERVAL_MS, NOW_MS + 20_000, { lastSuccessAtMs: null });
  assert.equal(decision.reasonClass, null, "no failure class is reported for a progress run");
});

// ─── Scheduler dispatch gate ────────────────────────────────────────────────

const REFERENCE_IMPL_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

function persistedRunAt(base: RunRecord, atMs: number): SchedulerRunHistoryRecord {
  return persistedRun(0, {
    ...base,
    completedAt: new Date(atMs + 500).toISOString(),
    startedAt: new Date(atMs).toISOString(),
  });
}

function persistedRun(index: number, base: RunRecord): SchedulerRunHistoryRecord {
  return {
    attempt: base.attempt,
    checkpointSummary: base.checkpointSummary,
    completedAt: base.completedAt,
    connectorError: (base.connectorError as Record<string, unknown> | null) ?? null,
    connectorId: base.connectorId,
    ...(base.error === undefined ? {} : { error: base.error }),
    failureReason: null,
    knownGaps: [],
    recordsEmitted: 0,
    reportedRecordsEmitted: null,
    runId: null,
    source: { id: base.connectorId, kind: "connector" },
    startedAt: base.startedAt,
    status: base.status,
    terminalReason: base.terminalReason ?? null,
    traceId: `trace-${index}`,
  };
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (condition()) {
      return true;
    }
    // biome-ignore lint/performance/noAwaitInLoops: ordered test polling is intentionally sequential
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

async function issueOwnerToken(asUrl: string, subjectId: string): Promise<string> {
  const post = async (path: string, body: URLSearchParams) =>
    fetch(`${asUrl}${path}`, {
      body: body.toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
  const deviceResponse = await post("/oauth/device_authorization", new URLSearchParams({ client_id: "pdpp_cli" }));
  const device = (await deviceResponse.json()) as { device_code: string; user_code: string };
  const approved = await post(
    "/device/approve",
    new URLSearchParams({ subject_id: subjectId, user_code: device.user_code })
  );
  assert.equal(approved.status, 200);
  const token = (await (
    await post(
      "/oauth/token",
      new URLSearchParams({
        client_id: "pdpp_cli",
        device_code: device.device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      })
    )
  ).json()) as { access_token: string };
  return token.access_token;
}

async function dispatchGateOutcome(
  records: readonly RunRecord[]
): Promise<{ gaveUp: boolean; gaveUpEmitted: boolean; reachedReadiness: boolean }> {
  const spotifyManifest = JSON.parse(
    readFileSync(join(REFERENCE_IMPL_DIR, "fixtures/seed-manifests/spotify.json"), "utf8")
  );
  const manifest = { ...spotifyManifest, connector_id: CONNECTOR_ID, connector_key: CONNECTOR_ID };
  const server = await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  const asUrl = `http://localhost:${(server as unknown as { asPort: number }).asPort}`;
  const rsUrl = `http://localhost:${(server as unknown as { rsPort: number }).rsPort}`;
  const completedRuns: RunRecord[] = [];
  try {
    const registered = await fetch(`${asUrl}/connectors`, {
      body: JSON.stringify(manifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(registered.status, 201);
    const ownerToken = await issueOwnerToken(asUrl, "certified_streak_user");
    // Anchor every record just before now so the back-off window is live.
    const shift = Date.now() - 60_000 - NOW_MS;
    const persisted = records.map((record, index) =>
      persistedRun(index, {
        ...record,
        completedAt: new Date(Date.parse(record.completedAt) + shift).toISOString(),
        startedAt: new Date(Date.parse(record.startedAt) + shift).toISOString(),
      })
    );
    const scheduler = createScheduler({
      admitRunConnection: ({ connectorId, connectorInstanceId, ownerSubjectId }) =>
        Promise.resolve({
          connectorId,
          connectorInstanceId: connectorInstanceId ?? connectorId,
          ownerSubjectId: ownerSubjectId ?? "certified_streak_user",
        }),
      connectors: [
        {
          connectorId: CONNECTOR_ID,
          connectorInstanceId: CONNECTOR_ID,
          connectorPath: join(REFERENCE_IMPL_DIR, "connectors/seed/index.ts"),
          intervalMs: 25,
          manifest,
          maxRetries: 0,
          ownerSubjectId: "certified_streak_user",
          ownerToken,
        },
      ],
      getState: async () => null,
      onInteraction: async () => ({ status: "cancelled", type: "INTERACTION_RESPONSE" }),
      onRunComplete: (record) => completedRuns.push(record),
      readinessChecker: async () => ({ ready: false, reason: "simulated unattended gate" }),
      rsUrl,
      schedulerStore: {
        // biome-ignore lint/suspicious/noEmptyBlockStatements: test store callback is intentionally empty
        appendRunHistory: async () => {},
        // biome-ignore lint/suspicious/noEmptyBlockStatements: test store callback is intentionally empty
        deleteActiveRun: async () => {},
        listLastRunTimes: async () => [],
        listRunHistory: async () => persisted,
        upsertActiveRun: async () => true,
        // biome-ignore lint/suspicious/noEmptyBlockStatements: test store callback is intentionally empty
        upsertLastRunTime: async () => {},
      },
      // biome-ignore lint/suspicious/noEmptyBlockStatements: test callback is intentionally empty
      setState: async () => {},
    });
    scheduler.start();
    const gaveUp = await waitFor(
      () =>
        completedRuns.some(
          (record) =>
            record.error?.startsWith("schedule.gave_up:") || record.error?.startsWith("scheduler_backoff_applied:")
        ),
      1500
    );
    scheduler.stop();
    const reachedReadiness = completedRuns.some((record) => record.error?.includes("simulated unattended gate"));
    const gaveUpEmitted = completedRuns.some((record) => record.error?.startsWith("schedule.gave_up:"));
    return { gaveUp, gaveUpEmitted, reachedReadiness };
  } finally {
    await closeTestServer(server);
    closeDb();
  }
}

test("scheduler keeps dispatching a source whose failed stream never recovers while siblings commit", async () => {
  const outcome = await dispatchGateOutcome(
    history(BLOCKED_PROMOTION_THRESHOLD + 3, (index) => certifiedWithSiblings(index))
  );
  assert.equal(outcome.gaveUp, false, "no schedule.gave_up / back-off skip for committed-sibling certified failures");
  assert.equal(outcome.reachedReadiness, true, "the tick passed the back-off gate and reached the next gate");
});

test("scheduler still gives up after the same number of certified failures that committed nothing", async () => {
  const outcome = await dispatchGateOutcome(
    history(BLOCKED_PROMOTION_THRESHOLD + 3, (index) => certifiedWithSiblings(index, "not_committed"))
  );
  assert.equal(outcome.gaveUp, true);
});

// ─── Streak identity: counter, dispatch dedup and persisted markers ─────────
//
// The counter, the announce-once cells and the persisted `back_off.started` /
// `gave_up` marker lookups must agree on where a streak ends. Otherwise a
// certified reset clears the count while the old `gave_up` marker still
// suppresses the next real blockage alert and its escalation.

function gaveUpMarker(index: number): RunRecord {
  return {
    ...runRecord({ index, status: "skipped" }),
    error:
      'schedule.gave_up: {"reason_class":"terminal:connector_reported_failed","final_consecutive_failures":7,"last_success_at":null}',
    terminalReason: null,
  };
}

test("two blocked cycles with certified progress between them each announce gave_up, after a reload from history", async () => {
  // First blocked cycle: seven genuine failures, then its announced marker.
  // Then a certified run ends that streak. Then a second blocked cycle of seven.
  const first = history(SEVEN_GENUINE, genuineFailure);
  const second = history(SEVEN_GENUINE, (index) => genuineFailure(SEVEN_GENUINE + 2 + index));
  const records = [...first, gaveUpMarker(SEVEN_GENUINE), certifiedWithSiblings(SEVEN_GENUINE + 1), ...second];
  const outcome = await dispatchGateOutcome(records);
  assert.equal(outcome.gaveUp, true, "the second cycle is blocked");
  assert.equal(outcome.gaveUpEmitted, true, "the first cycle's marker must not suppress the second cycle's gave_up");
});

test("without certified progress between them, one blocked streak announces gave_up once, after a reload", async () => {
  const records = [
    ...history(SEVEN_GENUINE, genuineFailure),
    gaveUpMarker(SEVEN_GENUINE),
    ...history(3, (index) => genuineFailure(SEVEN_GENUINE + 1 + index)),
  ];
  const outcome = await dispatchGateOutcome(records);
  assert.equal(outcome.gaveUpEmitted, false, "the persisted marker already announced this streak");
});

test("a certified run that ends an announced back-off streak emits back_off.cleared and resets the announce cells", async () => {
  const completedRuns: RunRecord[] = [];
  const base = Date.now() - 60_000;
  const persisted = Array.from({ length: DEFAULT_BACKOFF_THRESHOLD }, (_, index) =>
    persistedRunAt(genuineFailure(index), base + index * 1000)
  );
  const scheduler = createScheduler({
    connectors: [
      {
        connectorId: CONNECTOR_ID,
        connectorInstanceId: CONNECTOR_ID,
        connectorPath: join(REFERENCE_IMPL_DIR, "connectors/seed/index.ts"),
        intervalMs: 25,
        manifest: { connector_id: CONNECTOR_ID, streams: [{ name: "items" }] },
        maxRetries: 0,
        ownerSubjectId: "owner",
        ownerToken: "owner-token",
      },
    ],
    onInteraction: async () => ({ status: "cancelled" }),
    onRunComplete: (record) => completedRuns.push(record),
    rsUrl: "http://localhost.invalid",
    runManagedConnectorViaController: () => ({
      checkpoint_summary: { commit_status: "partially_committed" },
      connector_error: { code: "stream_collection_failed" },
      run_id: MANAGED_RUN_ID,
      status: "failed",
      terminal_reason: "connector_reported_failed",
      trace_id: "trace-managed-certified-streak",
    }),
    schedulerStore: {
      // biome-ignore lint/suspicious/noEmptyBlockStatements: test store callback is intentionally empty
      appendRunHistory: async () => {},
      // biome-ignore lint/suspicious/noEmptyBlockStatements: test store callback is intentionally empty
      deleteActiveRun: async () => {},
      listLastRunTimes: async () => [],
      listRunHistory: async () => persisted,
      upsertActiveRun: async () => true,
      // biome-ignore lint/suspicious/noEmptyBlockStatements: test store callback is intentionally empty
      upsertLastRunTime: async () => {},
    },
  });
  try {
    scheduler.start();
    assert.equal(
      await waitFor(() => completedRuns.some((record) => record.error?.startsWith("schedule.back_off.cleared:")), 5000),
      true,
      "the announced back-off streak ended, so the cleared marker is emitted"
    );
  } finally {
    scheduler.stop();
  }
  const announced = completedRuns.findIndex((record) => record.error?.startsWith("schedule.back_off.started:"));
  const certified = completedRuns.findIndex((record) => record.status === "failed");
  const cleared = completedRuns.findIndex((record) => record.error?.startsWith("schedule.back_off.cleared:"));
  assert.ok(
    announced >= 0 && announced < certified && certified < cleared,
    "started, then certified run, then cleared"
  );
});

// ─── Known limitation: manual runs are not in scheduler history ─────────────

test("known limitation: a manual certified run cannot clear a blocked streak; a manual genuine success still can", () => {
  // A manual `controller.runNow` never enters the scheduler's own history, so
  // the walk sees only the seven scheduled failures whatever the owner did
  // since. There is no certified-progress anchor on purpose (a durable,
  // connection-scoped recovery projection is the follow-up). A manual genuine
  // success is visible through `lastSuccessAtMs`, as it always was.
  const records = history(SEVEN_GENUINE, genuineFailure);
  const lastFailureMs = NOW_MS + (SEVEN_GENUINE - 1) * 1000 + 500;
  assert.equal(decide(records).recommendedHealthState, "blocked");
  const afterManualSuccess = computeNextRunWithBackoff(records, BASE_INTERVAL_MS, lastFailureMs, {
    lastSuccessAtMs: lastFailureMs + 1000,
  });
  assert.equal(afterManualSuccess.recommendedHealthState, null);
  assert.equal(afterManualSuccess.consecutiveFailures, 0);
});

// ─── Managed (browser-surface) runs ─────────────────────────────────────────
//
// A managed run is dispatched through `controller.runNow`, and the scheduler
// reads its outcome back from the run's terminal spine event. That event carries
// the connector error as flat `connector_error_*` fields and the checkpoint
// outcome as `checkpoint_commit_status`. Both facts the streak walk needs must
// survive this projection into the RunRecord.

const MANAGED_RUN_ID = "run_managed_certified_streak";

function managedFixtureDb(t: TestContext): void {
  closeDb();
  initDb(join(mkdtempSync(join(tmpdir(), "pdpp-managed-certified-streak-")), "pdpp.sqlite"));
  t.after(() => closeDb());
}

async function emitCertifiedTerminalEvent(): Promise<void> {
  await emitSpineEvent({
    actor_id: CONNECTOR_ID,
    actor_type: "runtime",
    data: {
      checkpoint_commit_status: "partially_committed",
      connector_error_code: "stream_collection_failed",
      connector_error_message: "stream collection failed: failed_stream: upstream 500",
      connector_error_retryable: true,
      reason: "connector_reported_failed",
      records_emitted: 3,
      state_streams_committed: 1,
      state_streams_staged: 2,
    },
    event_type: "run.failed",
    object_id: MANAGED_RUN_ID,
    object_type: "run",
    run_id: MANAGED_RUN_ID,
    scenario_id: "scenario-managed-certified-streak",
    status: "failed",
    trace_id: "trace-managed-certified-streak",
  });
}

test("managed run adapter carries the connector error code and commit status of a certified failure", async (t) => {
  managedFixtureDb(t);
  await emitCertifiedTerminalEvent();
  const runner = createRunManagedConnectorViaController({
    awaitRun: async () => "failed",
    browserSurfaceLeaseManager: { isManagedConnector: () => true },
    getActiveRun: () => null,
    isNeedsHuman: () => false,
    issueRuntimeOwnerToken: async () => "owner-token",
    markNeedsHuman: () => undefined,
    runNow: () =>
      Promise.resolve({ run_id: MANAGED_RUN_ID, status: "started", trace_id: "trace-managed-certified-streak" }),
  });
  assert.ok(runner);
  const result = await runner(CONNECTOR_ID, {
    connectorInstanceId: CONNECTOR_ID,
    ownerSubjectId: "owner",
    ownerToken: "owner-token",
    priorityClass: "background",
    triggerKind: "scheduled",
  });
  assert.equal(result?.status, "failed");
  assert.equal(result?.connector_error?.code, "stream_collection_failed");
  assert.equal(result?.checkpoint_summary?.commit_status, "partially_committed");
  // Retry classification of managed runs is unchanged: only the code is carried.
  assert.equal(result?.connector_error?.retryable, undefined);
  assert.equal(result?.connector_error?.message, undefined);
});

test("scheduler records a managed certified failure so the streak walk recognizes it", async () => {
  const completedRuns: RunRecord[] = [];
  const scheduler = createScheduler({
    connectors: [
      {
        connectorId: CONNECTOR_ID,
        connectorInstanceId: CONNECTOR_ID,
        connectorPath: join(REFERENCE_IMPL_DIR, "connectors/seed/index.ts"),
        intervalMs: 25,
        manifest: { connector_id: CONNECTOR_ID, streams: [{ name: "items" }] },
        maxRetries: 0,
        ownerSubjectId: "owner",
        ownerToken: "owner-token",
      },
    ],
    onInteraction: async () => ({ status: "cancelled" }),
    onRunComplete: (record) => completedRuns.push(record),
    rsUrl: "http://localhost.invalid",
    runManagedConnectorViaController: () => ({
      checkpoint_summary: { commit_status: "partially_committed" },
      connector_error: { code: "stream_collection_failed" },
      run_id: MANAGED_RUN_ID,
      status: "failed",
      terminal_reason: "connector_reported_failed",
      trace_id: "trace-managed-certified-streak",
    }),
  });
  try {
    scheduler.start();
    assert.equal(await waitFor(() => completedRuns.length >= 1, 5000), true);
  } finally {
    scheduler.stop();
  }
  const [record] = completedRuns;
  assert.ok(record);
  assert.equal(record.status, "failed");
  assert.equal(isCertifiedStreamFailureWithCommittedSiblings(record), true);
});
