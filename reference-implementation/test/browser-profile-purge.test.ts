// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createBrowserProfilePurger, purgeLocalBrowserProfiles } from "../server/browser-profile-purge.ts";

function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-purge-unit-"));
  return fn(dir).finally(() => rmSync(dir, { force: true, recursive: true }));
}

function seedProfile(root: string, name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "Cookies"), "fixture");
  return dir;
}

test("local purge removes every <profileName>__<id> directory and nothing else", async () => {
  await withTempDir(async (root) => {
    const target = seedProfile(root, "amazon__cin_a");
    const legacyName = seedProfile(root, "amazon-orders__cin_a");
    const otherConnection = seedProfile(root, "amazon__cin_b");
    const longerId = seedProfile(root, "amazon__x__cin_a");
    const unscoped = seedProfile(root, "amazon");

    const result = await purgeLocalBrowserProfiles(root, "cin_a");

    assert.deepEqual(result, { removed: 2, status: "purged", target: "local" });
    assert.equal(existsSync(target), false);
    assert.equal(existsSync(legacyName), false);
    assert.equal(existsSync(otherConnection), true);
    assert.equal(existsSync(longerId), true, "an id that is only a suffix of a longer id is not matched");
    assert.equal(existsSync(unscoped), true);
  });
});

test("local purge refuses a symlinked profile entry and leaves the link target intact", async () => {
  await withTempDir(async (dir) => {
    const root = join(dir, "profiles");
    mkdirSync(root);
    const outside = seedProfile(dir, "outside-precious");
    symlinkSync(outside, join(root, "amazon__cin_escape"));

    const result = await purgeLocalBrowserProfiles(root, "cin_escape");

    assert.equal(result.status, "failed");
    assert.equal(result.status === "failed" ? result.error_code : null, "profile_purge_refused_path");
    assert.equal(existsSync(join(outside, "Cookies")), true, "the symlink target outside the root survives");
  });
});

test("local purge refuses a profile a running browser still holds (SingletonLock)", async () => {
  await withTempDir(async (root) => {
    const live = seedProfile(root, "amazon__cin_live");
    // This test process stands in for the live browser: same host, live pid.
    symlinkSync(`${hostname()}-${process.pid}`, join(live, "SingletonLock"));

    const result = await purgeLocalBrowserProfiles(root, "cin_live");

    assert.equal(result.status === "failed" ? result.error_code : null, "profile_purge_in_use");
    assert.equal(result.status === "failed" ? result.message.includes("again") : null, false);
    assert.equal(existsSync(join(live, "Cookies")), true);
  });
});

test("local purge clears a dangling SingletonLock (dead pid or another host) and removes the profile", async () => {
  const deadPid = spawnSync(process.execPath, ["-e", ""]).pid;
  for (const lockTarget of [`${hostname()}-${deadPid}`, `somehost-${process.pid}`, "not-a-lock"]) {
    await withTempDir(async (root) => {
      const stale = seedProfile(root, "amazon__cin_stale");
      symlinkSync(lockTarget, join(stale, "SingletonLock"));
      symlinkSync("cookie-fixture", join(stale, "SingletonCookie"));
      symlinkSync(join(root, "no-such-socket"), join(stale, "SingletonSocket"));

      const result = await purgeLocalBrowserProfiles(root, "cin_stale");

      assert.deepEqual(result, { removed: 1, status: "purged", target: "local" }, `lock ${lockTarget}`);
      assert.equal(existsSync(stale), false);
      assert.throws(() => lstatSync(join(stale, "SingletonLock")));
    });
  }
});

test("local purge refuses a connection id that is not a safe path segment", async () => {
  await withTempDir(async (root) => {
    const sibling = seedProfile(root, "amazon__x");
    for (const id of ["../x", "a/b", "", "..", "x y"]) {
      const result = await purgeLocalBrowserProfiles(root, id);
      assert.equal(result.status, "failed", `id ${JSON.stringify(id)} must be refused`);
    }
    assert.equal(existsSync(sibling), true);
  });
});

test("local purge reports absent when the root or the profile does not exist", async () => {
  await withTempDir(async (root) => {
    assert.deepEqual(await purgeLocalBrowserProfiles(join(root, "missing"), "cin_a"), {
      status: "absent",
      target: "local",
    });
    assert.deepEqual(await purgeLocalBrowserProfiles(root, "cin_a"), { status: "absent", target: "local" });
  });
});

