// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// What an automatic dispatch DECIDES before it launches, and when it may act on
// that decision.
//
// `scheduler-stop-epoch.test.ts` and `scheduler-stop-epoch-attempts.test.ts`
// cover launching attempts. These tests cover everything the dispatch writes
// BEFORE a launch: the pre-run gate's skip records (unresolved attention,
// automation policy, readiness, needs-human, exhausted or disabled grant), the
// governor's back-off and gave_up announcements, and the escalations those raise.
// All of them are side effects of the dispatch, so none may happen once the
// scheduler is stopped or the schedule is disabled, and a decision that is
// dropped must leave no announce-once mark behind: the next valid tick has to
// announce it, once.
//
// Every test that awaits a deferred the code under test must resolve carries
// HANG_GUARD, and its cleanup is registered with `t.after` (see the harness).

import assert from "node:assert/strict";
import test, { mock } from "node:test";

import { BLOCKED_PROMOTION_THRESHOLD } from "../runtime/connection-health-policy.ts";
import { projectRunAutomationPolicy } from "../runtime/run-automation-policy.ts";
import { createDispatchGovernor, type DispatchGovernorRuntimeState } from "../runtime/scheduler/dispatch-governor.ts";
import { bindDispatchEscalation } from "../runtime/scheduler/dispatch-guard.ts";
import {
  createPreRunGate,
  type EndingGateDecision,
  type GateDecision,
  type PreRunGateRuntimeState,
} from "../runtime/scheduler/pre-run-gate.ts";
import { DEFAULT_BACKOFF_THRESHOLD } from "../runtime/scheduler-backoff.ts";
import type {
  DispatchEscalationHandler,
  HumanRequiredStateEscalationHandler,
  RunRecord,
  SchedulerReadinessResult,
  UnresolvedAttentionEvidence,
} from "../runtime/scheduler-domain-types.ts";
import { closeDb, initDb } from "../server/db.ts";
import type { SchedulerRunHistoryRecord } from "../server/stores/scheduler-store.ts";
import {
  buildConnectorSchedule,
  buildStore,
  CONNECTOR_ID,
  deferred,
  directScheduler,
  drain,
  eventOrQuiet,
  HANG_GUARD,
  INSTANCE_ID,
  type ScheduleRow,
  type SchedulerOptions,
  type ScheduleSpec,
  writeConnector,
} from "./helpers/scheduler-stop-harness.ts";

type EscalationInfo = Parameters<HumanRequiredStateEscalationHandler>[0];

const UNUSED_CONNECTOR = "/nonexistent/connector.mjs";

// ── pre-run gates: no skip record after a stop or a disable ────────────────

const NOT_BACKGROUND_SAFE_MANIFEST = {
  capabilities: { refresh_policy: { background_safe: false, recommended_mode: "automatic" } },
  streams: [{ name: "items" }],
};

interface GateCase {
  /** Builds the scheduler options that make the gate announce, parking its first await on `park`. */
  readonly build: (park: () => Promise<void>) => {
    extra: Partial<SchedulerOptions>;
    schedule?: Partial<ScheduleSpec>;
  };
  readonly error: RegExp;
  /** Escalations one announcement raises. */
  readonly escalations: number;
  readonly name: string;
}

const GATE_CASES: readonly GateCase[] = [
  {
    build: (park) => ({
      extra: {
        hasUnresolvedAttention: async () => {
          await park();
          return { key: "attention-1", reason: "owner_input" };
        },
      },
    }),
    error: /^attention_unresolved/,
    escalations: 0,
    name: "unresolved attention",
  },
  {
    build: (park) => ({
      extra: {
        hasUnresolvedAttention: async () => {
          await park();
          return null;
        },
      },
      schedule: { manifest: NOT_BACKGROUND_SAFE_MANIFEST },
    }),
    error: /^automation_policy_blocked/,
    escalations: 0,
    name: "automation policy",
  },
  {
    build: (park) => ({
      extra: {
        readinessChecker: async () => {
          await park();
          return { ready: false, reason: "required tool is missing" };
        },
      },
    }),
    error: /^not_ready:/,
    escalations: 0,
    name: "readiness",
  },
  {
    build: (park) => ({
      extra: {
        isNeedsHuman: () => true,
        readinessChecker: async () => {
          await park();
          return { ready: true };
        },
      },
    }),
    error: /^needs_human_attention/,
    escalations: 1,
    name: "needs-human",
  },
];

