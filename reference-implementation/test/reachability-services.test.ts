// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
async function harness(dir: string, setups = new ReachabilitySetups(dir), passwordSet?: () => Promise<boolean>) {
  const routes = new Map<string, Handler>();
  const app = {
    get: (path: string, ...args: Handler[]) => routes.set(`GET ${path}`, args.at(-1) as Handler),
    post: (path: string, ...args: Handler[]) => routes.set(`POST ${path}`, args.at(-1) as Handler),
  };
  const hooks: { cancel: (operationId: string) => unknown; readError: string | null } = {
    cancel: (operationId) => setupView(operationId, "cancelled"),
    readError: null,
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
      if (hooks.readError) throw new ReachabilityError(hooks.readError as never);
      if (!known.has(ref.operationId)) throw new ReachabilityError("route_not_found");
      return setupView(ref.operationId, "complete");
    },
    cancelSetupOperation: async (ref: { operationId: string }) => hooks.cancel(ref.operationId),
    reload: async (_provider: string, draftId: string) => {
      if (draftId === "lost") throw new ReachabilityError("draft_not_found");
      return draftFor(draftId);
    },
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
    passwordSet,
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
  return { call, calls, hooks, known, setups, service };
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
    assert.deepEqual(second, { adopted: false, reason: "cancelled" });
    const entries = await setups.list();
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.setup!.operationId, "op-live");
    assert.deepEqual(entries[0]!.cleanup, []);
  } finally {
    await rm(dir, { recursive: true });
  }
});

const legacySetup = {
  providerId: "svc",
  providerLabel: "Tunnel service",
  draftId: "d1",
  actionId: "a",
  expectedConfigurationRevision: "r0",
  usage: "durable",
};

