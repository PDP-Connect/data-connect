// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { mock } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const AS_URL = "http://as.internal";

class Redirect extends Error {
  constructor(readonly target: string) {
    super(`redirect ${target}`);
  }
}

const calls: { fetches: { auth: string | null; method: string; url: string }[]; packages: string[]; access: string[] } = {
  access: [],
  fetches: [],
  packages: [],
};

mock.module("next/cache", { namedExports: { revalidatePath: () => {} } });
mock.module("next/navigation", {
  namedExports: {
    redirect: (target: string) => {
      throw new Redirect(target);
    },
  },
});
mock.module("../../lib/dashboard-access.ts", {
  namedExports: {
    requireDashboardAccess: async (path: string) => {
      calls.access.push(path);
    },
  },
});
mock.module("../../lib/owner-token.ts", {
  namedExports: { getAsInternalUrl: () => AS_URL, getOwnerToken: async () => "owner-token" },
});
mock.module("../../lib/ref-client.ts", {
  namedExports: {
    revokeGrantPackage: async (packageId: string) => {
      calls.packages.push(packageId);
    },
  },
});

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const headers = new Headers(init?.headers);
  calls.fetches.push({ auth: headers.get("authorization"), method: init?.method ?? "GET", url: String(input) });
  return new Response("{}", { status: 200 });
}) as typeof fetch;


function form(entries: readonly (readonly [string, string])[]): FormData {
  const data = new FormData();
  for (const [name, value] of entries) data.append(name, value);
  return data;
}

async function run(entries: readonly (readonly [string, string])[]): Promise<string> {
  calls.access = [];
  calls.fetches = [];
  calls.packages = [];
  const { revokeGrantAccessAction } = await import("./revoke-action.ts");
  try {
    await revokeGrantAccessAction(form(entries));
  } catch (err) {
    if (err instanceof Redirect) return err.target;
    throw err;
  }
  assert.fail("the action always ends in a redirect");
}

test("one access is removed through POST /grants/{access id}/revoke with the owner bearer", async () => {
  const target = await run([
    ["grant_id", "grant-abc"],
    ["confirm_revoke", "yes"],
    ["return_to", "/grants/grant-abc"],
  ]);
  // RAISE-RULES 5: removal acts only after the confirmation and the owner check.
  assert.deepEqual(calls.access, ["/grants/grant-abc"]);
  assert.deepEqual(calls.fetches, [
    { auth: "Bearer owner-token", method: "POST", url: `${AS_URL}/grants/grant-abc/revoke` },
  ]);
  assert.deepEqual(calls.packages, []);
  assert.equal(target, "/grants/grant-abc?access_removed=yes");
});

test("without the confirmation field nothing is removed", async () => {
  const target = await run([
    ["grant_id", "grant-abc"],
    ["return_to", "/grants/grant-abc"],
  ]);
  assert.deepEqual(calls.fetches, []);
  assert.deepEqual(calls.packages, []);
  assert.equal(target, "/grants/grant-abc");
});

test("a whole app removes its packages through the package revoke and loose access one by one", async () => {
  const target = await run([
    ["package_id", "pkg-1"],
    ["grant_id", "grant-loose"],
    ["confirm_revoke", "yes"],
    ["return_to", "/connect"],
  ]);
  assert.deepEqual(calls.packages, ["pkg-1"]);
  assert.deepEqual(
    calls.fetches.map((call) => call.url),
    [`${AS_URL}/grants/grant-loose/revoke`]
  );
  assert.equal(target, "/connect?access_removed=yes");
});

test("an unknown return address falls back to Apps", async () => {
  const target = await run([
    ["grant_id", "grant-abc"],
    ["confirm_revoke", "yes"],
    ["return_to", "https://elsewhere.example/"],
  ]);
  assert.equal(target, "/grants?access_removed=yes");
});

test("a failed removal returns with one plain sentence", async () => {
  globalThis.fetch = (async () => new Response("{}", { status: 500 })) as typeof fetch;
  const target = await run([
    ["grant_id", "grant-abc"],
    ["confirm_revoke", "yes"],
    ["return_to", "/grants/grant-abc"],
  ]);
  assert.match(target, /^\/grants\/grant-abc\?remove_error=/);
});

test("the action is a server action", async () => {
  const src = await readFile(`${HERE}revoke-action.ts`, "utf8");
  assert.match(src, /^"use server"/);
});