for (const gateCase of GATE_CASES) {
  for (const how of ["stop", "disable"] as const) {
    test(`${gateCase.name} gate: ${how === "stop" ? "stop()" : "a disable"} while it is pending records no skip, and the next valid tick announces it once`, HANG_GUARD, async (t) => {
      const entered = deferred<void>();
      const gate = deferred<void>();
      const announced = deferred<void>();
      const row = { enabled: true };
      const escalations: EscalationInfo[] = [];
      const { extra, schedule } = gateCase.build(async () => {
        entered.resolve();
        await gate.promise;
      });
      const { completed, scheduler } = directScheduler(
        UNUSED_CONNECTOR,
        buildStore(() => row),
        {
          ...extra,
          onHumanRequiredStateEscalation: (info) => {
            escalations.push(info);
          },
          onRunComplete: () => announced.resolve(),
        },
        schedule
      );
      t.after(() => scheduler.stop());

      scheduler.start();
      await entered.promise;
      if (how === "stop") {
        scheduler.stop();
      } else {
        row.enabled = false;
      }
      gate.resolve();
      await drain();

      assert.deepEqual(
        completed.map((record) => record.error),
        [],
        "a dispatch that is no longer valid records no skip"
      );
      assert.deepEqual(escalations, [], "a dispatch that is no longer valid raises no escalation");

      // Valid again. The dropped decision marked nothing as announced, so the next
      // tick announces it, exactly once.
      row.enabled = true;
      scheduler.stop();
      scheduler.start();
      await eventOrQuiet(announced.promise);

      assert.equal(completed.length, 1, "the skip is announced once");
      assert.match(completed[0]?.error ?? "", gateCase.error);
      assert.equal(escalations.length, gateCase.escalations);
    });
  }
}

// ── grant-state gate ───────────────────────────────────────────────────────

// One interval of the schedule below; the clock is moved by exactly this much.
const INTERVAL_MS = 60_000;

for (const how of ["stop", "disable"] as const) {
  test(`an exhausted single_use grant: ${how === "stop" ? "stop()" : "a disable"} before its skip is committed records nothing, and the next valid tick records it`, HANG_GUARD, async (t) => {
    initDb(":memory:");
    // One clock for the whole test: a second tick is due one interval after the
    // run that consumed the grant, and the interval timer and the dispatch
    // cadence both follow this clock.
    mock.timers.enable({ apis: ["Date", "setInterval"], now: Date.now() });
    t.after(() => mock.timers.reset());
    const connector = writeConnector(t, "succeed");
    const grantConsumed = deferred<void>();
    const readEntered = deferred<void>();
    const readGate = deferred<void>();
    const skipRecorded = deferred<void>();
    let row: ScheduleRow = { enabled: true };
    let parkNextRead = false;
    const { completed, scheduler } = directScheduler(
      connector.connectorPath,
      buildStore(undefined, {
        getSchedule: async () => {
          if (parkNextRead) {
            parkNextRead = false;
            readEntered.resolve();
            await readGate.promise;
          }
          return row;
        },
      }),
      {
        onRunComplete: (record) => {
          if (record.status === "succeeded") {
            grantConsumed.resolve();
          }
          if (record.status === "skipped") {
            skipRecorded.resolve();
          }
        },
      },
      { grantAccessMode: "single_use", intervalMs: INTERVAL_MS }
    );
    t.after(() => scheduler.stop());
    t.after(() => closeDb());

    scheduler.start();
    await grantConsumed.promise;
    await drain();
    assert.equal(connector.starts(), 1);

    // The second tick finds the grant exhausted and must validate its skip: it
    // parks on the schedule read, and nothing is recorded meanwhile.
    parkNextRead = true;
    mock.timers.tick(INTERVAL_MS);
    await Promise.race([readEntered.promise, skipRecorded.promise]);
    assert.deepEqual(
      completed.map((record) => record.status),
      ["succeeded"],
      "an exhausted-grant skip waits for the dispatch to be validated"
    );
    if (how === "stop") {
      scheduler.stop();
    } else {
      row = { enabled: false };
    }
    readGate.resolve();
    await drain();

    assert.deepEqual(
      completed.map((record) => record.status),
      ["succeeded"],
      "an exhausted-grant skip is a side effect of the dispatch and needs it to be valid"
    );

    row = { enabled: true };
    if (how === "stop") {
      scheduler.start();
    } else {
      mock.timers.tick(INTERVAL_MS);
    }
    await eventOrQuiet(skipRecorded.promise);

    assert.deepEqual(
      completed.map((record) => record.status),
      ["succeeded", "skipped"]
    );
    assert.equal(completed[1]?.error, "single_use grant already consumed");
    assert.equal(connector.starts(), 1, "the exhausted grant never launches the connector again");
  });
}

