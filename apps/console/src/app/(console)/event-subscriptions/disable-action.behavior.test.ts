// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test, { mock } from "node:test";

class Redirect extends Error {
  constructor(readonly target: string) {
    super(`redirect ${target}`);
  }
}

const calls: { access: string[]; disabled: { id: string; reason: string | null }[] } = { access: [], disabled: [] };
let failWith: Error | null = null;

mock.module("next/navigation", {
  namedExports: {
    redirect: (target: string) => {
      throw new Redirect(target);
    },
  },
});
mock.module("../lib/dashboard-access.ts", {
  namedExports: {
    requireDashboardAccess: async (path: string) => {
      calls.access.push(path);
    },
  },
});
mock.module("../lib/ref-client.ts", {
  namedExports: {
    disableClientEventSubscription: async (id: string, reason: string | null) => {
      if (failWith) {
        throw failWith;
      }
      calls.disabled.push({ id, reason });
    },
  },
});

async function run(entries: readonly (readonly [string, string])[]): Promise<string> {
  calls.access = [];
  calls.disabled = [];
  const data = new FormData();
  for (const [name, value] of entries) {
    data.append(name, value);
  }
  const { disableSubscriptionAction } = await import("./disable-action.ts");
  try {
    await disableSubscriptionAction(data);
  } catch (err) {
    if (err instanceof Redirect) {
      return err.target;
    }
    throw err;
  }
  assert.fail("the action always ends in a redirect");
}

test("the list form returns to the list with the webhook open, as before the merge", async () => {
  failWith = null;
  const target = await run([
    ["subscription_id", "sub_1"],
    ["confirm_disable", "yes"],
    ["return_to", "list"],
  ]);
  assert.deepEqual(calls.access, ["/event-subscriptions?peek=sub_1"]);
  assert.deepEqual(calls.disabled, [{ id: "sub_1", reason: null }]);
  assert.equal(target, "/event-subscriptions?peek=sub_1");
});

test("a form without return_to keeps the old list behaviour", async () => {
  failWith = null;
  const target = await run([
    ["subscription_id", "sub_1"],
    ["confirm_disable", "yes"],
  ]);
  assert.equal(target, "/event-subscriptions?peek=sub_1");
});

test("the detail form returns to the detail page, as the removed detail-only action did", async () => {
  failWith = null;
  const target = await run([
    ["subscription_id", "sub/2"],
    ["confirm_disable", "yes"],
    ["reason", "  loop  "],
    ["return_to", "detail"],
  ]);
  assert.deepEqual(calls.access, ["/event-subscriptions/sub%2F2"]);
  assert.deepEqual(calls.disabled, [{ id: "sub/2", reason: "loop" }]);
  assert.equal(target, "/event-subscriptions/sub%2F2");
});

test("RAISE-RULES 5: without the ticked box nothing is turned off", async () => {
  failWith = null;
  const target = await run([
    ["subscription_id", "sub_3"],
    ["return_to", "detail"],
  ]);
  assert.deepEqual(calls.disabled, []);
  const url = new URL(target, "http://x");
  assert.equal(url.pathname, "/event-subscriptions/sub_3");
  assert.equal(url.searchParams.get("disable_error"), "Confirmation required: tick the box before submitting.");
});

test("a reason over 256 bytes is refused, not cut", async () => {
  failWith = null;
  const target = await run([
    ["subscription_id", "sub_4"],
    ["confirm_disable", "yes"],
    ["reason", "é".repeat(129)],
  ]);
  assert.deepEqual(calls.disabled, []);
  assert.match(new URL(target, "http://x").searchParams.get("disable_error") ?? "", /256 bytes/);
});

test("a server failure returns to the same page with the error", async () => {
  failWith = new Error("409 grant_revoked");
  const target = await run([
    ["subscription_id", "sub_5"],
    ["confirm_disable", "yes"],
    ["return_to", "detail"],
  ]);
  failWith = null;
  const url = new URL(target, "http://x");
  assert.equal(url.pathname, "/event-subscriptions/sub_5");
  assert.equal(url.searchParams.get("disable_error"), "409 grant_revoked");
});
