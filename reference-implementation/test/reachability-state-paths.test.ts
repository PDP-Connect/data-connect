// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  fixCommand,
  fixStatePaths,
  inspectStatePaths,
  isFixable,
} from "../server/reachability/state-paths.ts";
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
  const guard = (name: string) => async (_r: unknown, _s: unknown, next?: () => void) => {
    guards.push(name);
    next?.();
  };
  const app = {
    get: (path: string, ...args: never[]) => routes.set(`GET ${path}`, args.at(-1)!),
    post: (path: string, ...args: never[]) => routes.set(`POST ${path}`, args.at(-1)!),
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