function hostEnv(): NodeJS.ProcessEnv {
  return {
    PDPP_BROWSER_SURFACE_HOST_ENDPOINT: "http://127.0.0.1:9/",
    PDPP_BROWSER_SURFACE_HOST_TOKEN: "host-token-fixture",
    PDPP_BROWSER_SURFACE_MODE: "host",
  };
}

test("host mode asks the desktop host to reset the connector profile with the bearer token", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const purge = createBrowserProfilePurger({
    env: hostEnv(),
    fetchImpl: (async (url: string, init: RequestInit) => {
      calls.push({ init, url });
      return new Response(null, { status: 204 });
    }) as typeof fetch,
    logger: null,
  });

  const result = await purge({ connectorInstanceId: "cin_a", connectorKey: "amazon" });

  assert.deepEqual(result, { removed: 1, status: "purged", target: "host" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "http://127.0.0.1:9/browser-surface/profiles/amazon");
  assert.equal(calls[0]?.init.method, "DELETE");
  assert.deepEqual(calls[0]?.init.headers, { Authorization: "Bearer host-token-fixture" });
});

test("host mode reports a refused reset (live lease) and logs it, without throwing", async () => {
  const logged: Record<string, unknown>[] = [];
  const purge = createBrowserProfilePurger({
    env: hostEnv(),
    fetchImpl: (async () =>
      new Response(JSON.stringify({ error: "profile_in_use" }), { status: 409 })) as unknown as typeof fetch,
    logger: { error: (obj) => logged.push(obj) },
  });

  const result = await purge({ connectorInstanceId: "cin_a", connectorKey: "amazon" });

  assert.equal(result.status, "failed");
  assert.equal(result.status === "failed" ? result.error_code : null, "profile_purge_host_profile_in_use");
  assert.equal(logged.length, 1);
  assert.equal(logged[0]?.connection_id, "cin_a");
});

test("an unreachable host is reported as a failed purge, not an exception", async () => {
  const logged: Record<string, unknown>[] = [];
  const purge = createBrowserProfilePurger({
    env: hostEnv(),
    fetchImpl: (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch,
    logger: { error: (obj) => logged.push(obj) },
  });

  const result = await purge({ connectorInstanceId: "cin_a", connectorKey: "amazon" });

  assert.deepEqual(result, {
    error_code: "profile_purge_failed",
    message: "fetch failed",
    status: "failed",
    target: "host",
  });
  assert.equal(logged.length, 1);
});

test("host mode keeps a session another active connection of the connector still shares", async () => {
  const calls: string[] = [];
  const counted: unknown[] = [];
  const purge = createBrowserProfilePurger({
    countOtherActiveConnections: (input) => {
      counted.push(input);
      return 2;
    },
    env: hostEnv(),
    fetchImpl: (async (url: string) => {
      calls.push(url);
      return new Response(null, { status: 204 });
    }) as typeof fetch,
    logger: null,
  });

  const result = await purge({ connectorInstanceId: "cin_a", connectorKey: "amazon", ownerSubjectId: "owner_1" });

  assert.equal(result.status, "shared");
  assert.equal(result.status === "shared" ? result.other_connection_count : null, 2);
  assert.match(result.status === "shared" ? result.message : "", /shared with 2 other accounts/);
  assert.equal(calls.length, 0, "the host profile is not reset");
  assert.deepEqual(counted, [{ connectorInstanceId: "cin_a", connectorKey: "amazon", ownerSubjectId: "owner_1" }]);
});

test("host mode resets the session when no other active connection shares it", async () => {
  const calls: string[] = [];
  const purge = createBrowserProfilePurger({
    countOtherActiveConnections: () => 0,
    env: hostEnv(),
    fetchImpl: (async (url: string) => {
      calls.push(url);
      return new Response(null, { status: 204 });
    }) as typeof fetch,
    logger: null,
  });

  const result = await purge({ connectorInstanceId: "cin_a", connectorKey: "amazon", ownerSubjectId: "owner_1" });

  assert.deepEqual(result, { removed: 1, status: "purged", target: "host" });
  assert.equal(calls.length, 1);
});

test("local mode never reports shared: each Core connection has its own profile", async () => {
  await withTempDir(async (root) => {
    seedProfile(root, "amazon__cin_a");
    const purge = createBrowserProfilePurger({
      countOtherActiveConnections: () => 3,
      env: { PDPP_BROWSER_PROFILE_ROOT: root },
      logger: null,
    });

    const result = await purge({ connectorInstanceId: "cin_a", connectorKey: "amazon", ownerSubjectId: "owner_1" });

    assert.deepEqual(result, { removed: 1, status: "purged", target: "local" });
  });
});
