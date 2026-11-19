// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Handle, RouteView as Route } from "@tnunamak/gozar";
import { fakeRouteScenarios } from "@tnunamak/gozar/testing";
import { initialLifecycle } from "../server/reachability/lifecycle.ts";
import { ReachabilityOperations } from "../server/reachability/operations.ts";
import { ReachabilityService } from "../server/reachability/service.ts";

const seed = fakeRouteScenarios().find((route) => route.handle.kind === "attached" && route.published)!;

type CloseCall = { handle: Handle; mode: string };

// A service that already holds routes, plus the real journal on disk. The fake
// api records every close; `close` decides how each one settles.
async function fixture(
  routes: { kind: Handle["kind"]; ownership: Route["ownership"] }[],
  close: (call: CloseCall, route: Route) => Promise<Route>
) {
  const root = await mkdtemp(join(tmpdir(), "reachability-shutdown-"));
  const operations = new ReachabilityOperations(root, true);
  const calls: CloseCall[] = [];
  const held: Route[] = [];
  for (const [index, spec] of routes.entries()) {
    await operations.start("start", null, async (operationId) => {
      const route: Route = {
        ...seed,
        handle: { id: `route-${index}`, generation: 1, kind: spec.kind },
        operationId,
        ownership: spec.ownership,
      };
      held.push(route);
      return route;
    });
  }
  const settle = async () => {
    for (let attempt = 0; attempt < 200; attempt++) {
      if ((await operations.list()).every((record) => record.stage === "settled")) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("journal did not settle");
  };
  await settle();
  const service = new ReachabilityService(
    {
      closeRoute: async (input: { handle: Handle; mode: string }) => {
        const call = { handle: input.handle, mode: input.mode };
        calls.push(call);
        const route = held.find((item) => item.handle.id === input.handle.id)!;
        return close(call, route);
      },
      expose: async () => {
        throw new Error("expose must not run during shutdown");
      },
      watchRoutes: async function* () {},
    } as never,
    {
      acknowledgeDisconnect: async () => undefined,
      identity: { bootId: "b", instanceId: "i" },
      query: { home: "fixture-home" },
    } as never
  );
  const inner = service as unknown as { routes: Map<string, Route>; lifecycle: unknown };
  for (const route of held) inner.routes.set(route.handle.id, route);
  const first = held[0];
  if (first) inner.lifecycle = { ...initialLifecycle(), cleanup: "none", handle: first.handle, phase: "verified" };
  return {
    calls,
    held,
    inner,
    operations,
    root,
    service,
    cleanup: () => rm(root, { force: true, recursive: true }),
  };
}

const confirmed = (_call: CloseCall, route: Route): Promise<Route> =>
  Promise.resolve({ ...route, cleanup: { nextAction: null, state: "confirmed" }, published: null });

test("shutdown closes the owned attached route once, journals a stop tombstone, and confirms cleanup", async () => {
  const f = await fixture([{ kind: "attached", ownership: "gozar-owned" }], confirmed);
  try {
    const outcome = await f.service.shutdown(2000, f.operations);
    assert.deepEqual(f.calls, [{ handle: f.held[0]!.handle, mode: "remove" }]);
    assert.deepEqual(outcome, { confirmed: ["route-0"], unconfirmed: [] });
    const record = await f.operations.read(f.held[0]!.operationId!);
    assert.equal(record.stopTombstone, true);
    assert.equal(record.stage, "settled");
    assert.equal(record.recovery, null);
    assert.equal(f.inner.routes.get("route-0")!.cleanup.state, "confirmed");
    assert.equal(f.inner.routes.get("route-0")!.published, null);
    assert.equal(f.service.state().lifecycle.cleanup, "confirmed");
    // Idempotent: a second call neither closes again nor changes the outcome.
    assert.deepEqual(await f.service.shutdown(2000, f.operations), outcome);
    assert.equal(f.calls.length, 1);
  } finally {
    await f.cleanup();
  }
});

test("a close that never settles ends at the deadline, keeps the tombstone, and does not claim cleanup", async () => {
  const f = await fixture([{ kind: "attached", ownership: "gozar-owned" }], () => new Promise<Route>(() => {}));
  try {
    const started = Date.now();
    const outcome = await f.service.shutdown(100, f.operations);
    assert.ok(Date.now() - started < 1500, "returns near the deadline, not after the hung close");
    assert.deepEqual(outcome, { confirmed: [], unconfirmed: ["route-0"] });
    const record = await f.operations.read(f.held[0]!.operationId!);
    assert.equal(record.stopTombstone, true);
    assert.equal(record.stage, "unknown-possibly-live");
    assert.equal(record.recovery?.available, true);
    assert.notEqual(f.inner.routes.get("route-0")!.cleanup.state, "confirmed");
    assert.notEqual(f.service.state().lifecycle.cleanup, "confirmed");
  } finally {
    await f.cleanup();
  }
});

test("a close that returns unconfirmed is reported unconfirmed", async () => {
  const f = await fixture([{ kind: "attached", ownership: "gozar-owned" }], (_call, route) =>
    Promise.resolve({ ...route, cleanup: { nextAction: null, state: "unconfirmed" } })
  );
  try {
    const outcome = await f.service.shutdown(2000, f.operations);
    assert.deepEqual(outcome, { confirmed: [], unconfirmed: ["route-0"] });
    assert.equal((await f.operations.read(f.held[0]!.operationId!)).stage, "unknown-possibly-live");
  } finally {
    await f.cleanup();
  }
});

test("a start requested after shutdown began is refused and reaches no provider", async () => {
  const f = await fixture([], confirmed);
  try {
    await f.service.shutdown(100, f.operations);
    const review = {
      candidate: {
        candidateToken: "tok",
        configuration: { revision: "r1" },
        consent: { consentFactsDigest: "d", disclosures: {}, facts: [], scope: { kind: "route" } },
        consentFactsDigest: "d",
        disclosure: { revision: "1" },
        expiresAt: "2999-01-01T00:00:00.000Z",
        providerId: "svc",
      },
      draftId: "d1",
      id: "rev-1",
      query: { target: "127.0.0.1:1", usage: { kind: "attached" } },
    };
    (f.inner as unknown as { reviews: Map<string, unknown> }).reviews = new Map([["rev-1", review]]);
    const input = { acknowledgeDisconnect: true, consentFactsDigest: "d", kind: "route" };
    await assert.rejects(f.service.precheckApply("rev-1", input), { code: "host_supervisor_unavailable" });
    await assert.rejects(f.service.apply("op-1", "rev-1", input), { code: "host_supervisor_unavailable" });
  } finally {
    await f.cleanup();
  }
});

test("routes the host does not own are left alone", async () => {
  const f = await fixture(
    [
      { kind: "external", ownership: "external-owned" },
      { kind: "durable", ownership: "gozar-owned" },
      { kind: "attached", ownership: "external-owned" },
    ],
    confirmed
  );
  try {
    const outcome = await f.service.shutdown(2000, f.operations);
    assert.deepEqual(f.calls, []);
    assert.deepEqual(outcome, { confirmed: [], unconfirmed: [] });
    for (const route of f.held) {
      assert.equal((await f.operations.read(route.operationId!)).stopTombstone, false);
    }
  } finally {
    await f.cleanup();
  }
});

test("shutdown closes a library-owned session route by its exact handle, because its daemon outlives the host", async () => {
  const f = await fixture(
    [
      { kind: "session", ownership: "gozar-owned" },
      { kind: "durable", ownership: "gozar-owned" },
      { kind: "external", ownership: "external-owned" },
    ],
    confirmed
  );
  try {
    const outcome = await f.service.shutdown(2000, f.operations);
    assert.deepEqual(f.calls, [{ handle: f.held[0]!.handle, mode: "remove" }]);
    assert.deepEqual(outcome, { confirmed: ["route-0"], unconfirmed: [] });
    const record = await f.operations.read(f.held[0]!.operationId!);
    assert.equal(record.stopTombstone, true);
    assert.equal(record.stage, "settled");
    assert.equal(record.cleanupConfirmed, true);
    for (const other of f.held.slice(1)) {
      assert.equal((await f.operations.read(other.operationId!)).stopTombstone, false);
    }
  } finally {
    await f.cleanup();
  }
});

const hangingJournal = {
  recordCleanupUnconfirmed: () => new Promise<void>(() => {}),
  recordRecovered: () => new Promise<void>(() => {}),
  requestStop: () => new Promise<void>(() => {}),
};

// Both hung-journal tests await shutdown directly: its own deadline plus the
// capped journal grace bound the run, and the per-test timeout catches a true
// hang without parking a real timer in test code.
test("a stalled journal does not hold shutdown past its budget, and the close was still dispatched", { timeout: 2000 }, async () => {
  const f = await fixture([{ kind: "attached", ownership: "gozar-owned" }], () => new Promise<Route>(() => {}));
  try {
    const started = Date.now();
    const outcome = await f.service.shutdown(80, hangingJournal);
    assert.ok(Date.now() - started < 1000, "shutdown returns within the deadline plus the journal grace");
    assert.deepEqual(outcome, { confirmed: [], unconfirmed: ["route-0"] });
    assert.equal(f.calls.length, 1, "the provider close was dispatched");
    // The writes never landed: the record is still a restart candidate, not confirmed.
    assert.notEqual((await f.operations.read(f.held[0]!.operationId!)).cleanupConfirmed, true);
  } finally {
    await f.cleanup();
  }
});

test("a hung tombstone write does not keep the provider close from starting", { timeout: 2000 }, async () => {
  const f = await fixture([{ kind: "attached", ownership: "gozar-owned" }], confirmed);
  try {
    const outcome = await f.service.shutdown(80, hangingJournal);
    assert.equal(f.calls.length, 1, "the close starts without waiting for the tombstone");
    assert.deepEqual(outcome, { confirmed: ["route-0"], unconfirmed: [] });
  } finally {
    await f.cleanup();
  }
});

test("a start that never settles does not delay the close of an already-known owned route", { timeout: 2000 }, async () => {
  const f = await fixture([{ kind: "attached", ownership: "gozar-owned" }], confirmed);
  try {
    // An embedded provider start that never returns: its settlement promise is the
    // only thing shutdown must not wait for before closing known routes. The
    // per-test timeout catches a true hang; the deadline bounds this run.
    (f.inner as unknown as { startSettled: Promise<void> | null }).startSettled = new Promise<void>(() => {});
    const started = Date.now();
    const outcome = await f.service.shutdown(80, f.operations);
    assert.ok(Date.now() - started < 1000, "shutdown stays within its deadline plus journal grace");
    assert.equal(f.calls.length, 1, "the already-known route's close was dispatched without waiting for the start");
    assert.deepEqual(outcome, { confirmed: ["route-0"], unconfirmed: [] });
  } finally {
    await f.cleanup();
  }
});
