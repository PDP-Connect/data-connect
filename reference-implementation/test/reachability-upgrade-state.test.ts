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
import { createReachabilityService } from "../server/reachability/factory.ts";
import { createHostSecretBackend, createSealedSecretBackend } from "../server/reachability/secret-backend.ts";
import { ReachabilitySetups } from "../server/reachability/setups.ts";
import { mountOwnerReachability } from "../server/routes/owner-reachability.ts";

// The console's own chain and error shaper. Loaded by path so this package's type check does not walk the console.
const consoleSettings = new URL("../../apps/console/src/app/(console)/settings/", import.meta.url);
const { prepareTurnOn } = (await import(new URL("prepare-remote-access.ts", consoleSettings).href)) as {
  prepareTurnOn: (
    request: Request,
    choice: { providerId: string; usage: string }
  ) => Promise<{ kind: string; [key: string]: unknown }>;
};
const { publicError } = (await import(new URL("reachability-errors.ts", consoleSettings).href)) as {
  publicError: (code?: string, message?: string) => Record<string, unknown>;
};
type Request = (path: string, body?: Record<string, unknown>) => Promise<unknown>;

type Handler = (request: unknown, response: unknown) => Promise<unknown>;

async function scratch() {
  const parent = process.env.TEST_TMPDIR ?? join(homedir(), ".tmp");
  await mkdir(parent, { mode: 0o700, recursive: true });
  return mkdtemp(join(parent, "rup-"));
}

// A "process": a fresh service and routes over a state folder that may already hold state.
async function boot(root: string, journal = "reachability-setups") {
  process.env.PDPP_CREDENTIAL_ENCRYPTION_KEY ??= randomBytes(32).toString("hex");
  const home = join(root, "reachability");
  await mkdir(home, { mode: 0o700, recursive: true });
  const service = await createReachabilityService(
    {
      hostCapabilities: {
        "installer.execute": { known: true, value: false },
        "privilege.elevate": { known: true, value: false },
        "runtime.attached": { known: true, value: true },
        "runtime.durable": { known: true, value: false },
        "secrets.backend": { known: true, value: true },
      },
      identity: { bootId: randomUUID(), instanceId: "instance" },
      secretBackend: createHostSecretBackend(createSealedSecretBackend(join(home, "custody"))),
    },
    {
      acknowledgeDisconnect: async () => {},
      currentTarget: async () => "127.0.0.1:3000",
      prepare: async () => {},
      query: {
        home,
        owner: "owner",
        requirements: {
          address: "any",
          payloadAccess: "allow-provider",
          protocols: [],
          reach: "this-device",
          setup: "allow",
          transport: "any",
        },
        schemaVersion: 1,
        target: "127.0.0.1:3000",
      },
    } as never
  );
  const routes = new Map<string, Handler>();
  const app = {
    get: (path: string, ...args: Handler[]) => routes.set(`GET ${path}`, args.at(-1) as Handler),
    post: (path: string, ...args: Handler[]) => routes.set(`POST ${path}`, args.at(-1) as Handler),
  };
  const pass = async (_r: unknown, _s: unknown, next?: () => void) => next?.();
  mountOwnerReachability(
    app as never,
    {
      operations: {
        list: async () => [],
        read: async () => {
          throw new Error("none");
        },
      } as never,
      passwordSet: async () => true,
      requireCsrf: pass,
      requireOwner: pass,
      requireToken: pass,
      service,
      setups: new ReachabilitySetups(join(root, journal)),
      usage: (kind: string) => (kind === "attached" ? { kind } : { kind: "session", lifetimeMs: 3_600_000 }),
    } as never
  );
  // The console's own request function, answered by the real routes.
  const request = async (path: string, body?: Record<string, unknown>) => {
    let payload: { data?: unknown; error?: { code?: string; message?: string } } = {};
    let status = 200;
    const response = {
      json(value: typeof payload) {
        payload = value;
        return response;
      },
      setHeader: () => undefined,
      status(code: number) {
        status = code;
        return response;
      },
    };
    const [route, query] = path.split("?");
    const method = body === undefined ? "GET" : "POST";
    const params: Record<string, string> = {};
    let handler = routes.get(`${method} /v1/owner/reachability${route}`);
    if (!handler) {
      for (const [key, value] of routes) {
        const [verb, pattern] = key.split(" ");
        if (verb !== method) {
          continue;
        }
        const names: string[] = [];
        const regex = new RegExp(
          `^${pattern!.replace(/:([A-Za-z]+)/g, (_m, name) => {
            names.push(name);
            return "([^/]+)";
          })}$`
        );
        const match = regex.exec(`/v1/owner/reachability${route}`);
        if (match) {
          handler = value;
          names.forEach((name, i) => {
            params[name] = decodeURIComponent(match[i + 1]!);
          });
          break;
        }
      }
    }
    assert.ok(handler, `no route for ${method} ${route}`);
    await handler({ body, params, query: Object.fromEntries(new URLSearchParams(query ?? "")) }, response);
    if (status >= 400) {
      return { ok: false as const, ...publicError(payload.error?.code, payload.error?.message) };
    }
    return { data: payload.data, ok: true as const };
  };
  return { request, service, setups: new ReachabilitySetups(join(root, journal)) };
}

