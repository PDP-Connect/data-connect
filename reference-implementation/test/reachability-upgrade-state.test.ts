// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
// Turn on against a state folder that earlier builds already wrote, with the
// real gozar library and the real routes. Only the host (listener, password)
// is stubbed.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { prepareTurnOn } from "../../apps/console/src/app/(console)/settings/prepare-remote-access.ts";
import { publicError } from "../../apps/console/src/app/(console)/settings/reachability-errors.ts";
import { createReachabilityService } from "../server/reachability/factory.ts";
import { createHostSecretBackend, createSealedSecretBackend } from "../server/reachability/secret-backend.ts";
import { ReachabilitySetups } from "../server/reachability/setups.ts";
import { mountOwnerReachability } from "../server/routes/owner-reachability.ts";

type Handler = (request: unknown, response: unknown) => Promise<unknown>;

async function scratch() {
  const parent = process.env.TEST_TMPDIR ?? join(homedir(), ".tmp");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  return mkdtemp(join(parent, "rup-"));
}

// A "process": a fresh service and routes over a state folder that may already hold state.
async function boot(root: string) {
  process.env.PDPP_CREDENTIAL_ENCRYPTION_KEY ??= randomBytes(32).toString("hex");
  const home = join(root, "reachability");
  await mkdir(home, { recursive: true, mode: 0o700 });
  const service = await createReachabilityService(
    {
      identity: { instanceId: "instance", bootId: randomUUID() },
      hostCapabilities: {
        "installer.execute": { known: true, value: false },
        "privilege.elevate": { known: true, value: false },
        "runtime.attached": { known: true, value: true },
        "runtime.durable": { known: true, value: false },
        "secrets.backend": { known: true, value: true },
      },
      secretBackend: createHostSecretBackend(createSealedSecretBackend(join(home, "custody"))),
    },
    {
      query: {
        schemaVersion: 1, home, owner: "owner",
        requirements: { reach: "this-device", transport: "any", payloadAccess: "allow-provider", address: "any", setup: "allow", protocols: [] },
        target: "127.0.0.1:3000",
      },
      prepare: async () => {},
      currentTarget: async () => "127.0.0.1:3000",
      acknowledgeDisconnect: async () => {},
    } as never
  );
  const routes = new Map<string, Handler>();
  const app = {
    get: (path: string, ...args: Handler[]) => routes.set(`GET ${path}`, args.at(-1) as Handler),
    post: (path: string, ...args: Handler[]) => routes.set(`POST ${path}`, args.at(-1) as Handler),
  };
  const pass = async (_r: unknown, _s: unknown, next?: () => void) => next?.();
  mountOwnerReachability(app as never, {
    service,
    operations: { list: async () => [], read: async () => { throw new Error("none"); } } as never,
    setups: new ReachabilitySetups(join(root, "reachability-setups")),
    passwordSet: async () => true,
    requireToken: pass, requireOwner: pass, requireCsrf: pass,
    usage: (kind: string) => (kind === "attached" ? { kind } : { kind: "session", lifetimeMs: 3_600_000 }),
  } as never);
  // The console's own request function, answered by the real routes.
  const request = async (path: string, body?: Record<string, unknown>) => {
    let payload: { data?: unknown; error?: { code?: string; message?: string } } = {};
    let status = 200;
    const response = {
      setHeader: () => undefined,
      status(code: number) { status = code; return response; },
      json(value: typeof payload) { payload = value; return response; },
    };
    const [route, query] = path.split("?");
    const method = body === undefined ? "GET" : "POST";
    const params: Record<string, string> = {};
    let handler = routes.get(`${method} /v1/owner/reachability${route}`);
    if (!handler) {
      for (const [key, value] of routes) {
        const [verb, pattern] = key.split(" ");
        if (verb !== method) continue;
        const names: string[] = [];
        const regex = new RegExp(`^${pattern!.replace(/:([A-Za-z]+)/g, (_m, name) => { names.push(name); return "([^/]+)"; })}$`);
        const match = regex.exec(`/v1/owner/reachability${route}`);
        if (match) { handler = value; names.forEach((name, i) => { params[name] = decodeURIComponent(match[i + 1]!); }); break; }
      }
    }
    assert.ok(handler, `no route for ${method} ${route}`);
    await handler({ body, params, query: Object.fromEntries(new URLSearchParams(query ?? "")) }, response);
    if (status >= 400) return { ok: false as const, ...publicError(payload.error?.code, payload.error?.message) };
    return { ok: true as const, data: payload.data };
  };
  return { request, service, setups: new ReachabilitySetups(join(root, "reachability-setups")) };
}

