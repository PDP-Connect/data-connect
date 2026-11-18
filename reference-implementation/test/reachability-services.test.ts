// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ReachabilityError } from "../server/reachability/approvals.ts";
import { ReachabilitySetups } from "../server/reachability/setups.ts";
import { mountOwnerReachability } from "../server/routes/owner-reachability.ts";

type Handler = (request: unknown, response: unknown) => Promise<unknown>;

function draftFor(draftId: string) {
  return {
    baseRevision: "r0",
    draftId,
    scopeId: "scope",
    configuration: { actions: [], credentials: {}, inputRequirements: [], revision: "r0", scopeId: "scope", values: {} },
  };
}
function setupView(operationId: string, state: string, resources: unknown[] = []) {
  return {
    operationId,
    revision: 1,
    state,
    scope: { registryId: "reg", scopeId: "scope", providerId: "svc", configurationRevision: "r0", draftId: "d1" },
    evidence: { known: false, reason: "pending" },
    nextAction: null,
    resources,
  };
}

// Mounts the real routes over a fake host service and a real journal.
async function harness(dir: string, setups = new ReachabilitySetups(dir)) {
  const routes = new Map<string, Handler>();
  const app = {
    get: (path: string, ...args: Handler[]) => routes.set(`GET ${path}`, args.at(-1) as Handler),
    post: (path: string, ...args: Handler[]) => routes.set(`POST ${path}`, args.at(-1) as Handler),
  };
  const calls = { begin: 0, resume: 0, setupRuns: [] as string[], discards: 0 };
  const known = new Set<string>();
  let draftCounter = 0;
  const service = {
    providerLabel: async () => "Tunnel service",
    begin: async () => {
      calls.begin++;
      return draftFor(`d${++draftCounter}`);
    },
    resume: async (_provider: string, draftId: string) => {
      calls.resume++;
      if (!known.has(draftId) && draftId !== "d1") throw new ReachabilityError("draft_not_found");
      return draftFor(draftId);
    },
    runSetupOperation: async (ref: { operationId: string }) => {
      calls.setupRuns.push(ref.operationId);
      known.add(ref.operationId);
      return setupView(ref.operationId, "pending");
    },
    readSetupOperation: async (ref: { operationId: string }) => {
      if (!known.has(ref.operationId)) throw new ReachabilityError("route_not_found");
      return setupView(ref.operationId, "complete");
    },
    cancelSetupOperation: async (ref: { operationId: string }) => setupView(ref.operationId, "cancelled"),
    discard: async () => {
      calls.discards++;
      return { discarded: true };
    },
    commit: async () => draftFor("d1").configuration,
    state: () => ({ evidenceSource: null, lifecycle: null, reasons: {}, routes: [], starting: false }),
  };
  const pass = async (_r: unknown, _s: unknown, next?: () => void) => next?.();
  mountOwnerReachability(app as never, {
    service: service as never,
    operations: { list: async () => [] } as never,
    setups,
    requireToken: pass,
    requireOwner: pass,
    requireCsrf: pass,
    usage: () => {
      throw new Error("unused");
    },
  } as never);
  async function call(method: "GET" | "POST", path: string, body?: unknown, params: Record<string, string> = {}, query = {}) {
    let payload: unknown;
    let status = 200;
    const response = {
      setHeader: () => undefined,
      status(code: number) {
        status = code;
        return response;
      },
      json(value: unknown) {
        payload = value;
        return response;
      },
    };
    await routes.get(`${method} /v1/owner/reachability${path}`)!({ body, params, query }, response);
    return { status, payload: payload as { data?: any; error?: any } };
  }
  return { call, calls, known, setups };
}

const start = { providerId: "svc", draftId: "d1", actionId: "a", expectedConfigurationRevision: "r0", usage: "durable" };

