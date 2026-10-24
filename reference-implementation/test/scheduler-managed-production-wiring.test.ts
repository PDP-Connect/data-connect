// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// The managed-run adapter production builds, under stop and disable.
//
// `startServer` builds its scheduler with `createReferenceSchedulerManager`
// (server/index.ts), and that manager carries its own copy of the adapter that
// routes a scheduled managed run through `controller.runNow`; the factory's copy
// (`createRunManagedConnectorViaController`) is tested in
// scheduler-stop-epoch-attempts.test.ts. Both feed the same executor path, so
// both must leave the same trace: nothing, when the controller ends without
// having started a run and the dispatch was invalidated while it was pending.
//
// The production manager runs over a real in-memory store. The controller is a
// stub whose `runNow` is the pending call; the logger hook counts the records the
// scheduler completes ("scheduled connector run completed"), and the last-run
// table is read back for the cadence stamp.

import assert from "node:assert/strict";
import test from "node:test";

import { closeDb, initDb } from "../server/db.ts";
import { createReferenceSchedulerManager } from "../server/index.ts";
import { getDefaultSchedulerStore } from "../server/stores/scheduler-store.ts";
import {
  CONNECTOR_ID,
  deferred,
  drain,
  eventOrQuiet,
  HANG_GUARD,
  INSTANCE_ID,
  OWNER,
} from "./helpers/scheduler-stop-harness.ts";
import { seedBackgroundSafeConnection, seedEnabledSchedule } from "./helpers/seed-enabled-schedule.ts";

const noop = (): void => undefined;

interface Scenario {
  /** How the pending `controller.runNow` ends. */
  readonly ending: "rejection" | "surface_failed";
  readonly how: "disable" | "none" | "stop";
}

async function runScenario(t: import("node:test").TestContext, { ending, how }: Scenario) {
  initDb(":memory:");
  seedBackgroundSafeConnection(CONNECTOR_ID, INSTANCE_ID, OWNER);
  const store = getDefaultSchedulerStore();
  await seedEnabledSchedule(store, CONNECTOR_ID, INSTANCE_ID);

  const runNowEntered = deferred<void>();
  const runNowGate = deferred<void>();
  const completed = deferred<void>();
  const statuses: string[] = [];
  const logger = {
    debug: noop,
    error: noop,
    info: (fields: { status?: string }, message?: string) => {
      if (message === "scheduled connector run completed") {
        statuses.push(String(fields.status));
        completed.resolve();
      }
    },
    warn: noop,
  };
  const manager = createReferenceSchedulerManager({
    connectorPathResolver: () => "/nonexistent/connector.mjs",
    controller: {
      awaitRun: () => Promise.resolve("succeeded"),
      browserSurfaceLeaseManager: { isManagedConnector: () => true },
      getActiveRun: () => null,
      isNeedsHuman: () => false,
      issueRuntimeOwnerToken: () => Promise.resolve("owner-token"),
      markNeedsHuman: noop,
      runNow: async () => {
        runNowEntered.resolve();
        await runNowGate.promise;
        if (ending === "rejection") {
          throw new Error("surface acquisition failed");
        }
        return { run_id: "run_surface", status: "surface_failed", trace_id: "trace" };
      },
    } as never,
    logger: logger as never,
    ownerSubjectId: OWNER,
    runtimeContext: {
      referenceBaseUrl: null,
      rsUrl: "http://localhost.invalid",
      selfCallReferenceBaseUrl: null,
      selfCallRsUrl: "http://localhost.invalid",
    },
    schedulerStore: store,
    webPushConfig: {
      enabled: false,
      privateKey: null,
      publicKey: null,
      subject: "mailto:test@example.invalid",
      unavailableReason: "not used by this test",
    },
    webPushSubscriptionStore: { listActiveRaw: () => [] } as never,
  });
  t.after(() => {
    manager.stop();
    closeDb();
  });

  await manager.start();
  await runNowEntered.promise;
  if (how === "stop") {
    manager.stop();
  } else if (how === "disable") {
    store.setScheduleEnabled(INSTANCE_ID, false, new Date().toISOString());
  }
  runNowGate.resolve();
  await eventOrQuiet(completed.promise);
  await drain();
  const stamped = (await store.listLastRunTimes()).length;
  return { stamped, statuses };
}

for (const ending of ["surface_failed", "rejection"] as const) {
  test(`production managed adapter: a controller.runNow ending in ${ending === "rejection" ? "a rejection" : "surface_failed"} is recorded while the dispatch is valid`, HANG_GUARD, async (t) => {
    const { stamped, statuses } = await runScenario(t, { ending, how: "none" });
    assert.deepEqual(statuses, [ending === "rejection" ? "failed" : "skipped"]);
    assert.equal(stamped, ending === "rejection" ? 1 : 0, "only a controller failure advances the cadence");
  });

  for (const how of ["stop", "disable"] as const) {
    test(`production managed adapter: a controller.runNow ending in ${ending === "rejection" ? "a rejection" : "surface_failed"} after ${how === "stop" ? "stop()" : "a disable"} records nothing and does not advance the cadence`, HANG_GUARD, async (t) => {
      const { stamped, statuses } = await runScenario(t, { ending, how });
      assert.deepEqual({ records: statuses, stamped }, { records: [], stamped: 0 });
    });
  }
}
