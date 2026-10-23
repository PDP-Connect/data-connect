// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

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