// ── pre-run gates and governor: a decision holds its effects ───────────────

function gateHarness(
  inputs: {
    attention?: UnresolvedAttentionEvidence | null;
    needsHuman?: boolean;
    readiness?: SchedulerReadinessResult;
  } = {}
) {
  const runtime: PreRunGateRuntimeState = {
    disabledGrantFailures: new Map(),
    exhaustedGrants: new Set(),
    notifiedAttentionSkips: new Map(),
    notifiedDisabledGrantFailures: new Set(),
    notifiedNeedsHumanSkips: new Set(),
    notifiedNotReadySkips: new Map(),
  };
  const records: RunRecord[] = [];
  const escalations: Array<{ info: Parameters<DispatchEscalationHandler>[0]; signal: AbortSignal | undefined }> = [];
  const gate = createPreRunGate({
    hasUnresolvedAttention: async () => inputs.attention ?? null,
    isNeedsHuman: () => inputs.needsHuman === true,
    onHumanRequiredStateEscalation: (info, signal) => {
      escalations.push({ info, signal });
    },
    readinessChecker: async () => inputs.readiness ?? { ready: true },
    recordAndNotify: (record) => {
      records.push(record);
      return record;
    },
    runtime,
  });
  return { escalations, gate, records, runtime };
}

function expectEnding(decision: GateDecision, kind: EndingGateDecision["kind"]): EndingGateDecision {
  if (decision.kind === "proceed" || decision.kind !== kind) {
    assert.fail(`expected a ${kind} decision, got ${decision.kind}`);
  }
  return decision;
}

function expectSkip(decision: GateDecision): Extract<GateDecision, { kind: "skip" }> {
  const ending = expectEnding(decision, "skip");
  if (ending.kind !== "skip") {
    throw new Error("unreachable");
  }
  return ending;
}

const KEY = INSTANCE_ID;

