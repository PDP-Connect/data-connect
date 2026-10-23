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

import { closeDb, getDb, initDb } from "../server/db.ts";
import { createReferenceSchedulerManager } from "../server/index.ts";
import { getDefaultSchedulerStore } from "../server/stores/scheduler-store.ts";
import { CONNECTOR_ID, deferred, drain, HANG_GUARD, INSTANCE_ID, OWNER } from "./helpers/scheduler-stop-harness.ts";
import { seedEnabledSchedule } from "./helpers/seed-enabled-schedule.ts";

const CREATED_AT = "2026-08-10T00:00:00.000Z";

function seedBackgroundSafeConnection(): void {
  const manifest = {
    capabilities: {
      public_listing: { tier: "supported" },
      refresh_policy: {
        background_safe: true,
        rationale: "Refreshes unattended in the background.",
        recommended_mode: "automatic",
      },
    },
    connector_id: CONNECTOR_ID,
    display_name: CONNECTOR_ID,
    protocol_version: "0.1.0",
    streams: [
      {
        name: "items",
        primary_key: "id",
        schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
      },
    ],
    version: "1.0.0",
  };
  getDb()
    .prepare("INSERT INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)")
    .run(CONNECTOR_ID, JSON.stringify(manifest), CREATED_AT);
  getDb()
    .prepare(
      `INSERT INTO connector_instances(
         connector_instance_id, owner_subject_id, connector_id, display_name, status,
         source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
       ) VALUES (?, ?, ?, ?, 'active', 'account', ?, '{}', ?, ?, NULL)`
    )
    .run(INSTANCE_ID, OWNER, CONNECTOR_ID, CONNECTOR_ID, INSTANCE_ID, CREATED_AT, CREATED_AT);
}

const CASES = [
  { name: "a valid escalation sends the push", pushes: 1, variant: "none" },
  { name: "stop() while the push's verdict projection is pending sends no push", pushes: 0, variant: "stop" },
  { name: "a disable while the push's verdict projection is pending sends no push", pushes: 0, variant: "disable" },
] as const;

for (const { name, pushes, variant } of CASES) {
  test(`production scheduler wiring: ${name}`, HANG_GUARD, async (t) => {
    initDb(":memory:");
    seedBackgroundSafeConnection();
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
