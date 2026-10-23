// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Shared deterministic hooks for the scheduler stop-epoch tests: deferred
// promises, an event-loop drain, and a scheduler store whose schedule row and
// durable active-run calls the test controls.

export const CONNECTOR_ID = "chatgpt";
export const INSTANCE_ID = "cin_chatgpt_stop_epoch";
export const OWNER = "owner-stop-epoch";

export const BACKGROUND_SAFE_MANIFEST = {
  capabilities: {
    refresh_policy: { background_safe: true, recommended_mode: "automatic" },
  },
  streams: [{ name: "items" }],
};

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

// Lets already-resolved continuations (and the dispatch they drive) run to
// completion without a timed wait.
export async function drain(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: each turn must finish before the next
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

export type ScheduleRow = { enabled: boolean } | null;

export interface StoreOverrides {
  deleteActiveRun?: () => void;
  getSchedule?: () => ScheduleRow | Promise<ScheduleRow>;
  upsertActiveRun?: () => boolean | Promise<boolean>;
  upsertLastRunTime?: () => void;
}

export function buildStore(getRow?: () => ScheduleRow, overrides: StoreOverrides = {}) {
  const anchor = Date.now() - 10 * 60_000;
  const read = overrides.getSchedule ?? getRow;
  return {
    appendRunHistory: () => {
      // no-op
    },
    deleteActiveRun: overrides.deleteActiveRun ?? (() => undefined),
    ...(read
      ? {
          getSchedule: async () => {
            const row = await read();
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
    upsertActiveRun: overrides.upsertActiveRun ?? (() => true),
    upsertLastRunTime: overrides.upsertLastRunTime ?? (() => undefined),
  };
}