test("a gate decision holds its record, announce-once mark and escalation until it is committed", async (t) => {
  await t.test("unresolved attention", async () => {
    const h = gateHarness({ attention: { key: "attention-1", reason: "owner_input" } });
    const skip = expectSkip(await h.gate.gateAttention(CONNECTOR_ID, INSTANCE_ID, KEY));
    assert.deepEqual(h.records, []);
    assert.equal(h.runtime.notifiedAttentionSkips.size, 0);
    // A decision that is dropped leaves no trace, so deciding again is not silent.
    expectSkip(await h.gate.gateAttention(CONNECTOR_ID, INSTANCE_ID, KEY));

    const record = skip.commit();
    assert.deepEqual(h.records, [record]);
    assert.equal(h.runtime.notifiedAttentionSkips.get(KEY), "attention-1");
    expectEnding(await h.gate.gateAttention(CONNECTOR_ID, INSTANCE_ID, KEY), "silent");
  });

  await t.test("automation policy", () => {
    const h = gateHarness();
    const blocked = projectRunAutomationPolicy({
      refreshPolicy: { background_safe: false, recommended_mode: "automatic" },
      triggerKind: "scheduled",
    });
    const skip = expectSkip(h.gate.gateAutomationPolicy(CONNECTOR_ID, INSTANCE_ID, KEY, blocked));
    assert.deepEqual(h.records, []);
    assert.equal(h.runtime.notifiedNotReadySkips.size, 0);
    expectSkip(h.gate.gateAutomationPolicy(CONNECTOR_ID, INSTANCE_ID, KEY, blocked));

    const record = skip.commit();
    assert.deepEqual(h.records, [record]);
    assert.equal(h.runtime.notifiedNotReadySkips.size, 1);
    expectEnding(h.gate.gateAutomationPolicy(CONNECTOR_ID, INSTANCE_ID, KEY, blocked), "silent");
  });

  await t.test("readiness", async () => {
    const h = gateHarness({ readiness: { ready: false, reason: "required tool is missing" } });
    const schedule = buildConnectorSchedule(UNUSED_CONNECTOR);
    const skip = expectSkip(await h.gate.decideNotReady(schedule));
    assert.deepEqual(h.records, []);
    assert.equal(h.runtime.notifiedNotReadySkips.size, 0);
    expectSkip(await h.gate.decideNotReady(schedule));

    const record = skip.commit();
    assert.deepEqual(h.records, [record]);
    assert.equal(h.runtime.notifiedNotReadySkips.size, 1);
    expectEnding(await h.gate.decideNotReady(schedule), "silent");
  });

  await t.test("needs-human", () => {
    const h = gateHarness({ needsHuman: true });
    const signal = new AbortController().signal;
    const skip = expectSkip(h.gate.gateNeedsHuman(CONNECTOR_ID, INSTANCE_ID, KEY, signal));
    assert.deepEqual(h.records, []);
    assert.equal(h.escalations.length, 0);
    assert.equal(h.runtime.notifiedNeedsHumanSkips.size, 0);
    expectSkip(h.gate.gateNeedsHuman(CONNECTOR_ID, INSTANCE_ID, KEY, signal));

    const record = skip.commit();
    assert.deepEqual(h.records, [record]);
    assert.equal(h.escalations.length, 1);
    assert.equal(h.escalations[0]?.info.reason, "needs_attention");
    assert.equal(h.runtime.notifiedNeedsHumanSkips.has(KEY), true);
    expectEnding(h.gate.gateNeedsHuman(CONNECTOR_ID, INSTANCE_ID, KEY, signal), "silent");
  });

  await t.test("exhausted single_use grant", () => {
    const h = gateHarness();
    h.runtime.exhaustedGrants.add(INSTANCE_ID);
    const skip = expectSkip(h.gate.gateGrantState(CONNECTOR_ID, INSTANCE_ID, "single_use"));
    assert.deepEqual(h.records, []);
    const record = skip.commit();
    assert.deepEqual(h.records, [record]);
    assert.equal(record.error, "single_use grant already consumed");
  });

  await t.test("disabled grant", () => {
    const h = gateHarness();
    h.runtime.disabledGrantFailures.set(INSTANCE_ID, "grant_revoked");
    const skip = expectSkip(h.gate.gateGrantState(CONNECTOR_ID, INSTANCE_ID, "continuous"));
    assert.deepEqual(h.records, []);
    assert.equal(h.runtime.notifiedDisabledGrantFailures.size, 0);
    expectSkip(h.gate.gateGrantState(CONNECTOR_ID, INSTANCE_ID, "continuous"));

    const record = skip.commit();
    assert.deepEqual(h.records, [record]);
    assert.equal(h.runtime.notifiedDisabledGrantFailures.has(INSTANCE_ID), true);
    expectEnding(h.gate.gateGrantState(CONNECTOR_ID, INSTANCE_ID, "continuous"), "silent");
  });
});

