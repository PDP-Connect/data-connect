// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import type { RemoveAppAccessInput } from "../lib/ref-client.ts";
const calls: RemoveAppAccessInput[] = [];
const paths: string[] = [];
let failed = false;
mock.module("next/cache", { namedExports: { revalidatePath: (path: string) => paths.push(path) } });
mock.module("../lib/dashboard-access.ts", {
  namedExports: { requireDashboardAccess: async (path: string) => paths.push(`owner:${path}`) },
});
mock.module("../lib/ref-client.ts", {
  namedExports: {
    removeAppAccess: async (input: RemoveAppAccessInput) => {
      calls.push(input);
      return { failed_count: failed ? 1 : 0 };
    },
  },
});
const { removeAppAction } = await import("./remove-app-action.ts");
test("whole-app and one-source removal keep the complete input and owner gate", async () => {
  const all = { client_ids: ["one", "two"] };
  assert.equal((await removeAppAction(all)).ok, true);
  const source = {
    ...all,
    source: { kind: "connector" as const, id: "gmail", connector_id: "gmail", connection_id: "mail" },
  };
  assert.equal((await removeAppAction(source)).ok, true);
  assert.deepEqual(calls, [all, source]);
  assert.equal(paths.filter((path) => path === "owner:/grants").length, 2);
});
test("a partial removal remains a failure beside the action", async () => {
  failed = true;
  assert.equal((await removeAppAction({ client_ids: ["one"] })).ok, false);
});
