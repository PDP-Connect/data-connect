// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import type { Lifecycle, Phase } from "../server/reachability/lifecycle.ts";
import {
  events,
  initialLifecycle,
  lifecycleLabel,
  phases,
  reduceLifecycle,
  transitionTable,
} from "../server/reachability/lifecycle.ts";

const handle = { generation: 1, id: "route-one", kind: "attached" as const };
function state(phase: Phase): Lifecycle {
  return { ...initialLifecycle(), handle, operationId: "operation-one", phase };
}

test("transition table is total: every state/event pair is defined or explicitly rejected", () => {
  for (const phase of phases) {
    for (const event of events) {
      assert.ok(Object.hasOwn(transitionTable[phase], event), `${phase}/${event}`);
      const result = reduceLifecycle(state(phase), { type: event });
      assert.equal(typeof result.accepted, "boolean");
      if (!result.accepted) {
        assert.ok(result.reason);
        assert.equal(result.state.phase, phase);
      }
    }
  }
});
test("a failed recheck downgrades evidence without stopping forwarding", () => {
  for (const phase of ["verified", "stale", "unknown", "failed"] as const) {
    const checking = reduceLifecycle(state(phase), { type: "check" });
    assert.equal(checking.accepted, true);
    const failed = reduceLifecycle(checking.state, { type: "proof-failed" });
    assert.equal(failed.state.evidence, "failed");
    assert.ok(!failed.effects.some((effect) => effect === "close-route"));
    assert.deepEqual(failed.state.handle, handle);
  }
});
test("reconcile tests the tombstone before route absence or proof", () => {
  const result = reduceLifecycle(
    { ...state("reconciling"), stopTombstone: true },
    { observed: "present", type: "reconcile" }
  );
  assert.equal(result.state.phase, "stopping");
  assert.deepEqual(result.effects, ["withdraw-publication", "close-route"]);
  for (const observed of ["absent", "failed"] as const) {
    const result = reduceLifecycle(state("reconciling"), { observed, type: "reconcile" });
    assert.equal(result.state.phase, "unknown");
    assert.ok(!result.effects.some((effect) => effect === "close-route"));
  }
  const uncertain = reduceLifecycle({ ...state("reconciling"), handle: null }, { type: "reconcile" });
  assert.equal(lifecycleLabel(uncertain.state), "Unknown, possibly live");
  assert.deepEqual(uncertain.effects, ["recover-operation"]);
});
test("exit is handled from every phase that retains a handle and fences late proof", () => {
  for (const phase of phases) {
    const before = state(phase),
      exited = reduceLifecycle(before, { type: "agent-exit" });
    assert.equal(exited.state.phase, "stopping");
    assert.ok(exited.effects.some((effect) => effect === "close-route"));
    assert.ok(exited.state.epoch > before.epoch);
    const late = reduceLifecycle(exited.state, { epoch: before.epoch, type: "proof-passed" });
    assert.equal(late.accepted, false);
  }
});
test("local confinement and cleanup debt remain independent", () => {
  const stop = reduceLifecycle(state("verified"), { type: "stop" }).state;
  const debt = reduceLifecycle(stop, { type: "cleanup-unconfirmed" }).state;
  assert.notEqual(lifecycleLabel(debt), "Stopped locally");
  const confined = reduceLifecycle(debt, { confinement: { known: true, value: true }, type: "host-confinement" }).state;
  assert.equal(lifecycleLabel(confined), "Stopped locally");
  assert.equal(confined.cleanup, "unconfirmed");
  const unknown = reduceLifecycle(stop, { type: "cleanup-confirmed" }).state;
  assert.notEqual(lifecycleLabel(unknown), "Stopped locally");
});
test("expired or changed approval cannot silently start a replacement route", () => {
  for (const type of ["approval-changed", "approval-expired"] as const) {
    const changed = reduceLifecycle({ ...state("review"), approvalIdentity: "old" }, { type });
    const apply = reduceLifecycle(changed.state, {
      approvalExpiresAt: 100,
      approvalIdentity: "old",
      now: 1,
      type: "apply",
    });
    assert.ok(!apply.effects.some((effect) => effect === "start-route"));
    assert.equal(apply.state.phase, "review");
  }
});
test("setup/start/restart failure and timeout have explicit destinations", () => {
  for (const [phase, names] of [
    ["setup", ["setup-failed", "setup-timeout"]],
    ["applying", ["start-failed", "start-timeout"]],
    ["reconciling", ["restart-failed", "restart-timeout"]],
  ] as const) {
    for (const type of names) {
      assert.equal(reduceLifecycle(state(phase), { type }).accepted, true);
    }
  }
});

test('a new apply does not carry the stopped route handle into its pending attempt', () => {
  const reviewed = { ...state('review'), approvalIdentity: 'review-current' };
  const applied = reduceLifecycle(reviewed, { type: 'apply', approvalIdentity: 'review-current', approvalExpiresAt: 100, now: 1, operationId: 'operation-next' });
  assert.equal(applied.accepted, true);
  assert.equal(applied.state.handle, null);
  assert.equal(applied.state.operationId, 'operation-next');
});

test("a missing ownership record retains cleanup debt even after an earlier confirmation", () => {
  for (const stopTombstone of [false, true]) {
    const missing = reduceLifecycle(
      { ...state("reconciling"), cleanup: "confirmed", stopTombstone },
      { observed: "absent", type: "reconcile" }
    )
    assert.equal(missing.state.cleanup, "unconfirmed")
    assert.notEqual(missing.state.phase, "off")
  }
})