test("the needs-human escalation carries the signal the preflight was given, and invents none", async () => {
  const schedule = buildConnectorSchedule(UNUSED_CONNECTOR);
  const policy = projectRunAutomationPolicy({ refreshPolicy: null, triggerKind: "scheduled" });

  const withSignal = gateHarness({ needsHuman: true });
  const signal = new AbortController().signal;
  expectSkip(await withSignal.gate.runAutomaticPreflight(schedule, KEY, policy, signal)).commit();
  assert.equal(withSignal.escalations.length, 1);
  assert.equal(withSignal.escalations[0]?.signal, signal, "bound to the dispatch's own signal");

  const withoutSignal = gateHarness({ needsHuman: true });
  expectSkip(await withoutSignal.gate.runAutomaticPreflight(schedule, KEY, policy)).commit();
  assert.equal(withoutSignal.escalations.length, 1);
  assert.equal(withoutSignal.escalations[0]?.signal, undefined, "no signal is substituted for a missing one");
});

// ── governor: announcements and the gave_up escalation ─────────────────────

function failedRun(index: number): RunRecord {
  const startedAt = Date.now() - 3_600_000 + index * 1000;
  return {
    attempt: 1,
    checkpointSummary: { commit_status: "not_committed" },
    completedAt: new Date(startedAt + 500).toISOString(),
    connectorError: { code: "something_else", message: "the connector failed", retryable: true },
    connectorId: CONNECTOR_ID,
    connectorInstanceId: INSTANCE_ID,
    knownGaps: [],
    recordsEmitted: 0,
    source: { id: CONNECTOR_ID, kind: "connector" },
    startedAt: new Date(startedAt).toISOString(),
    status: "failed",
    terminalReason: "connector_reported_failed",
  };
}

function failures(count: number): RunRecord[] {
  return Array.from({ length: count }, (_, index) => failedRun(index));
}

function storedFailures(count: number): SchedulerRunHistoryRecord[] {
  return failures(count).map((run, index) => ({
    attempt: run.attempt,
    checkpointSummary: run.checkpointSummary,
    completedAt: run.completedAt,
    connectorError: run.connectorError ? { ...run.connectorError } : null,
    connectorId: run.connectorId,
    connectorInstanceId: INSTANCE_ID,
    failureReason: null,
    knownGaps: [],
    recordsEmitted: 0,
    reportedRecordsEmitted: null,
    runId: null,
    source: { ...run.source },
    startedAt: run.startedAt,
    status: run.status,
    terminalReason: run.terminalReason ?? null,
    traceId: `trace-${index}`,
  }));
}

function governorHarness(history: RunRecord[]) {
  const runtime: DispatchGovernorRuntimeState = {
    announcedBackoffClass: new Map(),
    announcedBlockedClass: new Map(),
    history,
    lastRunTime: new Map(),
    notifiedCooldownIdentity: new Map(),
  };
  const escalations: Array<{ info: Parameters<DispatchEscalationHandler>[0]; signal: AbortSignal | undefined }> = [];
  const governor = createDispatchGovernor({
    getForwardEvidenceDebt: async () => false,
    getLastSuccessfulRunAt: async () => null,
    getNonPressureRecoverableCount: async () => 0,
    getSourcePressureGaps: async () => [],
    onHumanRequiredStateEscalation: (info, signal) => {
      escalations.push({ info, signal });
    },
    runtime,
  });
  return { escalations, governor, runtime };
}

function errorKinds(records: readonly RunRecord[]): Array<string | undefined> {
  return records.map((record) => record.error?.split(":")[0]);
}

const BACKOFF_KINDS = ["schedule.back_off.started", "scheduler_backoff_applied"];
const BLOCKED_KINDS = ["schedule.back_off.started", "schedule.gave_up", "scheduler_backoff_applied"];

