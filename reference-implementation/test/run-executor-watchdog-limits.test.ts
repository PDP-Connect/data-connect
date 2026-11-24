// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { createAttemptWatchdog } from "../runtime/scheduler/run-executor.ts";

const PHASE_BOUNDARY = { phase_boundary: "local_only_phase_started" };
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;
const SHORT_BUDGET_MS = 5;

function waitForAbort(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

// `setTimeout` cannot delay past 2^31 - 1 ms (Node fires it almost at once), and
// `budget * 4` can overflow to Infinity, which reads as "unbounded". A huge but
// finite budget must keep a real, finite ceiling.
for (const hugeBudget of [2 ** 30, 1e308]) {
  test(`a finite budget of ${String(hugeBudget)} ms arms timers no longer than the timer limit`, () => {
    const realSetTimeout = globalThis.setTimeout;
    const delays: number[] = [];
    const spy = mock.method(globalThis, "setTimeout", ((callback: () => void, ms?: number) => {
      delays.push(Number(ms));
      // Never let the test arm a real long timer.
      return realSetTimeout(callback, 60_000);
    }) as typeof setTimeout);
    const watchdog = createAttemptWatchdog(hugeBudget);
    try {
      watchdog.markProgress(PHASE_BOUNDARY);
      assert.ok(delays.length >= 2, "the primary timer and the local-only ceiling are both armed");
      for (const delay of delays) {
        assert.ok(
          Number.isFinite(delay) && delay <= MAX_TIMER_DELAY_MS,
          `armed delay ${delay} exceeds the timer limit`
        );
      }
      assert.equal(delays.at(-1), MAX_TIMER_DELAY_MS, "the local-only ceiling stays bounded at the limit");
    } finally {
      watchdog.clear();
      spy.mock.restore();
    }
  });
}

// A "watchdog suppressed" record is written when markProgress reports true.
// That must be true only when a timer was armed and could still have fired.
for (const optOut of [0, Number.POSITIVE_INFINITY]) {
  test(`a phase boundary with the opt-out budget ${String(optOut)} suppresses nothing`, () => {
    const watchdog = createAttemptWatchdog(optOut);
    try {
      assert.equal(watchdog.markProgress(PHASE_BOUNDARY), false);
    } finally {
      watchdog.clear();
    }
  });
}

test("a phase boundary arriving after the watchdog fired suppresses nothing", async () => {
  const watchdog = createAttemptWatchdog(SHORT_BUDGET_MS);
  try {
    await waitForAbort(watchdog.signal);
    assert.equal(watchdog.timedOut(), true);
    assert.equal(watchdog.markProgress(PHASE_BOUNDARY), false);
  } finally {
    watchdog.clear();
  }
});

test("a phase boundary arriving after an owner cancel suppresses nothing", () => {
  const watchdog = createAttemptWatchdog(60_000);
  try {
    watchdog.cancel();
    assert.equal(watchdog.markProgress(PHASE_BOUNDARY), false);
  } finally {
    watchdog.clear();
  }
});

test("a phase boundary on an armed watchdog latches exactly once", () => {
  const watchdog = createAttemptWatchdog(60_000);
  try {
    assert.equal(watchdog.markProgress(PHASE_BOUNDARY), true);
    assert.equal(watchdog.markProgress(PHASE_BOUNDARY), false);
  } finally {
    watchdog.clear();
  }
});