const choice = { providerId: "localhost-run", usage: "session" };

test("a first Turn on on an empty profile reaches the review", async (t) => {
  const root = await scratch();
  t.after(() => rm(root, { recursive: true, force: true }));
  const { request } = await boot(root);
  const result = await prepareTurnOn(request as never, choice);
  assert.equal(result.kind, "ready");
});

test("Turn on after an earlier run committed its draft and the app restarted reaches the review in one click", async (t) => {
  const root = await scratch();
  t.after(() => rm(root, { recursive: true, force: true }));
  // Earlier build: the real chain ran to commit, then the process ended.
  const earlier = await boot(root);
  assert.equal((await prepareTurnOn(earlier.request as never, choice)).kind, "ready");
  const left = await earlier.setups.get(choice.providerId);
  assert.equal(left?.committed, true, "the leftover entry is committed");
  // New build, same state folder.
  const later = await boot(root);
  const result = await prepareTurnOn(later.request as never, choice);
  assert.equal(result.kind, "ready");
});

test("every click on a committed leftover reaches the review; none ends at a stale answer", async (t) => {
  const root = await scratch();
  t.after(() => rm(root, { recursive: true, force: true }));
  const earlier = await boot(root);
  await prepareTurnOn(earlier.request as never, choice);
  const later = await boot(root);
  const outcomes: string[] = [];
  for (let click = 0; click < 3; click++) {
    outcomes.push(await prepareTurnOn(later.request as never, choice).then((r) => r.kind, (e) => e?.detail?.code ?? String(e)));
  }
  assert.deepEqual(outcomes, ["ready", "ready", "ready"]);
});

test("two preparers on one profile both end at a review, never at a stale dead end", async (t) => {
  const root = await scratch();
  t.after(() => rm(root, { recursive: true, force: true }));
  const { request } = await boot(root);
  const results = await Promise.allSettled([prepareTurnOn(request as never, choice), prepareTurnOn(request as never, choice)]);
  for (const result of results) assert.equal(result.status, "fulfilled");
  // A third click after the race still works.
  assert.equal((await prepareTurnOn(request as never, choice)).kind, "ready");
});

test("two windows on one profile, each its own process view, both reach a review", async (t) => {
  const root = await scratch();
  t.after(() => rm(root, { recursive: true, force: true }));
  const { request } = await boot(root);
  const first = await prepareTurnOn(request as never, choice);
  const second = await prepareTurnOn(request as never, choice).then((r) => r.kind, (e) => e?.detail?.code ?? String(e));
  assert.equal(first.kind, "ready");
  assert.equal(second, "ready");
});

test("a real concurrent change between the catalog read and the draft start: the retry starts fresh and reaches the review", async (t) => {
  const root = await scratch();
  t.after(() => rm(root, { recursive: true, force: true }));
  const { request } = await boot(root);
  let interfered = false;
  // Another window commits a draft after this one read the catalog and before it starts its draft.
  const seen: string[] = [];
  const interfering = async (path: string, body?: Record<string, unknown>) => {
    seen.push(path.split("?")[0]!);
    if (!interfered && path === "/drafts" && body) {
      interfered = true;
      assert.equal((await prepareTurnOn(request as never, choice)).kind, "ready");
    }
    return request(path, body);
  };
  const result = await prepareTurnOn(interfering as never, choice);
  assert.equal(interfered, true);
  assert.equal(result.kind, "ready");
  // The first start was refused as stale, so the chain read the catalog a second time.
  assert.equal(seen.filter((path) => path === "/catalog").length >= 2, true, seen.join(" "));
});
