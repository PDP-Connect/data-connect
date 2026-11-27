// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  fixCommand,
  fixNamedPaths,
  fixStatePaths,
  inspectStatePaths,
  isFixable,
} from "../server/reachability/state-paths.ts";
import { createReachabilityService } from "../server/reachability/factory.ts";
import { createHostSecretBackend, createSealedSecretBackend } from "../server/reachability/secret-backend.ts";
import { mountOwnerReachability, publicReachabilityError } from "../server/routes/owner-reachability.ts";

const uid = process.getuid!();
const mode = async (path: string) => (await lstat(path)).mode & 0o777;

async function layout() {
  const base = await realpath(await mkdtemp(join(tmpdir(), "state-paths-")));
  const data = join(base, "data");
  const home = join(data, "reachability");
  await mkdir(home, { recursive: true, mode: 0o700 });
  await chmod(base, 0o700);
  await chmod(data, 0o700);
  return { base, data, home, done: () => rm(base, { recursive: true, force: true }) };
}
const within = <T extends { path: string }>(base: string, paths: T[]) => paths.filter((item) => item.path.startsWith(base));

test("a clean layout names no path", async (t) => {
  const { base, data, home, done } = await layout();
  t.after(done);
  assert.deepEqual(within(base, (await inspectStatePaths(home, data, uid)).paths), []);
});

test("a group-writable folder in the data directory is named, fixed to go-w, and nothing else changes", async (t) => {
  const { base, data, home, done } = await layout();
  t.after(done);
  await chmod(data, 0o775);
  await chmod(home, 0o777);
  const before = within(base, (await inspectStatePaths(home, data, uid)).paths);
  assert.deepEqual(before.map((item) => [item.path, item.reason, item.fixable]), [
    [data, "writable-by-others", true],
    [home, "writable-by-others", true],
  ]);
  const after = await fixStatePaths(home, data, uid);
  assert.deepEqual(within(base, after.paths), []);
  assert.equal(await mode(data), 0o755);
  assert.equal(await mode(home), 0o755);
});

test("it never recurses below the named folders", async (t) => {
  const { data, home, done } = await layout();
  t.after(done);
  const child = join(home, "child");
  await mkdir(child, { mode: 0o700 });
  await chmod(child, 0o777);
  await chmod(home, 0o777);
  await fixStatePaths(home, data, uid);
  assert.equal(await mode(child), 0o777);
});

test("a folder outside the data directory is left alone and its command is offered", async (t) => {
  const { base, data, home, done } = await layout();
  t.after(done);
  await chmod(base, 0o775);
  const report = await inspectStatePaths(home, data, uid);
  const outside = within(base, report.paths).filter((item) => item.path === base);
  assert.deepEqual(outside.map((item) => [item.reason, item.fixable]), [["writable-by-others", false]]);
  const after = await fixStatePaths(home, data, uid);
  assert.equal(await mode(base), 0o775, "nothing outside the data directory changed");
  assert.equal(after.command, fixCommand(after.paths));
  assert.match(after.command ?? "", new RegExp(`^chmod go-w -- .*'${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}'`));
});

test("the command quotes every path", () => {
  const command = fixCommand([
    { path: "/a b/it's", reason: "writable-by-others", fixable: false },
    { path: "/plain", reason: "writable-by-others", fixable: false },
    { path: "/fixable", reason: "writable-by-others", fixable: true },
    { path: "/other", reason: "wrong-owner", fixable: false },
  ]);
  assert.equal(command, `chmod go-w -- '/a b/it'\\''s' '/plain'`);
  assert.equal(fixCommand([{ path: "/x", reason: "wrong-owner", fixable: false }]), null);
});

test("a symlink is refused, even when it points at a writable folder in the data directory", async (t) => {
  const { data, home, done } = await layout();
  t.after(done);
  const real = join(data, "real");
  await mkdir(real, { mode: 0o700 });
  await chmod(real, 0o777);
  const link = join(data, "link");
  await symlink(real, link);
  const { fixNamedPaths } = await import("../server/reachability/state-paths.ts");
  const refused = await fixNamedPaths([{ path: link, reason: "writable-by-others", fixable: true }], data, uid);
  assert.deepEqual(refused, []);
  assert.equal(await mode(real), 0o777);
  assert.equal(home.startsWith(data), true);
});

