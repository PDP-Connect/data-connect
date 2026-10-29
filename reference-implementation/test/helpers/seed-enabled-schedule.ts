// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { getDb } from "../../server/db.ts";
import type { SchedulerStore } from "../../server/stores/scheduler-store.ts";

// A scheduled launch re-reads the schedule's current `enabled` flag from the
// durable store at final admission, so a test that drives `createScheduler`
// against a real store must hold the enabled schedule it built the scheduler
// from, as production does.
export async function seedEnabledSchedule(
  store: Pick<SchedulerStore, "createSchedule">,
  connectorId: string,
  connectorInstanceId: string,
): Promise<void> {
  const now = new Date().toISOString();
  await store.createSchedule({
    connector_id: connectorId,
    connector_instance_id: connectorInstanceId,
    created_at: now,
    enabled: true,
    interval_seconds: 60,
    jitter_seconds: 0,
    updated_at: now,
  });
}

const CONNECTION_CREATED_AT = "2026-08-10T00:00:00.000Z";

// A background-safe connector row and an active connection to it, owned by
// `ownerSubjectId`, in the open database. The production scheduler manager
// admits a schedule through exactly these rows, so a test that builds it over
// a real in-memory store needs them.
export function seedBackgroundSafeConnection(
  connectorId: string,
  connectorInstanceId: string,
  ownerSubjectId: string
): void {
  const manifest = {
    capabilities: {
      public_listing: { tier: "supported" },
      refresh_policy: {
        background_safe: true,
        rationale: "Refreshes unattended in the background.",
        recommended_mode: "automatic",
      },
    },
    connector_id: connectorId,
    display_name: connectorId,
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
    .run(connectorId, JSON.stringify(manifest), CONNECTION_CREATED_AT);
  getDb()
    .prepare(
      `INSERT INTO connector_instances(
         connector_instance_id, owner_subject_id, connector_id, display_name, status,
         source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
       ) VALUES (?, ?, ?, ?, 'active', 'account', ?, '{}', ?, ?, NULL)`
    )
    .run(
      connectorInstanceId,
      ownerSubjectId,
      connectorId,
      connectorId,
      connectorInstanceId,
      CONNECTION_CREATED_AT,
      CONNECTION_CREATED_AT
    );
}
