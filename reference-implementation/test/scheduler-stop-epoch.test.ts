// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// A stopped or replaced scheduler must not launch a new automatic run.
//
// `createReferenceSchedulerManager.restart` stops the old scheduler on every
// schedule mutation, but a tick already awaiting the dispatch governor's
// source-pressure probe survived the stop and went on to launch its captured
// schedule, so a schedule the owner had just disabled still ran once.
//
// These tests pause the automatic-dispatch path at each await gap (governor
// probe, readiness preflight, credential resolution, state load), stop the
// scheduler while paused, release the gap, and assert nothing is launched and
// no run record is created. They also pin the second defence: final admission
// re-reads the schedule's CURRENT enabled flag from the store, so a disable is
// honoured even when a stale scheduler instance is not stopped.

import assert from "node:assert/strict";
import test from "node:test";

import { createScheduler } from "../runtime/scheduler.ts";
import type { RunManagedConnectorViaController, RunRecord } from "../runtime/scheduler-domain-types.ts";

const CONNECTOR_ID = "chatgpt";
const INSTANCE_ID = "cin_chatgpt_stop_epoch";
const OWNER = "owner-stop-epoch";

const BACKGROUND_SAFE_MANIFEST = {
  capabilities: {
    refresh_policy: { background_safe: true, recommended_mode: "automatic" },
  },
  streams: [{ name: "items" }],
};

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