for (const target of ["data", "reachability"] as const) {
  test(`a symlink at ${target} disables every automatic repair`, async (t) => {
    const { base, data, home, done } = await layout();
    t.after(done);
    const outside = join(base, "outside");
    await mkdir(outside, { mode: 0o700 });
    await chmod(outside, 0o777);
    const link = target === "data" ? data : home;
    await rm(link, { recursive: true });
    await symlink(outside, link);
    const before = await inspectStatePaths(home, data, uid);
    assert.ok(before.paths.some((p) => p.path === link && p.reason === "symlink-in-path"));
    assert.ok(before.paths.every((p) => !p.fixable));
    assert.match(before.command ?? "", /^ls -ld -- /);
    await fixStatePaths(home, data, uid);
    assert.equal(await mode(outside), 0o777);
  });
}

test("a mutable ancestor blocks all repairs and is listed first", async (t) => {
  const { base, data, home, done } = await layout();
  t.after(done);
  await chmod(base, 0o775);
  await chmod(data, 0o775);
  await chmod(home, 0o777);
  const report = await fixStatePaths(home, data, uid);
  assert.equal(within(base, report.paths)[0]?.path, base);
  assert.ok(report.paths.every((p) => !p.fixable));
  assert.ok(report.command?.includes("'" + base + "'"));
  assert.equal(report.command?.includes("'" + data + "'"), false);
  assert.equal(report.command?.includes("'" + home + "'"), false);
  assert.equal(await mode(data), 0o775);
  assert.equal(await mode(home), 0o777);
});

test("a changed dev or ino after open refuses repair", async (t) => {
  const { data, home, done } = await layout();
  t.after(done);
  await chmod(home, 0o777);
  for (const field of ["dev", "ino"] as const) {
    let reads = 0;
    const statPath = async (path: string) => {
      const stat = await lstat(path);
      if (path === home && ++reads === 2) stat[field] += 1;
      return stat;
    };
    const changed = await fixNamedPaths([{ path: home, reason: "writable-by-others", fixable: true }], data, uid, statPath);
    assert.deepEqual(changed, []);
    assert.equal(reads, 2, "identity check follows the pre-open path inspection");
    assert.equal(await mode(home), 0o777);
  }
});

test("a path owned by another uid is never fixable", async (t) => {
  const { data, home, done } = await layout();
  t.after(done);
  await chmod(home, 0o777);
  // Pretend the server runs as someone else: the folder then belongs to a stranger.
  const report = await inspectStatePaths(home, data, uid + 1);
  const mine = report.paths.find((item) => item.path === home);
  assert.deepEqual([mine?.reason, mine?.fixable], ["wrong-owner", false]);
  const stat = await lstat(home);
  assert.equal(isFixable(stat, home, data, uid + 1), false);
  assert.equal(isFixable(stat, home, data, uid), true);
  await fixStatePaths(home, data, uid + 1);
  assert.equal(await mode(home), 0o777);
});

test("the guard rejects a symlink, a file and a path beside the data directory", async (t) => {
  const { base, data, done } = await layout();
  t.after(done);
  const sibling = join(base, "data-other");
  await mkdir(sibling, { mode: 0o777 });
  await chmod(sibling, 0o777);
  assert.equal(isFixable(await lstat(sibling), sibling, data, uid), false, "a name sharing a prefix is not inside");
  const link = join(data, "l");
  await symlink(sibling, link);
  assert.equal(isFixable(await lstat(link), link, data, uid), false);
});

test("the public error for an unsafe state path has its own code, never the message", () => {
  const cause = Object.assign(new Error("Unsafe service state path /secret/place: chmod go-w"), { code: "unsafe_state_path" });
  const thrown = Object.assign(new Error(cause.message), { code: "setup_required", cause });
  const shown = publicReachabilityError(thrown);
  assert.equal(shown.code, "unsafe_state_path");
  assert.doesNotMatch(shown.message, /secret/);
  assert.equal(publicReachabilityError(Object.assign(new Error("x"), { code: "setup_required" })).code, "setup_required");
});