const choice = { providerId: "localhost-run", usage: "session" };

test("a first Turn on on an empty profile reaches the review", async (t) => {
  const root = await scratch();
  t.after(() => rm(root, { force: true, recursive: true }));
  const { request } = await boot(root);
  const result = await prepareTurnOn(request, choice);
  assert.equal(result.kind, "ready");
});

test("Turn on after an earlier run committed its draft and the app restarted reaches the review in one click", async (t) => {
  const root = await scratch();
  t.after(() => rm(root, { force: true, recursive: true }));
  // Earlier build: the real chain ran to commit, then the process ended.
  const earlier = await boot(root);
  assert.equal((await prepareTurnOn(earlier.request, choice)).kind, "ready");
  const left = await earlier.setups.get(choice.providerId);
  assert.equal(left?.committed, true, "the leftover entry is committed");
  // New build, same state folder.
  const later = await boot(root);
  const result = await prepareTurnOn(later.request, choice);
  assert.equal(result.kind, "ready");
});

test("every click on a committed leftover reaches the review; none ends at a stale answer", async (t) => {
  const root = await scratch();
  t.after(() => rm(root, { force: true, recursive: true }));
  const earlier = await boot(root);
  await prepareTurnOn(earlier.request, choice);
  const later = await boot(root);
  const outcomes: string[] = [];
  for (let click = 0; click < 3; click++) {
    outcomes.push(
      await prepareTurnOn(later.request, choice).then(
        (r) => r.kind,
        (e) => e?.detail?.code ?? String(e)
      )
    );
  }
  assert.deepEqual(outcomes, ["ready", "ready", "ready"]);
});

test("a committed leftover that also holds a finished setup turns on in one click", async (t) => {
  const root = await scratch();
  t.after(() => rm(root, { force: true, recursive: true }));
  const earlier = await boot(root);
  // The older console's order: draft, then the service's own setup, then commit.
  const catalog = (await earlier.request("/catalog")) as any;
  const provider = catalog.data.providers.find((p: any) => p.providerId === choice.providerId);
  const draft = (await earlier.request("/drafts", {
    expectedRevision: provider.configuration.revision,
    providerId: choice.providerId,
    usage: choice.usage,
  })) as any;
  const started = (await earlier.request("/setups", {
    actionId: "trial-consent",
    draftId: draft.data.draftId,
    expectedConfigurationRevision: draft.data.configuration.revision,
    providerId: choice.providerId,
    usage: choice.usage,
  })) as any;
  assert.equal(started.ok, true);
  assert.equal((await prepareTurnOn(earlier.request, choice)).kind, "ready");
  const entry = await earlier.setups.get(choice.providerId);
  assert.ok(entry?.committed && entry.setup, "the leftover is committed and names a setup");
  const later = await boot(root);
  const outcomes: string[] = [];
  for (let click = 0; click < 2; click++) {
    outcomes.push(
      await prepareTurnOn(later.request, choice).then(
        (r) => r.kind,
        (e) => e?.detail?.code ?? String(e)
      )
    );
  }
  assert.deepEqual(outcomes, ["ready", "ready"]);
});