// Lets already-resolved continuations (and the dispatch they drive) run to
// completion without a timed wait.
async function drain(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: each turn must finish before the next
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

type ScheduleRow = { enabled: boolean } | null;

function buildStore(getRow?: () => ScheduleRow) {
  const anchor = Date.now() - 10 * 60_000;
  return {
    appendRunHistory: () => {
      // no-op
    },
    deleteActiveRun: () => {
      // no-op
    },
    ...(getRow
      ? {
          getSchedule: () => {
            const row = getRow();
            return row
              ? {
                  connector_id: CONNECTOR_ID,
                  connector_instance_id: INSTANCE_ID,
                  created_at: new Date(anchor).toISOString(),
                  enabled: row.enabled,
                  interval_seconds: 60,
                  jitter_seconds: 0,
                  updated_at: new Date(anchor).toISOString(),
                }
              : null;
          },
        }
      : {}),
    listLastRunTimes: () => [
      {
        connector_id: CONNECTOR_ID,
        connector_instance_id: INSTANCE_ID,
        last_run_time_ms: anchor,
        updated_at: new Date(anchor).toISOString(),
      },
    ],
    listRunHistory: () => [],
    upsertActiveRun: () => true,
    upsertLastRunTime: () => {
      // no-op
    },
  };
}

type Stage = "governor" | "preflight" | "credentials" | "state";

interface Harness {
  completed: RunRecord[];
  controllerCalls: string[];
  entered: Promise<void>;
  launched: Promise<void>;
  release: () => void;
  scheduler: ReturnType<typeof createScheduler>;
}

// Builds a scheduler whose automatic dispatch parks at `stage` until `release`.
function buildHarness(stage: Stage | null, store: ReturnType<typeof buildStore>): Harness {
  const entered = deferred<void>();
  const gate = deferred<void>();
  const launched = deferred<void>();
  const completed: RunRecord[] = [];
  const controllerCalls: string[] = [];

  const park = async (at: Stage): Promise<void> => {
    if (at !== stage) {
      return;
    }
    entered.resolve();
    await gate.promise;
  };

  const runManagedConnectorViaController: RunManagedConnectorViaController = (id) => {
    controllerCalls.push(id);
    launched.resolve();
    return { run_id: "run_stop_epoch_1", status: "succeeded", trace_id: "trace-stop-epoch" };
  };

  const scheduler = createScheduler({
    admitRunConnection: ({ connectorId, connectorInstanceId, ownerSubjectId }) =>
      Promise.resolve({
        connectorId,
        connectorInstanceId: connectorInstanceId ?? connectorId,
        ownerSubjectId: ownerSubjectId ?? OWNER,
      }),
    connectors: [
      {
        connectorId: CONNECTOR_ID,
        connectorInstanceId: INSTANCE_ID,
        connectorPath: "/nonexistent/connector.mjs",
        intervalMs: 60_000,
        manifest: BACKGROUND_SAFE_MANIFEST,
        maxRetries: 0,
        ownerSubjectId: OWNER,
        ownerToken: "owner-token",
      },
    ],
    getSourcePressureGaps: async () => {
      await park("governor");
      return [];
    },
    getState: async () => {
      await park("state");
      return null;
    },
    isManagedConnector: () => true,
    onInteraction: async () => ({ accepted: true, status: "cancelled" }),
    onRunComplete: (record) => completed.push(record),
    readinessChecker: async () => {
      await park("preflight");
      return { ready: true };
    },
    resolveStaticSecretRunEnv: async () => {
      await park("credentials");
      return null;
    },
    rsUrl: "http://localhost.invalid",
    runManagedConnectorViaController,
    schedulerStore: store,
  });

  return {
    completed,
    controllerCalls,
    entered: entered.promise,
    launched: launched.promise,
    release: () => gate.resolve(),
    scheduler,
  };
}

for (const stage of ["governor", "preflight", "credentials", "state"] as const) {
  test(`stop() while the dispatch is parked at ${stage} launches nothing`, async () => {
    const h = buildHarness(stage, buildStore());
    try {
      h.scheduler.start();
      await h.entered;
      assert.deepEqual(h.controllerCalls, [], "no run existed before stop");

      h.scheduler.stop();
      h.release();
      await drain();

      assert.deepEqual(h.controllerCalls, [], "a stopped scheduler must not call the controller");
      assert.deepEqual(h.completed, [], "a dropped dispatch must not record a run, skip or retry");
    } finally {
      h.scheduler.stop();
    }
  });
}

test("disable during a pending governor probe on a replaced scheduler launches nothing", async () => {
  let row: ScheduleRow = { enabled: true };
  const h = buildHarness(
    "governor",
    buildStore(() => row),
  );
  try {
    h.scheduler.start();
    await h.entered;

    // The owner disables the schedule; the manager's restart() stops the old
    // scheduler and builds a replacement that no longer contains the schedule.
    row = { enabled: false };
    h.scheduler.stop();
    h.release();
    await drain();

    assert.deepEqual(h.controllerCalls, []);
    assert.deepEqual(h.completed, []);
  } finally {
    h.scheduler.stop();
  }
});

test("final admission refuses a schedule disabled in the store even if the scheduler was never stopped", async () => {
  let row: ScheduleRow = { enabled: true };
  const h = buildHarness(
    "governor",
    buildStore(() => row),
  );
  try {
    h.scheduler.start();
    await h.entered;

    row = { enabled: false };
    h.release();
    await drain();

    assert.deepEqual(h.controllerCalls, [], "a stale instance must honour the current disabled flag");
    assert.deepEqual(h.completed, []);
  } finally {
    h.scheduler.stop();
  }
});

test("final admission refuses a schedule deleted from the store", async () => {
  let row: ScheduleRow = { enabled: true };
  const h = buildHarness(
    "governor",
    buildStore(() => row),
  );
  try {
    h.scheduler.start();
    await h.entered;

    row = null;
    h.release();
    await drain();

    assert.deepEqual(h.controllerCalls, []);
    assert.deepEqual(h.completed, []);
  } finally {
    h.scheduler.stop();
  }
});

test("a still-enabled schedule on a live scheduler still dispatches", async () => {
  const h = buildHarness(
    "governor",
    buildStore(() => ({ enabled: true })),
  );
  try {
    h.scheduler.start();
    await h.entered;
    h.release();
    await h.launched;

    assert.deepEqual(h.controllerCalls, [CONNECTOR_ID]);
  } finally {
    h.scheduler.stop();
  }
});

test("a stop then start dispatches on the new epoch but never on the stale one", async () => {
  const h = buildHarness(
    "governor",
    buildStore(() => ({ enabled: true })),
  );
  try {
    h.scheduler.start();
    await h.entered;
    h.scheduler.stop();
    h.release();
    await drain();
    assert.deepEqual(h.controllerCalls, [], "the pre-stop tick is dropped");

    h.scheduler.start();
    await h.launched;
    assert.deepEqual(h.controllerCalls, [CONNECTOR_ID], "the post-restart tick dispatches");
  } finally {
    h.scheduler.stop();
  }
});
