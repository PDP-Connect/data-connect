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