test("three preparers on one profile all end at a review, never at a stale dead end", async (t) => {
  const root = await scratch();
  t.after(() => rm(root, { force: true, recursive: true }));
  const { request } = await boot(root);
  const results = await Promise.allSettled([prepareTurnOn(request, choice), prepareTurnOn(request, choice), prepareTurnOn(request, choice)]);
  for (const result of results) {
    assert.equal(result.status, "fulfilled", result.status === "rejected" ? String(result.reason?.detail?.code ?? result.reason) : "");
  }
  // A later click after the race still works.
  assert.equal((await prepareTurnOn(request, choice)).kind, "ready");
});

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}
const outcome = (settled: PromiseSettledResult<{ kind: string }>) =>
  settled.status === "fulfilled" ? settled.value.kind : String((settled.reason as any)?.detail?.code ?? settled.reason);

test("a preparer whose commit is refused as stale leaves the draft another preparer committed and is reviewing", async (t) => {
  const root = await scratch();
  t.after(() => rm(root, { force: true, recursive: true }));
  const { request } = await boot(root);
  const firstAtReview = gate();
  const secondDone = gate();
  const firstWrapper: typeof request = async (path, body) => {
    if (path.endsWith("/review")) {
      firstAtReview.open();
      await secondDone.opened;
    }
    return request(path, body);
  };
  const secondWrapper: typeof request = async (path, body) => {
    // The second preparer holds the same draft, then commits after the first one did.
    if (path.endsWith("/commit")) await firstAtReview.opened;
    return request(path, body);
  };
  const first = prepareTurnOn(firstWrapper, choice);
  const second = prepareTurnOn(secondWrapper, choice).finally(() => secondDone.open());
  const results = await Promise.allSettled([first, second]);
  assert.deepEqual(results.map(outcome), ["ready", "ready"]);
});

test("an uncommitted draft left stale by another process is discarded and replaced, not resumed in a loop", async (t) => {
  const root = await scratch();
  t.after(() => rm(root, { force: true, recursive: true }));
  // One process holds an uncommitted draft in its journal, then a second process (its own journal) commits.
  const stale = await boot(root);
  const catalog = (await stale.request("/catalog")) as any;
  const provider = catalog.data.providers.find((p: any) => p.providerId === choice.providerId);
  await stale.request("/drafts", {
    expectedRevision: provider.configuration.revision,
    providerId: choice.providerId,
    usage: choice.usage,
  });
  const other = await boot(root, "other-setups");
  assert.equal((await prepareTurnOn(other.request, choice)).kind, "ready");
  const seen: string[] = [];
  const counting: typeof stale.request = (path, body) => {
    seen.push(`${body === undefined ? "GET" : "POST"} ${path.split("?")[0]}`);
    return stale.request(path, body);
  };
  const result = await prepareTurnOn(counting, choice);
  assert.equal(result.kind, "ready");
  assert.equal(seen.filter((path) => path === "GET /catalog").length <= 3, true, seen.join(" "));
});

test("two windows on one profile, each its own process view, both reach a review", async (t) => {
  const root = await scratch();
  t.after(() => rm(root, { force: true, recursive: true }));
  const { request } = await boot(root);
  const first = await prepareTurnOn(request, choice);
  const second = await prepareTurnOn(request, choice).then(
    (r) => r.kind,
    (e) => e?.detail?.code ?? String(e)
  );
  assert.equal(first.kind, "ready");
  assert.equal(second, "ready");
});

test("a real concurrent change between the catalog read and the draft start: the retry starts fresh and reaches the review", async (t) => {
  const root = await scratch();
  t.after(() => rm(root, { force: true, recursive: true }));
  const { request } = await boot(root);
  let interfered = false;
  // Another window commits a draft after this one read the catalog and before it starts its draft.
  const seen: string[] = [];
  const interfering = async (path: string, body?: Record<string, unknown>) => {
    seen.push(path.split("?")[0]!);
    if (!interfered && path === "/drafts" && body) {
      interfered = true;
      assert.equal((await prepareTurnOn(request, choice)).kind, "ready");
    }
    return request(path, body);
  };
  const result = await prepareTurnOn(interfering, choice);
  assert.equal(interfered, true);
  assert.equal(result.kind, "ready");
  // The first start was refused as stale, so the chain read the catalog a second time.
  assert.equal(seen.filter((path) => path === "/catalog").length >= 2, true, seen.join(" "));
});
