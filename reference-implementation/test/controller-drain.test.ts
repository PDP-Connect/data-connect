// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Unit tests for `drainPromisesWithDeadline`, the graceful-shutdown drain
// primitive exported from runtime/controller.ts.
//
// The helper observes the *live* map size after the race, mirroring how
// the controller registers each in-flight run with a `.finally` that
// removes its entry. To exercise that contract realistically, each test
// wraps its promises with the same self-cleanup pattern.

import assert from "node:assert/strict";
import test from "node:test";

import { drainPromisesWithDeadline } from "../runtime/controller.ts";

function track(map: Map<string, Promise<unknown>>, id: string, promise: Promise<unknown>) {
  const wrapped = promise.finally(() => map.delete(id));
  map.set(id, wrapped);
  return wrapped;
}

test("drainPromisesWithDeadline: empty map returns zeros immediately", async () => {
  const result = await drainPromisesWithDeadline(new Map(), 1000);
  assert.deepEqual(result, { drained: 0, elapsedMs: 0, timedOut: 0 });
});

test("drainPromisesWithDeadline: all settle before deadline → drained=N, timedOut=0", async () => {
  const pending = new Map();
  track(pending, "a", new Promise((r) => setTimeout(r, 5)));
  track(pending, "b", new Promise((r) => setTimeout(r, 10)));
  track(pending, "c", Promise.resolve());

  const result = await drainPromisesWithDeadline(pending, 1000);
  assert.equal(result.drained, 3);
  assert.equal(result.timedOut, 0);
  assert.ok(result.elapsedMs < 1000);
  assert.equal(pending.size, 0);
});

test("drainPromisesWithDeadline: deadline expires with stragglers → counts split", async () => {
  // Use generous margins so the test isn't load-sensitive: fast resolves
  // at 30ms, deadline at 100ms, stragglers at 250ms. Under heavy parallel
  // load the timer queue can slip, but the relative ordering
  // fast(30) < deadline(100) < slow(250) is robust to >2x slowdown.
  //
  // The stragglers previously ran for 5_000ms with `.unref()`, on the theory
  // that unref'ing was enough to keep them from blocking anything. `.unref()`
  // only excuses a timer from blocking PROCESS exit -- it does not settle the
  // promise attached to it, and Node's test runner separately flags any
  // promise a test created that is still unsettled once the test's own run
  // has otherwise concluded (`cancelledByParent` / "Promise resolution is
  // still pending"), independent of whether the process itself could still
  // exit. A 5-second straggler reliably outlived that window. Explicitly
  // awaiting the stragglers below (after the assertions that need them still
  // pending) keeps the same behavior under test while letting every promise
  // this test creates actually settle before the test function returns.
  const pending = new Map();
  const fast = track(pending, "fast", new Promise((r) => setTimeout(r, 30)));
  const slow1 = track(pending, "slow1", new Promise((r) => setTimeout(r, 250)));
  const slow2 = track(pending, "slow2", new Promise((r) => setTimeout(r, 250)));

  const result = await drainPromisesWithDeadline(pending, 100);
  assert.equal(result.drained, 1, `expected 1 drained, got ${result.drained}; elapsed=${result.elapsedMs}`);
  assert.equal(result.timedOut, 2, `expected 2 timed out, got ${result.timedOut}; elapsed=${result.elapsedMs}`);
  assert.ok(result.elapsedMs >= 90, `elapsed=${result.elapsedMs} expected near deadline`);

  await Promise.all([fast, slow1, slow2]);
});

test("drainPromisesWithDeadline: rejected promises count as drained (allSettled never throws)", async () => {
  const pending = new Map();
  // Pre-attach a catch so the rejection isn't unhandled, then track.
  const rejecting = Promise.reject(new Error("boom"));
  rejecting.catch(() => {
    /* intentionally empty */
  });
  track(pending, "x", rejecting);
  track(pending, "y", Promise.resolve("ok"));

  const result = await drainPromisesWithDeadline(pending, 1000);
  assert.equal(result.drained, 2);
  assert.equal(result.timedOut, 0);
  assert.equal(pending.size, 0);
});

test("drainPromisesWithDeadline: snapshot is taken at call time (later additions ignored)", async () => {
  const pending = new Map();
  track(pending, "a", new Promise((r) => setTimeout(r, 5)));

  const drainPromise = drainPromisesWithDeadline(pending, 1000);
  // Register a new run AFTER the drain started — should not be awaited.
  track(pending, "late", new Promise((r) => setTimeout(r, 500).unref?.()));

  const result = await drainPromise;
  assert.equal(result.drained, 1);
  assert.equal(result.timedOut, 0);
  // The late entry is still alive in the map.
  assert.ok(pending.has("late"));
});
