// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Handle, RouteView as Route } from "@tnunamak/gozar";
import { fakeRouteScenarios } from "@tnunamak/gozar/testing";
import { initialLifecycle } from "../server/reachability/lifecycle.ts";
import { type OperationRecord, ReachabilityOperations } from "../server/reachability/operations.ts";
import { ReachabilityService, restartCandidates } from "../server/reachability/service.ts";

const seed = fakeRouteScenarios().find((route) => route.handle.kind === "attached" && route.published)!;

type Spec = { id: string; kind: Handle["kind"]; ownership: Route["ownership"]; generation?: number };
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
      async () => ({ ...seed, handle: { id: spec.id, generation: spec.generation ?? 1, kind: spec.kind }, ownership: spec.ownership }),
      intentFor(spec.ownership)
    );
    operationIds.set(spec.generation ? `${spec.id}@${spec.generation}` : spec.id, started.operationId);
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
  return { closes, inner, operationIds, operations, root, service, turnOn, cleanup: () => rm(root, { force: true, maxRetries: 10, recursive: true, retryDelay: 25 }) };
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

test("a handle the library no longer knows settles as closed and a Turn on is accepted", async () => {
  const gone = async () => {
    throw Object.assign(new Error("No such attached route"), { code: "route_not_found" });
  };
  const f = await crashedProcess([attachedOwned], gone);
  try {
    const outcome = await f.service.reconcileAfterRestart(2000, f.operations);
    assert.deepEqual(outcome, { confirmed: ["route-1"], unconfirmed: [] });
    const record = await f.operations.read(f.operationIds.get("route-1")!);
    assert.equal(record.stage, "settled");
    assert.equal(record.stopTombstone, true);
    assert.equal(record.recovery, null);
    assert.deepEqual(f.service.state().routes, []);
    await f.turnOn();
    // The next restart finds nothing owed.
    assert.deepEqual(restartCandidates(await f.operations.list()), []);
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
      await operations.recordRecovered(one, await confirm({ id: "route-1", generation: 1, kind: "attached" }));
      // route-2: the owner turned it off and the stop settled.
      const two: Handle = { id: "route-2", generation: 1, kind: "attached" };
      await operations.start("stop", two, () => confirm(two));
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

test("an owner stop that settled without confirming cleanup leaves the route to the restart pass", async () => {
  const f = await crashedProcess([attachedOwned], confirm, async (operations) => {
    const handle: Handle = { id: "route-1", generation: 1, kind: "attached" };
    await operations.start("stop", handle, () => unconfirmed(handle));
    for (let attempt = 0; attempt < 200 && !(await operations.list()).every((r) => r.stage === "settled"); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const stop = (await operations.list()).find((record) => record.kind === "stop");
    assert.equal(stop?.stage, "settled", "the stop settles so the route keeps its retry action");
    assert.equal(stop?.cleanupConfirmed, false);
  });
  try {
    const outcome = await f.service.reconcileAfterRestart(2000, f.operations);
    assert.deepEqual(f.closes, [{ id: "route-1", generation: 1, kind: "attached" }]);
    assert.deepEqual(outcome, { confirmed: ["route-1"], unconfirmed: [] });
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

const until = async (done: () => boolean | Promise<boolean>) => {
  for (let attempt = 0; attempt < 400 && !(await done()); attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(await done(), "condition not reached");
};
const route1: Handle = { id: "route-1", generation: 1, kind: "attached" };
const gone = () => Object.assign(new Error("No such attached route"), { code: "route_not_found" });

// The owner routes over the real service and journal, called without a socket.
async function ownerApi(f: Awaited<ReturnType<typeof crashedProcess>>, extra: Record<string, unknown> = {}) {
  const { mountOwnerReachability } = await import("../server/routes/owner-reachability.ts");
  const routes = new Map<string, (request: unknown, response: unknown) => Promise<unknown>>();
  const pass = async (_r: unknown, _s: unknown, next?: () => void) => next?.();
  const app = {
    get: (path: string, ...args: unknown[]) => routes.set(`GET ${path}`, args.at(-1) as never),
    post: (path: string, ...args: unknown[]) => routes.set(`POST ${path}`, args.at(-1) as never),
  };
  mountOwnerReachability(app as never, {
    operations: f.operations,
    passwordSet: async () => true,
    requireCsrf: pass,
    requireOwner: pass,
    requireToken: pass,
    service: f.service,
    setups: { list: async () => [] },
    usage: () => {
      throw new Error("unused");
    },
    ...extra,
  } as never);
  return async (method: "GET" | "POST", path: string, body?: unknown, params: Record<string, string> = {}) => {
    let payload: { data?: any; error?: any } = {};
    const response = {
      json: (value: unknown) => ((payload = value as never), response),
      setHeader: () => undefined,
      status: () => response,
    };
    const route = [...routes].find(([key]) => {
      const [m, template] = key.split(" ");
      return m === method && new RegExp(`^${template!.replace(/:\w+/g, "[^/]+")}$`).test(`/v1/owner/reachability${path}`);
    });
    await route![1]({ body, params, query: {} }, response);
    return payload;
  };
}

test("a prior restart Stop intent without confirmation is retried", async () => {
  // The boot pass wrote its Stop tombstone, then the process died before the close confirmed.
  const f = await crashedProcess([attachedOwned], confirm, async (operations, ids) => {
    await operations.requestStop(ids.get("route-1")!);
  });
  try {
    const outcome = await f.service.reconcileAfterRestart(2000, f.operations);
    assert.deepEqual(f.closes, [route1]);
    assert.deepEqual(outcome, { confirmed: ["route-1"], unconfirmed: [] });
    const record = await f.operations.read(f.operationIds.get("route-1")!);
    assert.equal(record.cleanupConfirmed, true);
    assert.deepEqual(restartCandidates(await f.operations.list()), []);
  } finally {
    await f.cleanup();
  }
});

test("restart debt keeps an owner retry after unconfirmed reconcile", async () => {
  let calls = 0;
  let bootClose!: () => void;
  const f = await crashedProcess([attachedOwned], (handle) => {
    calls += 1;
    if (calls === 1) return new Promise<Route>((resolve) => (bootClose = () => resolve({ ...seed, cleanup: { nextAction: null, state: "unconfirmed" }, handle }))); // the boot close outlasts the deadline
    return calls === 2 ? unconfirmed(handle) : confirm(handle);
  });
  try {
    const call = await ownerApi(f);
    const id = f.operationIds.get("route-1")!;
    assert.deepEqual(await f.service.reconcileAfterRestart(60, f.operations), { confirmed: [], unconfirmed: ["route-1"] });
    // A retry joins the close still in flight; it starts its own only after that one settled.
    bootClose();
    await until(() => (f.inner as unknown as { closing: Map<string, unknown> }).closing.size === 0);
    const actionable = async () => (await call("GET", "/state")).data.operations.filter((op: { operationId: string }) => op.operationId === id);
    assert.equal((await actionable())[0]?.recovery?.available, true);
    await assert.rejects(f.turnOn(), { code: "cleanup_debt" });
    // The owner's retry does not confirm: the operation and the refusal both stay.
    const retry = await call("POST", `/operations/${id}/reconcile`, { acknowledgeDisconnect: true, action: "stop" }, { id });
    assert.equal(retry.data?.cleanup.state, "unconfirmed", JSON.stringify(retry));
    const [still] = await actionable();
    assert.equal(still?.stage, "unknown-possibly-live");
    assert.equal(still?.recovery?.available, true);
    await assert.rejects(f.turnOn(), { code: "cleanup_debt" });
    // A confirming retry clears the operation and the debt together.
    const done = await call("POST", `/operations/${id}/reconcile`, { acknowledgeDisconnect: true, action: "stop" }, { id });
    assert.equal(done.data.cleanup.state, "confirmed");
    assert.deepEqual(await actionable(), []);
    await f.turnOn();
    assert.deepEqual(restartCandidates(await f.operations.list()), []);
  } finally {
    await f.cleanup();
  }
});

test("owner retry settles as closed when the library no longer knows the handle", async () => {
  let calls = 0;
  const f = await crashedProcess([attachedOwned], (handle) => {
    calls += 1;
    if (calls === 1) return unconfirmed(handle);
    return Promise.reject(gone());
  });
  try {
    const call = await ownerApi(f);
    const id = f.operationIds.get("route-1")!;
    await f.service.reconcileAfterRestart(500, f.operations);
    await assert.rejects(f.turnOn(), { code: "cleanup_debt" });
    const settled = await call("POST", `/operations/${id}/reconcile`, { acknowledgeDisconnect: true, action: "stop" }, { id });
    assert.equal(settled.data?.stage, "settled", JSON.stringify(settled));
    assert.equal((await f.operations.read(id)).cleanupConfirmed, true);
    await f.turnOn();
  } finally {
    await f.cleanup();
  }
});

test("late not-found wins over a delayed deadline record", async () => {
  let closeFails!: (error: Error) => void;
  const f = await crashedProcess([attachedOwned], () => new Promise<Route>((_resolve, reject) => (closeFails = reject)));
  try {
    const id = f.operationIds.get("route-1")!;
    let releaseTimeoutWrite!: () => void;
    let timeoutWriteStarted = false;
    const real = f.operations;
    const journal = {
      list: () => real.list(),
      scan: () => real.scan(),
      recordAbsent: (operationId: string) => real.recordAbsent(operationId),
      recordRecovered: (operationId: string, route: Route) => real.recordRecovered(operationId, route),
      requestStop: (operationId: string) => real.requestStop(operationId),
      recordCleanupUnconfirmed: async (operationId: string, handle: Handle) => {
        timeoutWriteStarted = true;
        await new Promise<void>((resolve) => (releaseTimeoutWrite = resolve));
        return real.recordCleanupUnconfirmed(operationId, handle);
      },
    };
    let returned: unknown = null;
    const running = f.service.reconcileAfterRestart(40, journal).then((outcome) => (returned = outcome));
    await until(() => timeoutWriteStarted && f.closes.length === 1);
    closeFails(gone());
    await new Promise((resolve) => setTimeout(resolve, 20));
    releaseTimeoutWrite();
    await running;
    const report = JSON.stringify(returned);
    // The strongest outcome known when the pass returns: the library said the route is gone.
    assert.deepEqual(returned, { confirmed: ["route-1"], unconfirmed: [] });
    await until(async () => (await real.read(id)).stage === "settled");
    await new Promise((resolve) => setTimeout(resolve, 30));
    const record = await real.read(id);
    assert.equal(record.stage, "settled");
    assert.equal(record.cleanupConfirmed, true);
    assert.equal(record.recovery, null);
    assert.equal(JSON.stringify(returned), report, "the report does not change after return");
    assert.deepEqual(restartCandidates(await real.list()), []);
    assert.equal(f.service.state().routes.length, 0);
    await f.turnOn();
  } finally {
    await f.cleanup();
  }
});

test("a late confirmed close settles once and leaves the returned report alone", async () => {
  let release!: (route: Route) => void;
  const f = await crashedProcess([attachedOwned], () => new Promise<Route>((resolve) => (release = resolve)));
  try {
    const id = f.operationIds.get("route-1")!;
    const outcome = await f.service.reconcileAfterRestart(40, f.operations);
    const report = JSON.stringify(outcome);
    release(await confirm(route1));
    await until(async () => (await f.operations.read(id)).stage === "settled");
    assert.equal(JSON.stringify(outcome), report);
    assert.deepEqual(outcome, { confirmed: [], unconfirmed: ["route-1"] });
    assert.equal((await f.operations.read(id)).cleanupConfirmed, true);
    await f.turnOn();
  } finally {
    await f.cleanup();
  }
});

test("owner recovery and boot share an in-flight close", async () => {
  let release!: (route: Route) => void;
  const f = await crashedProcess([attachedOwned], () => new Promise<Route>((resolve) => (release = resolve)));
  try {
    const call = await ownerApi(f);
    const id = f.operationIds.get("route-1")!;
    const boot = f.service.reconcileAfterRestart(5000, f.operations);
    await until(() => f.closes.length === 1);
    const owner = call("POST", `/operations/${id}/reconcile`, { acknowledgeDisconnect: true, action: "stop" }, { id });
    await new Promise((resolve) => setTimeout(resolve, 40));
    release(await confirm(route1));
    const [outcome, answer] = await Promise.all([boot, owner]);
    assert.equal(f.closes.length, 1, "one close for the handle");
    assert.deepEqual(outcome, { confirmed: ["route-1"], unconfirmed: [] });
    assert.equal(answer.data.cleanup.state, "confirmed");
    const record = await f.operations.read(id);
    assert.equal(record.stage, "settled");
    assert.equal(record.cleanupConfirmed, true);
    await f.turnOn();
  } finally {
    await f.cleanup();
  }
});

test("shutdown joins a boot-only close and journals it unconfirmed", async () => {
  const f = await crashedProcess([attachedOwned], () => new Promise<Route>(() => {}));
  try {
    const id = f.operationIds.get("route-1")!;
    void f.service.reconcileAfterRestart(5000, f.operations);
    await until(() => f.closes.length === 1);
    const outcome = await f.service.shutdown(60, f.operations);
    assert.deepEqual(outcome, { confirmed: [], unconfirmed: ["route-1"] });
    const record = await f.operations.read(id);
    assert.equal(record.stage, "unknown-possibly-live");
    assert.equal(record.cleanupConfirmed, false);
  } finally {
    await f.cleanup();
  }
});

test("shutdown during the journal read still journals the pending close", async () => {
  const f = await crashedProcess([attachedOwned], confirm);
  try {
    const id = f.operationIds.get("route-1")!;
    const real = f.operations;
    let releaseScan!: () => void;
    const journal = {
      scan: async () => {
        await new Promise<void>((resolve) => (releaseScan = resolve));
        return real.scan();
      },
      list: async () => {
        await new Promise<void>((resolve) => (releaseScan = resolve));
        return real.list();
      },
      recordAbsent: real.recordAbsent.bind(real),
      recordCleanupUnconfirmed: real.recordCleanupUnconfirmed.bind(real),
      recordRecovered: real.recordRecovered.bind(real),
      requestStop: real.requestStop.bind(real),
    };
    const boot = f.service.reconcileAfterRestart(2000, journal);
    void f.service.shutdown(500, real);
    await new Promise((resolve) => setTimeout(resolve, 20));
    releaseScan();
    const outcome = await boot;
    assert.deepEqual(outcome.unconfirmed, ["route-1"]);
    assert.equal((await real.read(id)).stage, "unknown-possibly-live");
    assert.deepEqual(f.closes, []);
  } finally {
    await f.cleanup();
  }
});

test("one unreadable receipt does not discard a valid pending close", async () => {
  const f = await crashedProcess([attachedOwned], confirm);
  try {
    await writeFile(join(f.root, "00000000-0000-0000-0000-000000000000.json"), "{ not json");
    const outcome = await f.service.reconcileAfterRestart(2000, f.operations);
    assert.deepEqual(f.closes, [route1]);
    assert.deepEqual(outcome, { confirmed: ["route-1"], unconfirmed: [] });
    // Narrowest honest behaviour: the owner sees the count; Turn on is not refused,
    // since no owner action can clear an unreadable file.
    assert.equal(f.service.state().journalUnreadable, 1);
    await f.turnOn();
  } finally {
    await f.cleanup();
  }
});

const settleWithin = async <T>(promise: Promise<T>, ms: number): Promise<T | "hung"> =>
  Promise.race([promise, new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), ms))]);

test("a retry after the restart deadline joins the in-flight close and never overlaps it", async () => {
  let active = 0;
  let peak = 0;
  const releases: Array<(route: Route) => void> = [];
  const f = await crashedProcess([attachedOwned], () => {
    active += 1;
    peak = Math.max(peak, active);
    return new Promise<Route>((resolve) =>
      releases.push((route) => {
        active -= 1;
        resolve(route);
      })
    );
  });
  try {
    assert.deepEqual(await f.service.reconcileAfterRestart(40, f.operations), { confirmed: [], unconfirmed: ["route-1"] });
    // The deadline has passed and the provider call is still open: a retry waits on it.
    const retry = f.service.reconcileKnownHandle(route1, true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(f.closes.length, 1, "no second provider close while the first is open");
    releases[0]!(await unconfirmed(route1));
    await retry;
    // Only now may another close start.
    const next = f.service.reconcileKnownHandle(route1, true);
    await until(() => f.closes.length === 2);
    assert.equal(peak, 1, "provider closes never overlapped");
    releases[1]!(await confirm(route1));
    await next;
  } finally {
    await f.cleanup();
  }
});

test("an owner stop of a confirmed route joins a close already in flight for the same handle", async () => {
  let release!: (route: Route) => void;
  const f = await crashedProcess([attachedOwned], () => new Promise<Route>((resolve) => (release = resolve)));
  try {
    const routes = (f.inner as unknown as { routes: Map<string, Route> }).routes;
    routes.set("route-1", { ...seed, cleanup: { nextAction: null, state: "confirmed" }, handle: route1 });
    const close = f.service.reconcileKnownHandle(route1, true);
    await until(() => f.closes.length === 1);
    const stop = f.service.stop("route-1", 1, true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(f.closes.length, 1, "the confirmed-route stop did not start a second provider close");
    release(await confirm(route1));
    await Promise.all([close, stop]);
  } finally {
    await f.cleanup();
  }
});

test("a confirmed or absent outcome stays recorded whatever order independent writers run in", async () => {
  const f = await crashedProcess([attachedOwned], confirm);
  try {
    const journal = f.operations;
    const id = f.operationIds.get("route-1")!;
    await journal.recordAbsent(id);
    await journal.recordCleanupUnconfirmed(id, route1);
    let record = await journal.read(id);
    assert.equal(record.cleanupConfirmed, true);
    assert.equal(record.stage, "settled");
    // Concurrent writers, weak call first, then strong.
    const second = await f.operations.read(id);
    assert.equal(second.cleanupConfirmed, true);
    for (const order of ["weak-first", "strong-first"]) {
      const root = await mkdtemp(join(tmpdir(), "reachability-journal-"));
      try {
        const ops = new ReachabilityOperations(root, true);
        const { operationId } = await ops.start("start", null, async () => seed, intentFor("gozar-owned"));
        await until(async () => (await ops.read(operationId)).stage === "settled");
        const weak = () => ops.recordCleanupUnconfirmed(operationId, route1);
        const strong = () => ops.recordRecovered(operationId, { ...seed, cleanup: { nextAction: null, state: "confirmed" }, handle: route1 });
        await Promise.all(order === "weak-first" ? [weak(), strong()] : [strong(), weak()]);
        await ops.recordCleanupUnconfirmed(operationId, route1);
        record = await ops.read(operationId);
        assert.equal(record.cleanupConfirmed, true, order);
        assert.equal(record.stage, "settled", order);
        assert.equal(record.recovery, null, order);
      } finally {
        await rm(root, { force: true, recursive: true });
      }
    }
  } finally {
    await f.cleanup();
  }
});

test("slow journal writes do not hold the restart outcome past the deadline, and the debt stays", async () => {
  const f = await crashedProcess([attachedOwned], () => new Promise<Route>(() => {}));
  try {
    const real = f.operations;
    const journal = {
      scan: () => real.scan(),
      recordAbsent: real.recordAbsent.bind(real),
      recordRecovered: real.recordRecovered.bind(real),
      requestStop: real.requestStop.bind(real),
      recordCleanupUnconfirmed: () => new Promise<void>(() => {}),
    };
    const started = Date.now();
    const outcome = await settleWithin(f.service.reconcileAfterRestart(40, journal), 2000);
    assert.notEqual(outcome, "hung", "the caller outcome is bounded");
    assert.ok(Date.now() - started < 1500);
    assert.deepEqual(outcome, { confirmed: [], unconfirmed: ["route-1"] });
    assert.equal(f.service.state().reconciling, false);
    await assert.rejects(f.turnOn(), { code: "cleanup_debt" });
    assert.deepEqual(restartCandidates(await real.list()).map((c) => c.handle.id), ["route-1"], "the record is still a candidate next boot");
  } finally {
    await f.cleanup();
  }
});

test("a journal scan that fails, or misses the deadline, is reported apart from unreadable records", async () => {
  const f = await crashedProcess([attachedOwned], confirm);
  try {
    assert.equal(f.service.state().journalScan, "ok");
    const real = f.operations;
    const journal = { ...{ scan: async (): Promise<never> => { throw new Error("disk"); } }, recordAbsent: real.recordAbsent.bind(real), recordCleanupUnconfirmed: real.recordCleanupUnconfirmed.bind(real), recordRecovered: real.recordRecovered.bind(real), requestStop: real.requestStop.bind(real) };
    assert.deepEqual(await f.service.reconcileAfterRestart(500, journal), { confirmed: [], unconfirmed: [] });
    const state = f.service.state();
    assert.equal(state.journalScan, "unavailable");
    assert.equal(state.journalUnreadable, 0);
  } finally {
    await f.cleanup();
  }
  const slow = await crashedProcess([attachedOwned], confirm);
  try {
    const real = slow.operations;
    const journal = { scan: () => new Promise<never>(() => {}), recordAbsent: real.recordAbsent.bind(real), recordCleanupUnconfirmed: real.recordCleanupUnconfirmed.bind(real), recordRecovered: real.recordRecovered.bind(real), requestStop: real.requestStop.bind(real) };
    const outcome = await settleWithin(slow.service.reconcileAfterRestart(40, journal), 2000);
    assert.deepEqual(outcome, { confirmed: [], unconfirmed: [] });
    assert.equal(slow.service.state().journalScan, "unavailable");
    assert.equal(slow.service.state().reconciling, false);
  } finally {
    await slow.cleanup();
  }
});

test("exact-handle evidence uses the whole handle: kind, id and generation", () => {
  const start = (operationId: string, handle: Handle): OperationRecord => ({
    cleanupConfirmed: false,
    failureCode: null,
    handle,
    intent: intentFor("gozar-owned"),
    kind: "start",
    operationId,
    recovery: null,
    route: null,
    stage: "unknown-possibly-live",
    stopTombstone: false,
  });
  const stop = (operationId: string, handle: Handle): OperationRecord => ({
    ...start(operationId, handle),
    cleanupConfirmed: true,
    kind: "stop",
    stage: "settled",
  });
  const g1: Handle = { generation: 1, id: "r", kind: "attached" };
  const g2: Handle = { generation: 2, id: "r", kind: "attached" };
  const other: Handle = { generation: 1, id: "r", kind: "external" };
  // An owner stop for another generation or kind of the same id is not evidence for g1.
  assert.deepEqual(restartCandidates([start("a", g1), stop("b", g2)]).map((c) => c.operationId), ["a"]);
  assert.deepEqual(restartCandidates([start("a", g1), stop("b", other)]).map((c) => c.operationId), ["a"]);
  assert.deepEqual(restartCandidates([start("a", g1), stop("b", g1)]), []);
  // Two generations of one id are two candidates, not one.
  assert.deepEqual(restartCandidates([start("a", g1), start("b", g2)]).map((c) => c.operationId), ["a", "b"]);
  assert.deepEqual(restartCandidates([start("a", g1), start("b", g1)]).map((c) => c.operationId), ["a"]);
});

test("a retry for a retained handle does not rebind or stop the route the lifecycle tracks", async () => {
  const f = await crashedProcess([attachedOwned], () => unconfirmed(route1));
  try {
    const tracked: Handle = { generation: 1, id: "live-route", kind: "attached" };
    f.inner.lifecycle = { ...initialLifecycle(), evidence: "verified", handle: tracked, phase: "verified" } as never;
    const before = f.service.state().lifecycle;
    const route = await f.service.reconcileKnownHandle(route1, true);
    assert.equal(route?.cleanup.state, "unconfirmed");
    const after = f.service.state().lifecycle;
    assert.deepEqual(after.handle, tracked, "the tracked handle stays bound");
    assert.equal(after.phase, before.phase);
    assert.equal(after.stopRequested, false, "the tracked route is not stopped");
    // And the lifecycle is not stuck: the tracked route can still be stopped normally.
    assert.equal(f.closes.length, 1);
  } finally {
    await f.cleanup();
  }
});

test("a session route the last process left live is closed by its exact handle and never adopted", async () => {
  const session: Spec = { id: "session-1", kind: "session", ownership: "gozar-owned" };
  const f = await crashedProcess([session, { id: "durable-1", kind: "durable", ownership: "gozar-owned" }], confirm);
  try {
    const outcome = await f.service.reconcileAfterRestart(2000, f.operations);
    assert.deepEqual(f.closes, [{ id: "session-1", generation: 1, kind: "session" }]);
    assert.deepEqual(outcome, { confirmed: ["session-1"], unconfirmed: [] });
    const record = await f.operations.read(f.operationIds.get("session-1")!);
    assert.equal(record.stage, "settled");
    assert.equal(record.cleanupConfirmed, true);
    assert.equal(f.service.state().lifecycle.handle, null, "the old session route is never adopted");
    assert.deepEqual(f.service.state().routes, []);
    await f.turnOn();
    // A second pass finds nothing owed.
    await f.service.reconcileAfterRestart(2000, f.operations);
    assert.equal(f.closes.length, 1);
  } finally {
    await f.cleanup();
  }
});

test("a session route Gozar no longer holds settles as absent and does not block Turn on", async () => {
  const f = await crashedProcess([{ id: "session-1", kind: "session", ownership: "gozar-owned" }], () => Promise.reject(gone()));
  try {
    assert.deepEqual(await f.service.reconcileAfterRestart(2000, f.operations), { confirmed: ["session-1"], unconfirmed: [] });
    assert.equal((await f.operations.read(f.operationIds.get("session-1")!)).cleanupConfirmed, true);
    await f.turnOn();
  } finally {
    await f.cleanup();
  }
});

const gen = (generation: number): Handle => ({ generation, id: "route-1", kind: "attached" });

test("two generations of one id are two handles: separate closes, separate outcomes, only the outstanding one blocks Turn on", async () => {
  let secondConfirms = false;
  const f = await crashedProcess(
    [
      { ...attachedOwned, generation: 1 },
      { ...attachedOwned, generation: 2 },
    ],
    (handle) => (handle.generation === 1 || secondConfirms ? confirm(handle) : unconfirmed(handle))
  );
  try {
    const outcome = await f.service.reconcileAfterRestart(2000, f.operations);
    // One close per exact handle: the second generation never joins the first one's provider call.
    assert.deepEqual(f.closes.map((handle) => handle.generation).sort(), [1, 2]);
    assert.deepEqual(outcome, { confirmed: ["route-1"], unconfirmed: ["route-1"] });
    const first = await f.operations.read(f.operationIds.get("route-1@1")!);
    const second = await f.operations.read(f.operationIds.get("route-1@2")!);
    assert.equal(first.cleanupConfirmed, true, "generation 1 confirmed");
    assert.equal(second.cleanupConfirmed, false, "generation 2 stays owed");
    assert.equal(second.stage, "unknown-possibly-live");
    // The confirmed generation does not clear the other's route or its debt.
    assert.deepEqual(f.service.state().routes.map((route) => route.handle.generation), [2]);
    await assert.rejects(f.turnOn(), { code: "cleanup_debt" });
    // An owner stop for the outstanding handle closes only that handle, and clears the debt.
    secondConfirms = true;
    await f.service.reconcileKnownHandle(gen(2), true);
    assert.equal(f.closes.filter((handle) => handle.generation === 1).length, 1);
    await f.turnOn();
  } finally {
    await f.cleanup();
  }
});

test("two generations of one id close concurrently and settle independently when both are slow", async () => {
  const releases = new Map<number, (route: Route) => void>();
  const f = await crashedProcess(
    [
      { ...attachedOwned, generation: 1 },
      { ...attachedOwned, generation: 2 },
    ],
    (handle) => new Promise<Route>((resolve) => releases.set(handle.generation, resolve))
  );
  try {
    const pass = f.service.reconcileAfterRestart(5000, f.operations);
    await until(() => f.closes.length === 2);
    releases.get(2)!(await confirm(gen(2)));
    releases.get(1)!(await unconfirmed(gen(1)));
    assert.deepEqual(await pass, { confirmed: ["route-1"], unconfirmed: ["route-1"] });
    assert.equal((await f.operations.read(f.operationIds.get("route-1@2")!)).cleanupConfirmed, true);
    assert.equal((await f.operations.read(f.operationIds.get("route-1@1")!)).cleanupConfirmed, false);
    await assert.rejects(f.turnOn(), { code: "cleanup_debt" });
  } finally {
    await f.cleanup();
  }
});

test("shutdown still answers, unconfirmed, when the journal hangs under a boot-pending close", async () => {
  const f = await crashedProcess([attachedOwned], () => new Promise<Route>(() => {}));
  try {
    const real = f.operations;
    const journal = {
      scan: () => real.scan(),
      recordAbsent: real.recordAbsent.bind(real),
      recordCleanupUnconfirmed: () => new Promise<void>(() => {}),
      recordRecovered: () => new Promise<void>(() => {}),
      requestStop: real.requestStop.bind(real),
    };
    void f.service.reconcileAfterRestart(5000, journal);
    await until(() => f.closes.length === 1);
    const started = Date.now();
    const outcome = await settleWithin(f.service.shutdown(60, journal), 2000);
    assert.notEqual(outcome, "hung", "shutdown is bounded by its budget, not by the stalled journal");
    assert.ok(Date.now() - started < 1000);
    assert.deepEqual(outcome, { confirmed: [], unconfirmed: ["route-1"] });
    assert.deepEqual(f.closes, [route1]);
    assert.deepEqual(restartCandidates(await real.list()).map((c) => c.handle.id), ["route-1"], "the record is still a candidate next boot");
  } finally {
    await f.cleanup();
  }
});

for (const strong of ["recovered", "absent"] as const) {
  for (const finish of ["success", "failure"] as const) {
    test(`a start effect that finishes ${finish} after ${strong} cleanup evidence cannot erase it`, async () => {
      const root = await mkdtemp(join(tmpdir(), "reachability-merge-"));
      try {
        const operations = new ReachabilityOperations(root, true);
        let end!: (result: { route?: Route; error?: Error }) => void;
        const { operationId } = await operations.start(
          "start",
          null,
          () => new Promise<Route>((resolve, reject) => (end = ({ route, error }) => (route ? resolve(route) : reject(error)))),
          intentFor("gozar-owned")
        );
        const route: Route = { ...seed, cleanup: { nextAction: null, state: "confirmed" }, handle: route1, published: null, state: "released" };
        if (strong === "recovered") await operations.recordRecovered(operationId, route);
        else await operations.recordAbsent(operationId);
        // The operation effect only now returns, behind a settlement the journal already holds.
        end(finish === "success" ? { route } : { error: Object.assign(new Error("late"), { route }) });
        const running = (operations as unknown as { running: Set<string> }).running;
        await until(() => !running.has(operationId));
        const record = await operations.read(operationId);
        assert.equal(record.cleanupConfirmed, true);
        assert.equal(record.stage, "settled");
        assert.equal(record.recovery, null);
        assert.deepEqual(restartCandidates([record]), []);
      } finally {
        await rm(root, { force: true, maxRetries: 10, recursive: true, retryDelay: 25 });
      }
    });
  }
}

test("a start effect that finishes after an explicit unconfirmed record leaves it unconfirmed", async () => {
  const root = await mkdtemp(join(tmpdir(), "reachability-merge-"));
  try {
    const operations = new ReachabilityOperations(root, true);
    let end!: (route: Route) => void;
    const { operationId } = await operations.start("start", null, () => new Promise<Route>((resolve) => (end = resolve)), intentFor("gozar-owned"));
    await operations.recordCleanupUnconfirmed(operationId, route1);
    end({ ...seed, handle: route1 });
    const running = (operations as unknown as { running: Set<string> }).running;
    await until(() => !running.has(operationId));
    const record = await operations.read(operationId);
    assert.equal(record.cleanupConfirmed, false);
    assert.equal(record.stage, "unknown-possibly-live");
    assert.equal(record.recovery?.available, true);
  } finally {
    await rm(root, { force: true, maxRetries: 10, recursive: true, retryDelay: 25 });
  }
});

for (const strong of ["recovered", "absent"] as const) {
  test(`a read that normalizes an orphan after ${strong} cleanup evidence cannot erase it`, async () => {
    const root = await mkdtemp(join(tmpdir(), "reachability-read-race-"));
    try {
      // The journal a crashed process left: an "applying" record no live operation owns.
      const before = new ReachabilityOperations(root, true);
      const { operationId } = await before.start("start", null, () => new Promise<Route>(() => {}), intentFor("gozar-owned"));
      // The restarted host's status read. If it still normalizes on disk, that
      // write hangs on this gate until the recovery below has finished, so a
      // stale write can only land after the confirmed evidence, which is the
      // ordering the old code allowed and this test forbids.
      const operations = new ReachabilityOperations(root, true);
      let releaseStale: (() => void) | undefined;
      const patch = operations as unknown as { write(record: OperationRecord): Promise<void> };
      const realWrite = patch.write.bind(operations);
      patch.write = (record: OperationRecord) => {
        if (
          record.recovery !== null && record.stage === "unknown-possibly-live" &&
          record.failureCode === null && record.cleanupConfirmed === undefined && releaseStale === undefined
        ) {
          return new Promise<void>((resolve) => {
            releaseStale = resolve;
          }).then(() => realWrite(record));
        }
        return realWrite(record);
      };
      const stale = operations.read(operationId);
      // A separate recovery writes confirmed evidence through its own journal.
      const fresh = new ReachabilityOperations(root, true);
      const route: Route = { ...seed, cleanup: { nextAction: null, state: "confirmed" }, handle: route1, published: null, state: "released" };
      if (strong === "recovered") await fresh.recordRecovered(operationId, route);
      else await fresh.recordAbsent(operationId);
      releaseStale?.();
      await stale;
      const record = await fresh.read(operationId);
      assert.equal(record.stage, "settled");
      assert.equal(record.cleanupConfirmed, true);
      assert.equal(record.recovery, null);
      if (strong === "recovered") assert.deepEqual(record.handle, route1);
    } finally {
      await rm(root, { force: true, maxRetries: 10, recursive: true, retryDelay: 25 });
    }
  });
}

test("/state answers degraded, never all-clear, when the journal listing fails or never answers", async () => {
  const f = await crashedProcess([attachedOwned], confirm);
  try {
    const call = await ownerApi(f, { stateJournalTimeoutMs: 50 });
    const healthy = (await call("GET", "/state")).data;
    assert.equal(healthy.journalScan, "ok");
    assert.equal(healthy.operationsAvailable, true);
    f.operations.list = async () => {
      throw new Error("disk");
    };
    const rejected = await settleWithin(call("GET", "/state"), 2000);
    assert.notEqual(rejected, "hung");
    assert.equal((rejected as { data?: { journalScan: string } }).data?.journalScan, "unavailable", JSON.stringify(rejected));
    assert.equal((rejected as { data: { operationsAvailable: boolean } }).data.operationsAvailable, false);
    f.operations.list = () => new Promise<never>(() => {});
    const stalled = await settleWithin(call("GET", "/state"), 2000);
    assert.notEqual(stalled, "hung");
    assert.equal((stalled as { data?: { journalScan: string } }).data?.journalScan, "unavailable", JSON.stringify(stalled));
    assert.equal((stalled as { data: { operationsAvailable: boolean } }).data.operationsAvailable, false);
    // An in-memory route the service still tracks must not make the degraded
    // answer await a per-route journal read: the bounded list is /state's only
    // journal source, so its attribution and stop intent stay unknown.
    const routes = (f.inner as unknown as { routes: Map<string, Route> }).routes;
    routes.set(
      "live-route",
      { ...seed, handle: { id: "live-route", generation: 1, kind: "attached" }, operationId: "22222222-2222-2222-2222-222222222222" }
    );
    f.operations.read = () => new Promise<never>(() => {});
    const degraded = await settleWithin(call("GET", "/state"), 2000);
    assert.notEqual(degraded, "hung", "the degraded answer does not wait on the per-route journal read");
    const data = (degraded as { data?: { journalScan: string; operationsAvailable: boolean; routes: Array<{ handle: { id: string }; providerId: string | null; stopRequested?: boolean }> } }).data!;
    assert.equal(data.journalScan, "unavailable");
    assert.equal(data.operationsAvailable, false);
    const projected = data.routes.find((route) => route.handle.id === "live-route")!;
    assert.equal(projected.providerId, null, "attribution stays unknown when the record is not in the bounded list");
    assert.equal("stopRequested" in projected, false, "stop intent stays unknown without the journal list");
  } finally {
    await f.cleanup();
  }
});
