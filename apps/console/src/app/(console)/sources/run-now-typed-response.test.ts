// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { mock, test } from "node:test";

// executeRunNow returns HTTP 202.json(controllerResult), including refusals.
// Real fetch parser + action: mocking operator-runs would hide this defect.
const revalidated: string[] = [];
mock.module("next/cache", {
  namedExports: {
    revalidatePath: (path: string) => revalidated.push(path),
  },
});
class Unreachable extends Error {}
mock.module(new URL("../lib/owner-token.ts", import.meta.url).href, {
  namedExports: {
    ReferenceServerUnreachableError: Unreachable,
    getAsInternalUrl: () => "http://reference.invalid",
    withOwnerSessionCookie: async (init: RequestInit) => init,
  },
});
const actions = import("./actions.ts");
for (const response of [
  {
    run_id: "run_a",
    trace_id: "trace_a",
    status: "owner_action_required",
    owner_action: { kind: "confirm_browser_access", connectionId: "cin_1", proposalId: "proposal_1" },
  },
  {
    run_id: "run_b",
    trace_id: "trace_b",
    status: "placement_refused",
    placement_failure: { code: "unsupported_binding", instanceKey: "browser", reason: "unsupported" },
  },
] as const) {
  test(`HTTP 202 ${response.status} never announces a started sync`, async () => {
    const { runConnectorNowAction } = await actions;
    const original = globalThis.fetch;
    globalThis.fetch = async () => Response.json(response, { status: 202 });
    revalidated.length = 0;
    try {
      const result = await runConnectorNowAction("gmail", "cin_1");
      assert.equal(result.ok, false);
      assert.equal(result.ok === false && result.reason, response.status);
      assert.deepEqual(
        revalidated,
        ["/sources", "/sources/cin_1"],
        "the current page must load the new review instead of keeping its old access information"
      );
    } finally {
      globalThis.fetch = original;
    }
  });
}

for (const [label, body] of [
  ["unknown status", { run_id: "run_1", trace_id: "trace_1", status: "new_outcome" }],
  ["missing identity", {}],
  ["refusal without discriminator", { run_id: "run_1", owner_action: { connectionId: "cin_1" } }],
  [
    "foreign placement result",
    {
      status: "placement_refused",
      placement_failure: { code: "unsupported_binding", instanceKey: "b", connectionId: "foreign" },
    },
  ],
  [
    "foreign owner action",
    {
      status: "owner_action_required",
      owner_action: { kind: "confirm_browser_access", connectionId: "foreign", proposalId: "p" },
    },
  ],
  ["foreign connection result", { run_id: "run_1", connection_id: "foreign", status: "started" }],
] as const) {
  test(`HTTP 202 ${label} is not a started sync`, async () => {
    const { runConnectorNowAction } = await actions;
    const original = globalThis.fetch;
    globalThis.fetch = async () => Response.json(body, { status: 202 });
    try {
      const result = await runConnectorNowAction("gmail", "cin_1");
      assert.equal(result.ok, false);
    } finally {
      globalThis.fetch = original;
    }
  });
}
for (const status of [undefined, "started", "waiting_for_browser_surface", "starting_surface", "deferred"] as const) {
  test(`HTTP 202 ${status ?? "legacy"} keeps the ordinary or waiting path truthful`, async () => {
    const { runConnectorNowAction } = await actions;
    const original = globalThis.fetch;
    globalThis.fetch = async () =>
      Response.json({ run_id: "run_1", trace_id: "trace_1", ...(status ? { status } : {}) }, { status: 202 });
    try {
      const result = await runConnectorNowAction("gmail", "cin_1");
      assert.equal(result.ok, status === undefined || status === "started");
      if (!result.ok) {
        assert.equal(result.reason, "surface_pending");
      }
    } finally {
      globalThis.fetch = original;
    }
  });
}

for (const [code, message] of [
  ["binding_unavailable", "Check the binding service setup and availability"],
  ["binding_cleanup_unverified", "Resolve resource cleanup"],
] as const) {
  test(`HTTP 202 ${code} gives its specific next step without announcing sync`, async () => {
    const { runConnectorNowAction } = await actions;
    const original = globalThis.fetch;
    globalThis.fetch = async () =>
      Response.json(
        { status: "placement_refused", placement_failure: { code, instanceKey: "browser", connectionId: "cin_1" } },
        { status: 202 }
      );
    try {
      const result = await runConnectorNowAction("gmail", "cin_1");
      assert.equal(result.ok, false);
      assert.ok(!result.ok && result.reason === "placement_refused");
      assert.ok(result.message.includes(message));
    } finally {
      globalThis.fetch = original;
    }
  });
}
test("an unknown placement reason fails closed", async () => {
  const { runConnectorNowAction } = await actions;
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json(
      { status: "placement_refused", placement_failure: { code: "new_reason", instanceKey: "browser" } },
      { status: 202 }
    );
  try {
    const result = await runConnectorNowAction("gmail", "cin_1");
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.reason !== "placement_refused");
  } finally {
    globalThis.fetch = original;
  }
});
