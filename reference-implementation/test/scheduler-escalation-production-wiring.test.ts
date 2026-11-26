// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// The scheduler's escalation push, through the wiring production builds.
//
// `startServer` builds its scheduler with `createReferenceSchedulerManager`
// (server/index.ts), not with the manager in server/scheduler-manager-factory.ts.
// `createEscalationDelivery`'s own tests (scheduler-stop-epoch-attempts.test.ts)
// drive the factory's consumer directly, so they cannot notice production
// installing a different consumer, or not honouring the `shouldDeliver` guard
// the scheduler hands it. These tests build the production manager over a real
// in-memory store and read the web-push subscription store: a push fan-out lists
// the owner's subscriptions, so an untouched store means no push was attempted.
//
// The seam is deterministic. The scheduler raises the needs-human escalation and
// then records the skip; recording a run logs "scheduled connector run
// completed" synchronously. At that moment the consumer is suspended in its
// verdict projection, so the logger hook stops the scheduler or disables the
// schedule exactly while the push is pending.
//
// The connection belongs to a subject other than the reference owner, so it has
// no summary projection and no verdict gates the push. That keeps the "none"
// control independent of verdict rendering: it proves the push is reachable
// through this wiring, which makes the other two cases discriminating.

import assert from "node:assert/strict";
import test from "node:test";

import { closeDb, initDb } from "../server/db.ts";
import { createReferenceSchedulerManager } from "../server/index.ts";
import { getDefaultSchedulerStore } from "../server/stores/scheduler-store.ts";
import { CONNECTOR_ID, deferred, drain, HANG_GUARD, INSTANCE_ID, OWNER } from "./helpers/scheduler-stop-harness.ts";
import { seedBackgroundSafeConnection, seedEnabledSchedule } from "./helpers/seed-enabled-schedule.ts";

const CASES = [
  { name: "a valid escalation sends the push", pushes: 1, variant: "none" },
  { name: "stop() while the push's verdict projection is pending sends no push", pushes: 0, variant: "stop" },
  { name: "a disable while the push's verdict projection is pending sends no push", pushes: 0, variant: "disable" },
] as const;

for (const { name, pushes, variant } of CASES) {
  test(`production scheduler wiring: ${name}`, HANG_GUARD, async (t) => {
    initDb(":memory:");
    seedBackgroundSafeConnection(CONNECTOR_ID, INSTANCE_ID, OWNER);
    const store = getDefaultSchedulerStore();
    await seedEnabledSchedule(store, CONNECTOR_ID, INSTANCE_ID);

    const skipRecorded = deferred<void>();
    let manager!: ReturnType<typeof createReferenceSchedulerManager>;
    let pushesAttempted = 0;
    const noop = (): void => undefined;
    const logger = {
      debug: noop,
      error: noop,
      info: (fields: { status?: string }, message?: string) => {
        if (message === "scheduled connector run completed" && fields.status === "skipped") {
          // The consumer is now suspended in its verdict projection.
          if (variant === "stop") {
            manager.stop();
          } else if (variant === "disable") {
            store.setScheduleEnabled(INSTANCE_ID, false, new Date().toISOString());
          }
          skipRecorded.resolve();
        }
      },
      warn: noop,
    };
    manager = createReferenceSchedulerManager({
      connectorPathResolver: () => "/nonexistent/connector.mjs",
      // Needs-human, so the pre-run gate raises the escalation instead of launching.
      controller: {
        getActiveRun: () => null,
        isNeedsHuman: () => true,
        issueRuntimeOwnerToken: () => Promise.resolve("owner-token"),
        markNeedsHuman: noop,
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
        enabled: true,
        privateKey: "k",
        publicKey: "p",
        subject: "mailto:test@example.invalid",
        unavailableReason: null,
      },
      webPushSubscriptionStore: {
        listActiveRaw: () => {
          pushesAttempted += 1;
          return [];
        },
      } as never,
    });
    t.after(() => {
      manager.stop();
      closeDb();
    });

    await manager.start();
    await skipRecorded.promise;
    await drain();

    assert.equal(pushesAttempted, pushes);
  });
}
