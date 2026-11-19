// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { CatalogCache, watchForChanges } from "../server/reachability/catalog-cache.ts";
import { ReachabilityService } from "../server/reachability/service.ts";
import { mountOwnerReachability } from "../server/routes/owner-reachability.ts";

function clock(start = 0) {
  let at = start;
  return { now: () => at, advance: (ms: number) => void (at += ms) };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
const settle = () => new Promise<void>((done) => setImmediate(done));

test("a read newer than the fresh window is served without probing again", async () => {
  const time = clock();
  let reads = 0;
  const cache = new CatalogCache(async () => ({ observedAt: `read-${++reads}` }), { freshMs: 10_000, now: time.now });
  assert.equal((await cache.read()).observedAt, "read-1");
  time.advance(9_999);
  assert.equal((await cache.read()).observedAt, "read-1");
  assert.equal(reads, 1);
});

test("an older read is served at once while one background read replaces it", async () => {
  const time = clock();
  let reads = 0;
  const gate = deferred<void>();
  const cache = new CatalogCache(
    async () => {
      const n = ++reads;
      if (n > 1) await gate.promise;
      return { observedAt: `read-${n}` };
    },
    { freshMs: 10_000, maxStaleMs: 120_000, now: time.now }
  );
  await cache.read();
  time.advance(30_000);
  // The refresh is held open: both callers still get the held read without waiting.
  assert.equal((await cache.read()).observedAt, "read-1");
  assert.equal((await cache.read()).observedAt, "read-1");
  assert.equal(reads, 2, "one background read, not one per caller");
  gate.resolve();
  await settle();
  assert.equal((await cache.read()).observedAt, "read-2");
});

test("a read older than the stale window waits for a new read, and callers share it", async () => {
  const time = clock();
  let reads = 0;
  const gate = deferred<void>();
  const cache = new CatalogCache(
    async () => {
      const n = ++reads;
      if (n > 1) await gate.promise;
      return { observedAt: `read-${n}` };
    },
    { freshMs: 10_000, maxStaleMs: 120_000, now: time.now }
  );
  await cache.read();
  time.advance(121_000);
  const pending = [cache.read(), cache.read(), cache.read()];
  gate.resolve();
  assert.deepEqual((await Promise.all(pending)).map((item) => item.observedAt), ["read-2", "read-2", "read-2"]);
  assert.equal(reads, 2);
});

test("a failed read is not kept: the next caller reads again", async () => {
  let reads = 0;
  const cache = new CatalogCache(async () => {
    if (++reads === 1) throw new Error("probe failed");
    return { observedAt: "ok" };
  });
  await assert.rejects(cache.read(), /probe failed/);
  assert.equal((await cache.read()).observedAt, "ok");
});

test("a failed background refresh leaves the held read in place", async () => {
  const time = clock();
  let reads = 0;
  const cache = new CatalogCache(
    async () => {
      if (++reads === 2) throw new Error("probe failed");
      return { observedAt: `read-${reads}` };
    },
    { freshMs: 1, maxStaleMs: 1_000_000, now: time.now }
  );
  await cache.read();
  time.advance(10);
  assert.equal((await cache.read()).observedAt, "read-1");
  await settle();
  time.advance(10);
  assert.equal((await cache.read()).observedAt, "read-1", "the next caller starts another refresh");
  await settle();
  assert.equal((await cache.read()).observedAt, "read-3");
});

test("invalidate drops the held read, and a read that began before it never fills the cache", async () => {
  let reads = 0;
  const first = deferred<{ observedAt: string }>();
  const cache = new CatalogCache(async () => {
    const n = ++reads;
    return n === 1 ? first.promise : { observedAt: `read-${n}` };
  });
  const before = cache.read();
  cache.invalidate();
  assert.equal((await cache.read()).observedAt, "read-2", "a read after the change does not join the read from before it");
  first.resolve({ observedAt: "read-1" });
  assert.equal((await before).observedAt, "read-1");
  assert.equal((await cache.read()).observedAt, "read-2", "the old read did not replace the newer one");
  assert.equal(reads, 2);
});

test("only a call that is not a read invalidates, and it does so before and after it settles", async () => {
  const events: string[] = [];
  const gate = deferred<string>();
  const api = {
    listProviders: async () => "list",
    readConfigurationDraft: async () => "draft",
    commitConfigurationDraft: () => gate.promise,
    discardConfigurationDraft: async () => {
      throw new Error("refused");
    },
    marker: 7,
  };
  const watched = watchForChanges(api, () => events.push("changed"));
  assert.equal(await watched.listProviders(), "list");
  assert.equal(await watched.readConfigurationDraft(), "draft");
  assert.deepEqual(events, []);
  const commit = watched.commitConfigurationDraft();
  assert.deepEqual(events, ["changed"]);
  gate.resolve("done");
  assert.equal(await commit, "done");
  assert.deepEqual(events, ["changed", "changed"]);
  await assert.rejects(watched.discardConfigurationDraft(), /refused/);
  assert.equal(events.length, 4, "a refused change still invalidates");
  assert.equal(watched.marker, 7);
});

// ---------- the service and the routes ----------

function catalogOf(label: string) {
  return { schemaVersion: 1, catalogRevision: label, observedAt: label, providers: [] };
}
function serviceOver(api: Record<string, unknown>) {
  return new ReachabilityService(api as never, {
    acknowledgeDisconnect: async () => undefined,
    identity: { bootId: "b", instanceId: "i" },
    query: { home: "h", owner: "o" },
  } as never);
}

test("the catalog page shares one read; a change this service makes makes the next page read again", async () => {
  let reads = 0;
  const service = serviceOver({
    listProviders: async () => catalogOf(`read-${++reads}`),
    beginConfigurationDraft: async () => ({ draftId: "d1", configuration: { actions: [], inputRequirements: [] } }),
  });
  for (let page = 0; page < 5; page++) assert.equal((await service.inventory()).observedAt, "read-1");
  assert.equal(reads, 1);
  await service.begin("p", "r0");
  assert.equal((await service.inventory()).observedAt, "read-2");
});

test("a failed change still makes the next catalog read fresh", async () => {
  let reads = 0;
  const service = serviceOver({
    listProviders: async () => catalogOf(`read-${++reads}`),
    beginConfigurationDraft: async () => {
      throw Object.assign(new Error("stale"), { code: "configuration_stale" });
    },
  });
  await service.inventory();
  await assert.rejects(service.begin("p", "r0"));
  assert.equal((await service.inventory()).observedAt, "read-2");
});

type Handler = (request: unknown, response: unknown) => Promise<unknown>;
function routesOver(service: ReachabilityService) {
  const routes = new Map<string, Handler>();
  const app = {
    get: (path: string, ...args: Handler[]) => routes.set(`GET ${path}`, args.at(-1) as Handler),
    post: (path: string, ...args: Handler[]) => routes.set(`POST ${path}`, args.at(-1) as Handler),
  };
  const pass = async (_r: unknown, _s: unknown, next?: () => void) => next?.();
  mountOwnerReachability(app as never, {
    service,
    operations: { list: async () => [] } as never,
    setups: { list: async () => [] } as never,
    requireToken: pass,
    requireOwner: pass,
    requireCsrf: pass,
    usage: () => ({}) as never,
  } as never);
  return (path: string) =>
    new Promise<{ status: number; payload: any }>((done, fail) => {
      let status = 200;
      const response = {
        setHeader: () => undefined,
        status(code: number) {
          status = code;
          return response;
        },
        json(value: unknown) {
          done({ status, payload: value });
          return response;
        },
      };
      routes.get(`GET /v1/owner/reachability${path}`)!({ body: undefined, params: {}, query: {} }, response).catch(fail);
    });
}

test("reads on other routes are answered while the catalog read is still probing", async () => {
  const gate = deferred<void>();
  const service = serviceOver({
    listProviders: async () => {
      await gate.promise;
      return catalogOf("slow");
    },
  });
  const get = routesOver(service);
  const catalog = get("/catalog");
  let catalogDone = false;
  void catalog.then(() => {
    catalogDone = true;
  });
  const state = await get("/state");
  assert.equal(state.status, 200, JSON.stringify(state.payload));
  assert.equal(catalogDone, false, "the service holds no lock: /state did not wait for /catalog");
  gate.resolve();
  assert.equal((await catalog).payload.data.observedAt, "slow");
});