test("a governor tick marks its announce-once cells and raises its escalation only when committed", async () => {
  const h = governorHarness(failures(BLOCKED_PROMOTION_THRESHOLD));
  const schedule = buildConnectorSchedule(UNUSED_CONNECTOR);
  const signal = new AbortController().signal;

  const tick = await h.governor.evaluateBackoffDispatch(schedule, Date.now(), signal);
  assert.deepEqual(
    errorKinds([...tick.eventsToEmit, ...(tick.skipToEmit ? [tick.skipToEmit] : [])]),
    BLOCKED_KINDS,
    "the evaluation previews what committing would emit"
  );
  assert.equal(tick.eligible, false, "a blocked connector is not dispatched");
  assert.equal(h.runtime.announcedBackoffClass.size, 0, "evaluating marks nothing");
  assert.equal(h.runtime.announcedBlockedClass.size, 0, "evaluating marks nothing");
  assert.equal(h.escalations.length, 0, "evaluating raises nothing");

  const committed = tick.commit();
  assert.deepEqual(errorKinds([...committed.eventsToEmit, ...(committed.skipToEmit ? [committed.skipToEmit] : [])]), BLOCKED_KINDS);
  assert.equal(h.runtime.announcedBackoffClass.size, 1);
  assert.equal(h.runtime.announcedBlockedClass.size, 1);
  assert.equal(h.escalations.length, 1);
  assert.equal(h.escalations[0]?.info.reason, "blocked");
  assert.equal(h.escalations[0]?.info.connectorInstanceId, INSTANCE_ID);
  assert.equal(h.escalations[0]?.signal, signal, "bound to the dispatch's own signal");

  const next = await h.governor.evaluateBackoffDispatch(schedule, Date.now(), signal);
  assert.deepEqual(next.eventsToEmit, [], "an announced streak is not announced again");
  assert.equal(next.skipToEmit, null);
});

test("a governor tick evaluated without a signal passes none on", async () => {
  const h = governorHarness(failures(BLOCKED_PROMOTION_THRESHOLD));
  const tick = await h.governor.evaluateBackoffDispatch(buildConnectorSchedule(UNUSED_CONNECTOR), Date.now());
  tick.commit();
  assert.equal(h.escalations.length, 1);
  assert.equal(h.escalations[0]?.signal, undefined, "no signal is substituted for a missing one");
});

test("two overlapping governor ticks announce a streak once: the cells are checked and marked at commit", async () => {
  const h = governorHarness(failures(BLOCKED_PROMOTION_THRESHOLD));
  const schedule = buildConnectorSchedule(UNUSED_CONNECTOR);
  const first = await h.governor.evaluateBackoffDispatch(schedule, Date.now());
  const second = await h.governor.evaluateBackoffDispatch(schedule, Date.now());
  assert.ok(first.eventsToEmit.length > 0 && second.eventsToEmit.length > 0, "both previews would announce");

  const firstCommit = first.commit();
  const secondCommit = second.commit();

  assert.deepEqual(errorKinds([...firstCommit.eventsToEmit]), ["schedule.back_off.started", "schedule.gave_up"]);
  assert.deepEqual(secondCommit.eventsToEmit, [], "the second tick finds the streak already announced");
  assert.equal(secondCommit.skipToEmit, null);
  assert.equal(h.escalations.length, 1, "one escalation for one streak");
});

for (const scenario of [
  { announces: BACKOFF_KINDS, escalations: 0, failures: DEFAULT_BACKOFF_THRESHOLD, name: "back-off" },
  { announces: BLOCKED_KINDS, escalations: 1, failures: BLOCKED_PROMOTION_THRESHOLD, name: "gave_up" },
] as const) {
  for (const how of ["stop", "disable"] as const) {
    test(`governor ${scenario.name}: ${how === "stop" ? "stop()" : "a disable"} before the announcement is emitted drops it and marks nothing, and the next valid tick announces it once`, HANG_GUARD, async (t) => {
      const readEntered = deferred<void>();
      const readGate = deferred<void>();
      const announced = deferred<void>();
      let row: ScheduleRow = { enabled: true };
      let parkRead = true;
      const escalations: EscalationInfo[] = [];
      const { completed, scheduler } = directScheduler(
        UNUSED_CONNECTOR,
        buildStore(undefined, {
          getSchedule: async () => {
            if (parkRead) {
              parkRead = false;
              readEntered.resolve();
              await readGate.promise;
            }
            return row;
          },
          listRunHistory: () => storedFailures(scenario.failures),
        }),
        {
          onHumanRequiredStateEscalation: (info) => {
            escalations.push(info);
          },
          onRunComplete: () => announced.resolve(),
        }
      );
      t.after(() => scheduler.stop());

      // The first tick has something to announce, so it validates the dispatch
      // with one schedule read, which stays pending while the owner acts.
      scheduler.start();
      await Promise.race([readEntered.promise, announced.promise]);
      if (how === "stop") {
        scheduler.stop();
      } else {
        row = { enabled: false };
      }
      readGate.resolve();
      await drain();

      assert.deepEqual(errorKinds(completed), [], "a dispatch that is no longer valid announces nothing");
      assert.deepEqual(escalations, [], "a dispatch that is no longer valid raises no escalation");

      row = { enabled: true };
      scheduler.stop();
      scheduler.start();
      await eventOrQuiet(announced.promise);

      assert.deepEqual(errorKinds(completed), scenario.announces, "the announcement was not consumed by the dropped tick");
      assert.equal(escalations.length, scenario.escalations);

      // Announced now, so a further tick stays quiet.
      scheduler.stop();
      scheduler.start();
      await drain();
      assert.deepEqual(errorKinds(completed), scenario.announces);
      assert.equal(escalations.length, scenario.escalations);
    });
  }
}