test("a second start for the same service reuses the setup operation id", async () => {
  const dir = await mkdtemp(join(tmpdir(), "svc-journal-"));
  try {
    const { call, calls } = await harness(dir);
    const first = (await call("POST", "/setups", start)).payload.data;
    const second = (await call("POST", "/setups", start)).payload.data;
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.entry.setup.operationId, first.entry.setup.operationId);
    assert.equal(calls.setupRuns.length, 1, "the setup effect runs once");
    const state = (await call("GET", "/state")).payload.data;
    assert.equal(state.services.length, 1);
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("concurrent starts for one service create one operation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "svc-journal-"));
  try {
    const { call, calls } = await harness(dir);
    const results = await Promise.all([call("POST", "/setups", start), call("POST", "/setups", start)]);
    const ids = new Set(results.map((item) => item.payload.data.entry.setup.operationId));
    assert.equal(ids.size, 1);
    assert.equal(calls.setupRuns.length, 1);
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("a second draft request for a service resumes its draft", async () => {
  const dir = await mkdtemp(join(tmpdir(), "svc-journal-"));
  try {
    const { call, calls } = await harness(dir);
    const first = (await call("POST", "/drafts", { providerId: "svc", expectedRevision: "r0", usage: "durable" })).payload.data;
    const second = (await call("POST", "/drafts", { providerId: "svc", expectedRevision: "r0", usage: "durable" })).payload.data;
    assert.equal(first.draftId, second.draftId);
    assert.equal(calls.begin, 1);
    assert.equal(calls.resume, 1);
    const state = (await call("GET", "/state")).payload.data;
    assert.deepEqual(
      state.services.map((item: { draftId: string }) => item.draftId),
      [first.draftId]
    );
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("a draft the host lost is replaced, still one per service", async () => {
  const dir = await mkdtemp(join(tmpdir(), "svc-journal-"));
  try {
    const { call, calls, setups } = await harness(dir);
    await setups.recordDraft({ providerId: "svc", providerLabel: "Tunnel service", draftId: "gone", usage: null });
    const draft = (await call("POST", "/drafts", { providerId: "svc", expectedRevision: "r0" })).payload.data;
    assert.equal(calls.begin, 1);
    assert.notEqual(draft.draftId, "gone");
    assert.equal((await setups.list()).length, 1);
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("services survive a restart and discard keeps a setup in progress", async () => {
  const dir = await mkdtemp(join(tmpdir(), "svc-journal-"));
  try {
    const before = await harness(dir);
    await before.call("POST", "/drafts", { providerId: "svc", expectedRevision: "r0", usage: "durable" });
    const started = (await before.call("POST", "/setups", { ...start, draftId: "d1" })).payload.data;
    const after = await harness(dir, new ReachabilitySetups(dir));
    const state = (await after.call("GET", "/state")).payload.data;
    assert.equal(state.services.length, 1);
    assert.equal(state.services[0].setup.operationId, started.entry.setup.operationId);
    await after.call("POST", "/drafts/:id/discard", {}, { id: "d1" });
    const kept = (await after.call("GET", "/state")).payload.data.services;
    assert.equal(kept.length, 1);
    assert.equal(kept[0].draftId, null);
    assert.ok(kept[0].setup);
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("a cancelled setup with nothing to remove leaves the journal", async () => {
  const dir = await mkdtemp(join(tmpdir(), "svc-journal-"));
  try {
    const { call, setups } = await harness(dir);
    const started = (await call("POST", "/setups", start)).payload.data;
    await call("POST", "/drafts/:id/discard", {}, { id: "d1" });
    await call("POST", "/setup-operations/:id/cancel", { providerId: "svc" }, { id: started.entry.setup.operationId });
    assert.deepEqual(await setups.list(), []);
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("adopt keeps a setup the host knows, drops unknown ones, and never makes a second card", async () => {
  const dir = await mkdtemp(join(tmpdir(), "svc-journal-"));
  try {
    const { call, known, setups } = await harness(dir);
    known.add("op-live");
    const legacy = {
      providerId: "svc",
      providerLabel: "Tunnel service",
      draftId: "d1",
      actionId: "a",
      expectedConfigurationRevision: "r0",
      usage: "durable",
    };
    const unknown = (await call("POST", "/setups/adopt", { ...legacy, operationId: "op-stale" })).payload.data;
    assert.deepEqual(unknown, { adopted: false, reason: "unknown" });
    const live = (await call("POST", "/setups/adopt", { ...legacy, operationId: "op-live" })).payload.data;
    assert.deepEqual(live, { adopted: true });
    known.add("op-second");
    const second = (await call("POST", "/setups/adopt", { ...legacy, operationId: "op-second" })).payload.data;
    assert.deepEqual(second, { adopted: false, reason: "service_has_setup" });
    const entries = await setups.list();
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.setup!.operationId, "op-live");
  } finally {
    await rm(dir, { recursive: true });
  }
});
