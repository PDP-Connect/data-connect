// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { isScheduled, scheduleState } from "./schedule-words.ts";

const hourly = { effective_mode: "automatic", enabled: true, interval_seconds: 3600 } as const;

// F5: one answer to "is anything scheduled", read by every sentence.
test("a schedule is unknown, manual or scheduled; only scheduled promises a retry", () => {
  assert.deepEqual(scheduleState(undefined), { kind: "unknown" });
  assert.deepEqual(scheduleState(null), { kind: "manual" });
  assert.deepEqual(scheduleState({ ...hourly, effective_mode: "manual" }), { kind: "manual" });
  assert.deepEqual(scheduleState({ ...hourly, enabled: false }), { kind: "manual" });
  assert.deepEqual(scheduleState(hourly), { every: "every hour", kind: "scheduled" });
  assert.equal(isScheduled(hourly), true);
  assert.equal(isScheduled({ ...hourly, effective_mode: "manual" }), false);
  assert.equal(isScheduled(undefined), false);
});

// Round 8 (F1): a schedule that has not produced a sync for a long time must not read as if all is well.
test("an overdue schedule says what is true: it should check, but the last successful sync was long ago", async () => {
  const words = (await import("./schedule-words.ts")) as unknown as {
    overdueScheduleSentence?: (name: string, schedule: Record<string, unknown>, now: Date) => string | null;
  };
  const now = new Date("2026-12-10T12:00:00Z");
  const schedule = { effective_mode: "automatic", enabled: true, interval_seconds: 3600, last_successful_at: "2026-11-30T12:00:00Z", next_due_at: "2026-11-30T13:00:00Z" };
  assert.equal(words.overdueScheduleSentence?.("Steam", schedule, now), "It should check every hour, but the last successful sync was 10 days ago.");
  assert.equal(words.overdueScheduleSentence?.("Steam", { ...schedule, last_successful_at: "2026-12-10T11:30:00Z" }, now), null);
  assert.equal(words.overdueScheduleSentence?.("Steam", { ...schedule, last_successful_at: null }, now), null);
  assert.equal(words.overdueScheduleSentence?.("Steam", { ...schedule, effective_mode: "manual" }, now), null);
});

// The server fills last_successful_at from scheduler history only; a source last synced by hand has it null (round 9 verify).
test("an overdue schedule falls back to the page's own last-synced time when the server sent none", async () => {
  const { overdueScheduleSentence } = await import("./schedule-words.ts");
  const now = new Date("2026-12-10T12:00:00Z");
  const schedule = { active_run_id: null, effective_mode: "automatic", enabled: true, interval_seconds: 3600, last_successful_at: null } as never;
  assert.equal(overdueScheduleSentence("Steam", schedule, now, "2026-11-30T12:00:00Z"), "It should check every hour, but the last successful sync was 10 days ago.");
  assert.equal(overdueScheduleSentence("Steam", schedule, now, null), null);
});