// ── escalations are bound to the dispatch that raised them ─────────────────

const BLOCKED_INFO = { connectorId: CONNECTOR_ID, connectorInstanceId: INSTANCE_ID, reason: "blocked" } as const;

test("an escalation is bound to the signal it is raised with, and dropped when there is none or it aborted", async () => {
  const delivered: EscalationInfo[] = [];
  const checks: Array<{ connectorInstanceId: string; signal: AbortSignal | undefined }> = [];
  const raise = bindDispatchEscalation(
    (info) => {
      delivered.push(info);
    },
    (signal, connectorInstanceId) => {
      checks.push({ connectorInstanceId, signal });
      return Promise.resolve(signal?.aborted !== true);
    }
  );

  raise(BLOCKED_INFO, undefined);
  assert.equal(delivered.length, 0, "no signal, nothing to bind to: dropped");

  const stale = new AbortController();
  stale.abort();
  raise(BLOCKED_INFO, stale.signal);
  assert.equal(delivered.length, 0, "an aborted epoch's escalation is stale: dropped");

  const live = new AbortController();
  raise(BLOCKED_INFO, live.signal);
  assert.equal(delivered.length, 1);
  const [info] = delivered;
  assert.equal(info?.reason, "blocked");
  assert.ok(info?.shouldDeliver, "an automatic dispatch's escalation carries a delivery guard");

  // The guard revalidates for THIS dispatch: its own signal, its own instance.
  assert.equal(await info.shouldDeliver(), true);
  live.abort();
  assert.equal(await info.shouldDeliver(), false, "the guard follows the bound signal, not the scheduler's current one");
  assert.deepEqual(
    checks.map((check) => [check.signal === live.signal, check.connectorInstanceId]),
    [
      [true, INSTANCE_ID],
      [true, INSTANCE_ID],
    ]
  );
});

// ── an abandoned gate cannot act ───────────────────────────────────────────

const ABANDON_CEILING_MS = 30;

for (const late of ["not-ready", "needs-human"] as const) {
  test(`a gate that resolves ${late === "not-ready" ? "not ready" : "needs-human"} after the liveness ceiling abandoned it records and escalates nothing`, HANG_GUARD, async (t) => {
    // The ceiling is advanced by hand; nothing waits on a real timer.
    mock.timers.enable({ apis: ["setTimeout"] });
    t.after(() => mock.timers.reset());
    const readinessEntered = deferred<void>();
    const readinessGate = deferred<void>();
    const wedged = deferred<void>();
    const escalations: EscalationInfo[] = [];
    const { completed, scheduler } = directScheduler(
      UNUSED_CONNECTOR,
      buildStore(() => ({ enabled: true })),
      {
        dispatchLivenessCeilingMs: ABANDON_CEILING_MS,
        isNeedsHuman: () => late === "needs-human",
        onHumanRequiredStateEscalation: (info) => {
          escalations.push(info);
        },
        onRunComplete: (record) => {
          if (record.failureReason === "scheduler_dispatch_wedged") {
            wedged.resolve();
          }
        },
        readinessChecker: async () => {
          readinessEntered.resolve();
          await readinessGate.promise;
          return late === "not-ready" ? { ready: false, reason: "late verdict" } : { ready: true };
        },
      }
    );
    t.after(() => scheduler.stop());

    scheduler.start();
    await readinessEntered.promise;
    mock.timers.tick(ABANDON_CEILING_MS);
    await wedged.promise;
    // The dispatch has given up on the gate. It resolves anyway.
    readinessGate.resolve();
    await drain();

    assert.deepEqual(
      completed.map((record) => record.failureReason),
      ["scheduler_dispatch_wedged"],
      "only the wedge is recorded: the abandoned gate's late decision is never committed"
    );
    assert.deepEqual(escalations, []);
  });
}