test("the routes inspect and fix through the owner guards, and answer with data only", async (t) => {
  const { data, home, done } = await layout();
  t.after(done);
  await chmod(home, 0o777);
  const routes = new Map<string, (request: unknown, response: unknown) => Promise<unknown>>();
  const guards: string[] = [];
  const registered = new Map<string, unknown[]>();
  const guardFunctions = new Map<string, unknown>();
  const guard = (name: string) => {
    const fn = async (_r: unknown, _s: unknown, next?: () => void) => {
      guards.push(name);
      next?.();
    };
    guardFunctions.set(name, fn);
    return fn;
  };
  const app = {
    get: (path: string, ...args: never[]) => {
      registered.set(`GET ${path}`, args.slice(0, -1));
      routes.set(`GET ${path}`, args.at(-1)!);
    },
    post: (path: string, ...args: never[]) => {
      registered.set(`POST ${path}`, args.slice(0, -1));
      routes.set(`POST ${path}`, args.at(-1)!);
    },
  };
  mountOwnerReachability(app as never, {
    service: null,
    operations: {} as never,
    setups: {} as never,
    requireToken: guard("token"),
    requireOwner: guard("owner"),
    requireCsrf: guard("csrf"),
    usage: () => ({}) as never,
    statePaths: { inspect: () => inspectStatePaths(home, data, uid), fix: () => fixStatePaths(home, data, uid) },
  } as never);
  assert.deepEqual(registered.get("GET /v1/owner/reachability/state-paths"),
    [guardFunctions.get("token"), guardFunctions.get("owner")]);
  assert.deepEqual(registered.get("POST /v1/owner/reachability/state-paths/fix"),
    [guardFunctions.get("token"), guardFunctions.get("owner"), guardFunctions.get("csrf")]);
  assert.ok(guardFunctions.get("token"));
  const call = async (key: string) => {
    let payload: any;
    const response = { setHeader: () => undefined, status: () => response, json: (body: unknown) => ((payload = body), response) };
    await routes.get(key)!({ params: {}, body: {} }, response);
    return payload;
  };
  const read = await call("GET /v1/owner/reachability/state-paths");
  assert.ok(read.data.paths.some((item: { path: string }) => item.path === home));
  const fixed = await call("POST /v1/owner/reachability/state-paths/fix");
  assert.deepEqual(fixed.data.paths.filter((item: { path: string }) => item.path.startsWith(data)), []);
  assert.equal(await mode(home), 0o755);
});

// The real Gozar host, not a hand-made error: an unsafe state folder reaches the route as a
// `setup_required` error with the fix named in `nextAction` (gozar error-normalizer.mjs:27-35).
test("a group-writable state folder, read through the real Gozar host, answers unsafe_state_path", async (t) => {
  const { data, home, done } = await layout();
  t.after(done);
  await chmod(home, 0o775);
  const known = (value: unknown) => ({ known: true, value });
  const service = await createReachabilityService(
    {
      identity: { instanceId: "a".repeat(64), bootId: "boot-1" },
      hostCapabilities: {
        "installer.execute": known(false),
        "privilege.elevate": known(false),
        "runtime.attached": known(true),
        "runtime.durable": known(false),
        "secrets.backend": known(true),
      },
      secretBackend: createHostSecretBackend(createSealedSecretBackend(join(home, "custody"))),
    } as never,
    {
      hostSettings: { read: async () => ({}), apply: async () => ({}) } as never,
      query: {
        schemaVersion: 1,
        home,
        owner: "owner",
        requirements: { reach: "this-device", transport: "any", payloadAccess: "allow-provider", address: "any", setup: "allow", protocols: [] },
        target: "",
      } as never,
      prepare: async () => undefined,
      currentTarget: async () => "127.0.0.1:1",
      acknowledgeDisconnect: async () => undefined,
    } as never
  );
  const thrown = await service.inventory().then(() => null, (error: unknown) => error);
  assert.ok(thrown, "the real host refuses an unsafe state folder");
  assert.equal(publicReachabilityError(thrown).code, "unsafe_state_path");
  void data;
});

test("an unsafe-path code or fix action is found anywhere in a bounded cause chain, never in the message", () => {
  const inner = Object.assign(new Error("x"), { code: "unsafe_state_path" });
  const wrapped = Object.assign(new Error("a"), { code: "internal_error", cause: Object.assign(new Error("b"), { cause: inner }) });
  assert.equal(publicReachabilityError(wrapped).code, "unsafe_state_path");
  const loop: { cause?: unknown; code: string } = { code: "internal_error" };
  loop.cause = loop;
  assert.equal(publicReachabilityError(loop).code, "internal_error");
  const mentioned = Object.assign(new Error("Unsafe service state path /x"), { code: "setup_required" });
  assert.equal(publicReachabilityError(mentioned).code, "setup_required");
});
