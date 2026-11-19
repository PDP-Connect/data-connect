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
import { type OperationRecord, ReachabilityOperations } from "../server/reachability/operations.ts";
import { ReachabilityService } from "../server/reachability/service.ts";

const seed = fakeRouteScenarios().find((route) => route.handle.kind === "attached" && route.published)!;

type Spec = { id: string; kind: Handle["kind"]; ownership: Route["ownership"] };
type Intent = NonNullable<OperationRecord["intent"]>;

const intentFor = (ownership: Route["ownership"]): Intent => ({
  bootId: "old-boot",
  configurationRevision: "r1",
  consentFactsDigest: "d",
  expectedOrigin: null,
  instanceId: "i",
  ownership,
  providerId: "svc",
  target: "127.0.0.1:1",
  usage: { kind: "attached" },
});

// The journal a crashed process left: one settled start record per spec, each
// holding its exact handle. A second journal object on the same directory is the
// restarted process (nothing is "running" in it).
async function crashedProcess(
  specs: Spec[],
  closeRoute: (handle: Handle) => Promise<Route>,
  prepare: (operations: ReachabilityOperations, records: Map<string, string>) => Promise<void> = async () => {}
) {
  const root = await mkdtemp(join(tmpdir(), "reachability-restart-"));
  const before = new ReachabilityOperations(root, true);
  const operationIds = new Map<string, string>();
  for (const spec of specs) {
    const started = await before.start(
      "start",
      null,
      async () => ({ ...seed, handle: { id: spec.id, generation: 1, kind: spec.kind }, ownership: spec.ownership }),
      intentFor(spec.ownership)
    );
    operationIds.set(spec.id, started.operationId);
  }
  for (let attempt = 0; attempt < 200 && !(await before.list()).every((r) => r.stage === "settled"); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await prepare(before, operationIds);
  const operations = new ReachabilityOperations(root, true);
  const closes: Handle[] = [];
  const service = new ReachabilityService(
    {
      closeRoute: async (input: { handle: Handle; mode: string }) => {
        assert.equal(input.mode, "remove");
        closes.push(input.handle);
        return closeRoute(input.handle);
      },
      expose: async () => {
        throw new Error("expose must not run during reconcile");
      },
      listRoutes: async () => ({ routes: [] }),
      watchRoutes: async function* () {},
    } as never,
    {
      acknowledgeDisconnect: async () => undefined,
      identity: { bootId: "new-boot", instanceId: "i" },
      query: { home: "fixture-home" },
    } as never
  );
  const inner = service as unknown as { reviews: Map<string, unknown>; lifecycle: unknown };
  // A review the owner has approved, so the only thing that can refuse a Turn on is reconcile state.
  const turnOn = () => {
    inner.lifecycle = { ...initialLifecycle(), approvalIdentity: "rev-1", phase: "review" };
    inner.reviews = new Map([
      [
        "rev-1",
        {
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
        },
      ],
    ]);
    return service.precheckApply("rev-1", { consentFactsDigest: "d", kind: "route" });
  };
  return { closes, inner, operationIds, operations, root, service, turnOn, cleanup: () => rm(root, { force: true, recursive: true }) };
}

const confirm = (handle: Handle): Promise<Route> =>
  Promise.resolve({ ...seed, cleanup: { nextAction: null, state: "confirmed" }, handle, published: null, state: "released" });
const unconfirmed = (handle: Handle): Promise<Route> =>
  Promise.resolve({ ...seed, cleanup: { nextAction: null, state: "unconfirmed" }, handle });
const attachedOwned: Spec = { id: "route-1", kind: "attached", ownership: "gozar-owned" };

test("a route the last process left live is closed once with its exact handle, settled, and a Turn on is accepted", async () => {
  const f = await crashedProcess([attachedOwned], confirm);
  try {
    const outcome = await f.service.reconcileAfterRestart(2000, f.operations);
    assert.deepEqual(outcome, { confirmed: ["route-1"], unconfirmed: [] });
    assert.deepEqual(f.closes, [{ id: "route-1", generation: 1, kind: "attached" }]);
    const record = await f.operations.read(f.operationIds.get("route-1")!);
    assert.equal(record.stage, "settled");
    assert.equal(record.stopTombstone, true);
    assert.equal(record.recovery, null);
    const state = f.service.state();
    assert.deepEqual(state.routes, []);
    assert.equal(state.lifecycle.handle, null, "the old route is never adopted as current");
    assert.equal(state.reconciling, false);
    await f.turnOn();
    // A second pass finds nothing owed.
    await f.service.reconcileAfterRestart(2000, f.operations);
    assert.equal(f.closes.length, 1);
  } finally {
    await f.cleanup();
  }
});

test("a start the crash left applying (no handle) is not closed by guess", async () => {
  const f = await crashedProcess([], confirm);
  try {
    await new ReachabilityOperations(f.root, true).start("start", null, () => new Promise<Route>(() => {}), intentFor("gozar-owned"));
    await f.service.reconcileAfterRestart(500, f.operations);
    assert.deepEqual(f.closes, []);
  } finally {
    await f.cleanup();
  }
});

test("a close that is not confirmed exposes a stop remedy, not the generic busy refusal", async () => {
  const f = await crashedProcess([attachedOwned], unconfirmed);
  try {
    const outcome = await f.service.reconcileAfterRestart(2000, f.operations);
    assert.deepEqual(outcome, { confirmed: [], unconfirmed: ["route-1"] });
    const record = await f.operations.read(f.operationIds.get("route-1")!);
    assert.equal(record.stage, "unknown-possibly-live");
    assert.equal(record.stopTombstone, true);
    assert.deepEqual(record.handle, { id: "route-1", generation: 1, kind: "attached" });
    const state = f.service.state();
    assert.equal(state.lifecycle.cleanup, "unconfirmed");
    assert.equal(state.routes[0]?.cleanup.state, "unconfirmed");
    await assert.rejects(f.turnOn(), { code: "cleanup_debt" });
    // The owner's existing stop action clears it once the close confirms.
    (f.service as unknown as { api: { closeRoute: unknown } }).api.closeRoute = async ({ handle }: { handle: Handle }) => confirm(handle);
    const closed = await f.service.stop("route-1", 1, true);
    assert.equal(closed.cleanup.state, "confirmed");
    await f.turnOn();
  } finally {
    await f.cleanup();
  }
});

test("a close that never settles ends at the deadline with the same remedy", async () => {
  const f = await crashedProcess([attachedOwned], () => new Promise<Route>(() => {}));
  try {
    const started = Date.now();
    const outcome = await f.service.reconcileAfterRestart(80, f.operations);
    assert.ok(Date.now() - started < 1500);
    assert.deepEqual(outcome, { confirmed: [], unconfirmed: ["route-1"] });
    const record = await f.operations.read(f.operationIds.get("route-1")!);
    assert.equal(record.stage, "unknown-possibly-live");
    assert.equal(record.stopTombstone, true);
    assert.equal(f.service.state().reconciling, false);
    await assert.rejects(f.turnOn(), { code: "cleanup_debt" });
  } finally {
    await f.cleanup();
  }
});

test("a route whose cleanup the journal confirmed is not touched", async () => {
  const f = await crashedProcess(
    [attachedOwned, { id: "route-2", kind: "attached", ownership: "gozar-owned" }, { id: "route-3", kind: "attached", ownership: "gozar-owned" }],
    confirm,
    async (operations, ids) => {
      // route-1: shutdown closed it and recorded the confirmation.
      const one = ids.get("route-1")!;
      await operations.requestStop(one);
      await operations.recordRecovered(one, { ...seed, handle: { id: "route-1", generation: 1, kind: "attached" } });
      // route-2: the owner turned it off and the stop settled.
      const two: Handle = { id: "route-2", generation: 1, kind: "attached" };
      await operations.start("stop", two, async () => ({ ...seed, handle: two }));
      for (let attempt = 0; attempt < 200 && !(await operations.list()).every((r) => r.stage === "settled"); attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
  );
  try {
    const outcome = await f.service.reconcileAfterRestart(2000, f.operations);
    assert.deepEqual(f.closes, [{ id: "route-3", generation: 1, kind: "attached" }]);
    assert.deepEqual(outcome, { confirmed: ["route-3"], unconfirmed: [] });
  } finally {
    await f.cleanup();
  }
});

test("external, durable and externally owned attached routes are not touched", async () => {
  const f = await crashedProcess(
    [
      { id: "ext", kind: "external", ownership: "external-owned" },
      { id: "dur", kind: "durable", ownership: "gozar-owned" },
      { id: "att-ext", kind: "attached", ownership: "external-owned" },
    ],
    confirm
  );
  try {
    const outcome = await f.service.reconcileAfterRestart(2000, f.operations);
    assert.deepEqual(f.closes, []);
    assert.deepEqual(outcome, { confirmed: [], unconfirmed: [] });
    for (const id of f.operationIds.values()) {
      const record = await f.operations.read(id);
      assert.equal(record.stopTombstone, false);
      assert.equal(record.stage, "settled");
    }
    await f.turnOn();
  } finally {
    await f.cleanup();
  }
});

test("a Turn on while the pass is running is refused as operation_in_progress, then accepted", async () => {
  let release!: (route: Route) => void;
  const f = await crashedProcess([attachedOwned], () => new Promise<Route>((resolve) => (release = resolve)));
  try {
    const running = f.service.reconcileAfterRestart(5000, f.operations);
    assert.equal(f.service.state().reconciling, true);
    await assert.rejects(f.turnOn(), { code: "operation_in_progress" });
    for (let attempt = 0; attempt < 200 && !f.closes.length; attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
    release(await confirm({ id: "route-1", generation: 1, kind: "attached" }));
    await running;
    assert.equal(f.service.state().reconciling, false);
    await f.turnOn();
  } finally {
    await f.cleanup();
  }
});