// ── the schedule read is bounded by its own short deadline ─────────────────

// A stuck schedule read holds the dispatch's lease and its key, so it must be
// given up on within a minute. This is a fixed bound, not the production
// constant: a test that ticked the constant could not notice it growing.
const READ_GIVE_UP_BOUND_MS = 60_000;

test("a schedule read that never settles after the lease drops the dispatch at the read deadline, not the liveness ceiling", HANG_GUARD, async (t) => {
  initDb(":memory:");
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());
  const connector = writeConnector(t, "succeed");
  const readEntered = deferred<void>();
  let leased = false;
  let leaseReleased = false;
  const { completed, scheduler } = directScheduler(
    connector.connectorPath,
    buildStore(undefined, {
      deleteActiveRun: () => {
        leaseReleased = true;
      },
      getSchedule: async () => {
        if (leased) {
          readEntered.resolve();
          await new Promise<never>(() => undefined);
        }
        return { enabled: true };
      },
      upsertActiveRun: () => {
        leased = true;
        return true;
      },
    })
  );
  t.after(() => scheduler.stop());
  t.after(() => closeDb());

  scheduler.start();
  await readEntered.promise;
  await drain();
  assert.equal(leaseReleased, false, "the dispatch holds its lease while the read is pending");

  // The default liveness ceiling is 30 minutes. The read has its own, far
  // shorter, deadline: a minute on the clock must free the lease.
  mock.timers.tick(READ_GIVE_UP_BOUND_MS);
  await drain();

  assert.equal(leaseReleased, true, "the lease is released within a minute, not at the liveness ceiling");
  assert.equal(connector.starts(), 0, "a dispatch whose revalidation timed out starts no connector");
  assert.deepEqual(completed, []);
});

test("a schedule read that never settles while a gate skip is validated drops the skip at the read deadline and frees the key", HANG_GUARD, async (t) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());
  const readEntered = deferred<void>();
  const recorded = deferred<void>();
  const escalations: EscalationInfo[] = [];
  let hang = true;
  let readinessChecks = 0;
  const { completed, scheduler } = directScheduler(
    UNUSED_CONNECTOR,
    buildStore(undefined, {
      getSchedule: async () => {
        if (hang) {
          readEntered.resolve();
          await new Promise<never>(() => undefined);
        }
        return { enabled: true };
      },
    }),
    {
      isNeedsHuman: () => true,
      onHumanRequiredStateEscalation: (info) => {
        escalations.push(info);
      },
      onRunComplete: () => recorded.resolve(),
      readinessChecker: async () => {
        readinessChecks += 1;
        return { ready: true };
      },
    }
  );
  t.after(() => scheduler.stop());

  scheduler.start();
  await Promise.race([readEntered.promise, recorded.promise]);
  await drain();
  assert.equal(readinessChecks, 1);
  assert.deepEqual(completed, [], "the skip waits for the dispatch to be validated");

  mock.timers.tick(READ_GIVE_UP_BOUND_MS);
  await drain();
  assert.deepEqual(completed, [], "a skip whose validation timed out is not recorded");
  assert.deepEqual(escalations, []);

  // The key was freed, so a later tick dispatches it again.
  hang = false;
  scheduler.stop();
  scheduler.start();
  await drain();
  assert.equal(readinessChecks, 2, "the key can be dispatched again after the timed-out validation");
  assert.equal(completed.length, 1);
  assert.equal(escalations.length, 1);
});