test("a second live setup the host cannot cancel cleanly stays in the journal as a leftover", async () => {
  const dir = await mkdtemp(join(tmpdir(), "svc-journal-"));
  try {
    const { call, hooks, known, setups } = await harness(dir);
    known.add("op-live");
    known.add("op-second");
    await call("POST", "/setups/adopt", { ...legacySetup, operationId: "op-live" });
    hooks.cancel = (id) => setupView(id, "blocked", [{ removal: "required" }]);
    const second = (await call("POST", "/setups/adopt", { ...legacySetup, operationId: "op-second" })).payload.data;
    assert.deepEqual(second, { adopted: false, reason: "needs_cleanup" });
    hooks.cancel = () => {
      throw new ReachabilityError("host_unavailable" as never);
    };
    known.add("op-third");
    assert.equal(
      (await call("POST", "/setups/adopt", { ...legacySetup, operationId: "op-third" })).payload.data.reason,
      "needs_cleanup"
    );
    const entry = (await setups.list())[0]!;
    assert.equal(entry.setup!.operationId, "op-live");
    assert.deepEqual(entry.cleanup, ["op-second", "op-third"]);
    const state = (await call("GET", "/state")).payload.data;
    assert.deepEqual(state.services[0].cleanup, ["op-second", "op-third"]);
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("a leftover setup leaves the journal once it is cancelled with nothing to remove", async () => {
  const dir = await mkdtemp(join(tmpdir(), "svc-journal-"));
  try {
    const { call, hooks, known, setups } = await harness(dir);
    known.add("op-live");
    known.add("op-second");
    await call("POST", "/setups/adopt", { ...legacySetup, operationId: "op-live" });
    hooks.cancel = (id) => setupView(id, "blocked", [{ removal: "required" }]);
    await call("POST", "/setups/adopt", { ...legacySetup, operationId: "op-second" });
    hooks.cancel = (id) => setupView(id, "cancelled");
    await call("POST", "/setup-operations/:id/cancel", { providerId: "svc" }, { id: "op-second" });
    assert.deepEqual((await setups.list())[0]!.cleanup, []);
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("adopt never turns a host error into adopted:false", async () => {
  const dir = await mkdtemp(join(tmpdir(), "svc-journal-"));
  try {
    const { call, hooks, setups } = await harness(dir);
    hooks.readError = "host_unavailable";
    const answer = await call("POST", "/setups/adopt", { ...legacySetup, operationId: "op-live" });
    assert.notEqual(answer.status, 200);
    assert.equal(answer.payload.data, undefined);
    assert.deepEqual(await setups.list(), []);
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("adopt-draft records a draft the host holds, and drops one it has lost", async () => {
  const dir = await mkdtemp(join(tmpdir(), "svc-journal-"));
  try {
    const { call, setups } = await harness(dir);
    const input = { providerId: "svc", providerLabel: "Tunnel service", usage: "durable" };
    assert.deepEqual((await call("POST", "/setups/adopt-draft", { ...input, draftId: "lost" })).payload.data, {
      adopted: false,
      reason: "unknown",
    });
    assert.deepEqual(await setups.list(), []);
    assert.deepEqual((await call("POST", "/setups/adopt-draft", { ...input, draftId: "d1" })).payload.data, { adopted: true });
    assert.deepEqual((await call("POST", "/setups/adopt-draft", { ...input, draftId: "d9" })).payload.data, {
      adopted: false,
      reason: "service_has_draft",
    });
    assert.equal((await setups.list())[0]!.draftId, "d1");
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("a journal that is not valid is kept and reported, never overwritten", async () => {
  for (const content of ["{}", "null", "[null]", "not json", '[{"providerId":"svc"}]']) {
    const dir = await mkdtemp(join(tmpdir(), "svc-journal-"));
    try {
      await writeFile(join(dir, "services.json"), content);
      const setups = new ReachabilitySetups(dir);
      await assert.rejects(() => setups.list(), (error: { code?: string }) => error.code === "setups_journal_corrupt");
      await assert.rejects(
        () => setups.recordDraft({ providerId: "svc", providerLabel: "S", draftId: "d", usage: null }),
        (error: { code?: string }) => error.code === "setups_journal_corrupt"
      );
      assert.equal(await readFile(join(dir, "services.json"), "utf8"), content);
    } finally {
      await rm(dir, { recursive: true });
    }
  }
});

test("the journal keeps only known fields", async () => {
  const dir = await mkdtemp(join(tmpdir(), "svc-journal-"));
  try {
    await writeFile(
      join(dir, "services.json"),
      JSON.stringify([{ providerId: "svc", providerLabel: "S", token: "secret", setup: null }])
    );
    const [entry] = await new ReachabilitySetups(dir).list();
    assert.deepEqual(entry, {
      providerId: "svc",
      providerLabel: "S",
      draftId: null,
      usage: null,
      committed: false,
      setup: null,
      cleanup: [],
    });
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("a save syncs the directory after the rename, and the parent when it made the directory", async () => {
  const parent = await mkdtemp(join(tmpdir(), "svc-journal-"));
  try {
    const root = join(parent, "nested");
    const synced: string[] = [];
    const setups = new ReachabilitySetups(root, async (path) => void synced.push(path));
    await setups.recordDraft({ providerId: "svc", providerLabel: "S", draftId: "d", usage: null });
    assert.deepEqual(synced, [parent, root]);
    synced.length = 0;
    await setups.recordDraft({ providerId: "svc", providerLabel: "S", draftId: "d2", usage: null });
    assert.deepEqual(synced, [root]);
  } finally {
    await rm(parent, { recursive: true });
  }
});

test("public reachability errors never echo raw messages, causes or properties", async () => {
  const { publicReachabilityError } = await import("../server/routes/owner-reachability.ts");
  const secret = "token=abc123 password=hunter2 secret://vault/key /var/lib/app/state.json";
  const error = Object.assign(new Error(secret), { code: "route_not_found", cause: new Error(secret), detail: secret });
  const unknown = Object.assign(new Error(secret), { code: secret });
  for (const candidate of [error, unknown, secret, { message: secret }]) {
    const shown = JSON.stringify(publicReachabilityError(candidate));
    for (const part of ["abc123", "hunter2", "secret://", "/var/lib"]) assert.equal(shown.includes(part), false);
  }
});

test("state reports whether the owner has set a password", async () => {
  const dir = await mkdtemp(join(tmpdir(), "svc-journal-"));
  try {
    for (const [hosted, expected] of [[async () => false, false], [async () => true, true], [undefined, true]] as const) {
      const { call } = await harness(dir, undefined, hosted);
      assert.equal((await call("GET", "/state")).payload.data.passwordSet, expected);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("approving a route logs the review id and consent digest it received, and nothing else", async (t) => {
  const routes = new Map<string, Handler>();
  const app = {
    get: (path: string, ...args: Handler[]) => routes.set(`GET ${path}`, args.at(-1) as Handler),
    post: (path: string, ...args: Handler[]) => routes.set(`POST ${path}`, args.at(-1) as Handler),
  };
  const applied: unknown[] = [];
  const service = {
    authorizeDisconnect: async () => undefined,
    operationIntent: () => null,
    precheckApply: async () => undefined,
    apply: async (_operation: string, reviewId: string, approval: unknown) => applied.push([reviewId, approval]),
  };
  const operations = {
    start: async (_kind: string, _handle: unknown, effect: (id: string) => Promise<unknown>) => {
      await effect("op-1");
      return { operationId: "op-1" };
    },
  };
  const pass = async (_r: unknown, _s: unknown, next?: () => void) => next?.();
  mountOwnerReachability(app as never, {
    service: service as never,
    operations: operations as never,
    setups: {} as never,
    requireToken: pass,
    requireOwner: pass,
    requireCsrf: pass,
    usage: () => {
      throw new Error("unused");
    },
  } as never);
  const logged: string[] = [];
  t.mock.method(console, "info", (line: string) => logged.push(line));
  const response = { setHeader: () => undefined, status: () => response, json: () => response };
  await routes.get("POST /v1/owner/reachability/operations")!(
    { body: { reviewId: "rev-9", kind: "route", consentFactsDigest: "consent-v1:abc", acknowledgeDisconnect: true }, params: {} },
    response
  );
  assert.deepEqual(logged, ["[reachability] approve reviewId=rev-9 consentFactsDigest=consent-v1:abc"]);
  assert.deepEqual(applied, [["rev-9", { acknowledgeDisconnect: true, consentFactsDigest: "consent-v1:abc", kind: "route" }]]);
});

test("concurrent draft creation shares one host draft and one journal record", { timeout: 5000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "svc-journal-"));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  try {
    const { call, service, setups } = await harness(dir);
    let begins = 0, records = 0;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    service.begin = async () => { begins++; entered(); await gate; return draftFor("shared-draft"); };
    const record = setups.recordDraft.bind(setups);
    setups.recordDraft = async (input) => { records++; return record(input); };
    const input = { providerId: "svc", expectedRevision: "r0" };
    const first = call("POST", "/drafts", input);
    await started;
    let secondSettled = false;
    const second = call("POST", "/drafts", input).finally(() => { secondSettled = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const settledBeforeRelease = secondSettled, beginsBeforeRelease = begins;
    release();
    const answers = await Promise.all([first, second]);
    assert.equal(settledBeforeRelease, false);
    assert.equal(beginsBeforeRelease, 1);
    assert.deepEqual(answers.map((item) => item.status), [200, 200]);
    assert.deepEqual(answers.map((item) => item.payload.data.draftId), ["shared-draft", "shared-draft"]);
    assert.equal(records, 1);
    assert.equal((await setups.get("svc"))?.draftId, "shared-draft");
  } finally {
    release();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a failed shared draft creation permits a later retry", { timeout: 5000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "svc-journal-"));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  try {
    const { call, service, setups } = await harness(dir);
    let begins = 0, records = 0;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    service.begin = async () => {
      begins++;
      if (begins === 1) { entered(); await gate; throw new ReachabilityError("host_runtime_unavailable"); }
      return draftFor("retry-draft");
    };
    const record = setups.recordDraft.bind(setups);
    setups.recordDraft = async (input) => { records++; return record(input); };
    const input = { providerId: "svc", expectedRevision: "r0" };
    const first = call("POST", "/drafts", input);
    await started;
    const second = call("POST", "/drafts", input);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const beginsBeforeRelease = begins;
    release();
    const answers = await Promise.all([first, second]);
    assert.equal(beginsBeforeRelease, 1);
    for (const answer of answers) {
      assert.equal(answer.status, 409);
      assert.equal(answer.payload.error.code, "host_runtime_unavailable");
    }
    assert.equal(records, 0);
    const retry = await call("POST", "/drafts", input);
    assert.equal(retry.status, 200);
    assert.equal(retry.payload.data.draftId, "retry-draft");
    assert.equal(begins, 2);
    assert.equal(records, 1);
  } finally {
    release();
    await rm(dir, { recursive: true, force: true });
  }
});

test("approval rejects unsafe or oversized identifiers before any logging", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "svc-journal-"));
  const logged: unknown[] = [];
  t.mock.method(console, "info", (...args: unknown[]) => { logged.push(args); });
  try {
    const { call } = await harness(dir);
    for (const field of ["reviewId", "consentFactsDigest"]) {
      for (const invalid of ["line\nforged", "trailing\n", "x".repeat(201), "", "contains space"]) {
        const answer = await call("POST", "/operations", {
          kind: "route", reviewId: "rev-9", consentFactsDigest: "consent-v1:abc", [field]: invalid,
        });
        assert.equal(answer.status, 409);
        assert.equal(answer.payload.error.code, "invalid_input");
        assert.deepEqual(logged, []);
      }
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
