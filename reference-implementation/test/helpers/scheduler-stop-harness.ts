// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Shared deterministic hooks for the scheduler stop-epoch tests: deferred
// promises, an event-loop drain, and a scheduler store whose schedule row and
// durable active-run calls the test controls.

import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";

import { createScheduler } from "../../runtime/scheduler.ts";
import type { RunRecord } from "../../runtime/scheduler-domain-types.ts";
import type { SchedulerRunHistoryRecord } from "../../server/stores/scheduler-store.ts";

/**
 * Per-test timeout for tests that await a deferred the code under test must
 * resolve. A regression then fails the test instead of hanging the file. The
 * test must clean up with `t.after`, not `finally`: after a timeout the test
 * body never resumes, so a `finally` would not run and a live scheduler interval
 * would keep the process alive.
 */
export const HANG_GUARD_MS = 30_000;
export const HANG_GUARD = { timeout: HANG_GUARD_MS };

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

// Waits for `event`, but no longer than the event loop takes to go quiet. Use it
// where the test expects an effect that the code under test may wrongly not
// produce: the missing event then fails the next assertion by name, instead of
// holding the test until its HANG_GUARD timeout.
export async function eventOrQuiet(event: Promise<unknown>): Promise<void> {
  await Promise.race([event, drain()]);
  await drain();
}

export type ScheduleRow = { enabled: boolean } | null;

export interface StoreOverrides {
  deleteActiveRun?: () => void;
  getSchedule?: () => ScheduleRow | Promise<ScheduleRow>;
  listRunHistory?: () => readonly SchedulerRunHistoryRecord[];
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
    listRunHistory: overrides.listRunHistory ?? (() => []),
    upsertActiveRun: overrides.upsertActiveRun ?? (() => true),
    upsertLastRunTime: overrides.upsertLastRunTime ?? (() => undefined),
  };
}

// A real child connector. It appends a line to `startsPath` on START, so a start
// that must not happen is observable as a line, then either completes or crashes.
export function writeConnector(t: TestContext, behaviour: "succeed" | "crash") {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-stop-epoch-"));
  t.after(() => rmSync(dir, { force: true, recursive: true }));
  const connectorPath = join(dir, "connector.mjs");
  const startsPath = join(dir, "starts.log");
  writeFileSync(
    connectorPath,
    `
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  appendFileSync(${JSON.stringify(startsPath)}, 'start\\n', 'utf8');
  ${
    behaviour === "succeed"
      ? "process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 0 }) + '\\n'); rl.close();"
      : "process.exit(1);"
  }
});
`,
    "utf8"
  );
  chmodSync(connectorPath, 0o755);
  const starts = (): number =>
    existsSync(startsPath) ? readFileSync(startsPath, "utf8").split("\n").filter(Boolean).length : 0;
  return { connectorPath, starts };
}

export function admit(input: { connectorId: string; connectorInstanceId: string | null; ownerSubjectId: string | null }) {
  return Promise.resolve({
    connectorId: input.connectorId,
    connectorInstanceId: input.connectorInstanceId ?? input.connectorId,
    ownerSubjectId: input.ownerSubjectId ?? OWNER,
  });
}

export type SchedulerOptions = Parameters<typeof createScheduler>[0];
export type ScheduleSpec = SchedulerOptions["connectors"][number];

export function buildConnectorSchedule(connectorPath: string, overrides: Partial<ScheduleSpec> = {}): ScheduleSpec {
  return {
    connectorId: CONNECTOR_ID,
    connectorInstanceId: INSTANCE_ID,
    connectorPath,
    intervalMs: 60_000,
    manifest: BACKGROUND_SAFE_MANIFEST,
    maxRetries: 2,
    ownerSubjectId: OWNER,
    ownerToken: "owner-token",
    ...overrides,
  };
}

// A direct-route scheduler over `store`. `extra` overrides any scheduler option;
// `schedule` overrides the one schedule it runs. Every completed record is
// collected in `completed`; an `extra.onRunComplete` is called after it.
export function directScheduler(
  connectorPath: string,
  store: ReturnType<typeof buildStore>,
  extra: Partial<SchedulerOptions> = {},
  schedule: Partial<ScheduleSpec> = {}
) {
  const completed: RunRecord[] = [];
  const { onRunComplete, ...options } = extra;
  const scheduler = createScheduler({
    admitRunConnection: admit,
    connectors: [buildConnectorSchedule(connectorPath, schedule)],
    onInteraction: async () => ({ accepted: true, status: "cancelled" }),
    readinessChecker: async () => ({ ready: true }),
    rsUrl: "http://localhost.invalid",
    schedulerStore: store,
    ...options,
    onRunComplete: (record) => {
      completed.push(record);
      onRunComplete?.(record);
    },
  });
  return { completed, scheduler };
}
