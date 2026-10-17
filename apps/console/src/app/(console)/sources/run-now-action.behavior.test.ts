// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `runConnectorNowAction` maps a `connector_not_installed` refusal to its own
 * result, keyed on the reference's error code (never its prose), so the UI can
 * offer "Install <name>" instead of echoing the server sentence.
 */

import assert from "node:assert/strict";
import { mock, test } from "node:test";

class FakeUnreachableError extends Error {}

let nextError: Error | null = null;

const actions = (async () => {
  mock.module("next/cache", { namedExports: { revalidatePath: () => {} } });
  mock.module(new URL("../lib/owner-token.ts", import.meta.url).href, {
    namedExports: { ReferenceServerUnreachableError: FakeUnreachableError },
  });
  mock.module(new URL("../lib/operator-runs.ts", import.meta.url).href, {
    namedExports: {
      runConnectionNow: async () => {
        if (nextError) throw nextError;
        return { run_id: "run_1", trace_id: "trace_1" };
      },
      runConnectorNow: async () => ({ run_id: "run_1", trace_id: "trace_1" }),
    },
  });
  return await import("./actions.ts");
})();

function rejection(message: string, code: string | null, connectorId: string | null = null): Error {
  return Object.assign(new Error(message), { code, connectorId, status: 409 });
}

test("a connector_not_installed refusal becomes a typed result with the install key", async () => {
  const { runConnectorNowAction } = await actions;
  nextError = rejection(
    "No runnable connector implementation is available for chase: no verified install is active, and its manifest is not a reference fixture",
    "connector_not_installed",
    "chase"
  );
  assert.deepEqual(await runConnectorNowAction("chase", "cin_chase"), {
    connector_id: "chase",
    message: "This connector isn't installed on this server yet, so it can't sync.",
    ok: false,
    reason: "connector_not_installed",
  });
});

test("the refusal falls back to the caller's connector id when the envelope omits connector_id", async () => {
  const { runConnectorNowAction } = await actions;
  nextError = rejection("No runnable connector implementation", "connector_not_installed");
  const result = await runConnectorNowAction("chase", "cin_chase");
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, "connector_not_installed");
  assert.equal(result.ok === false && result.reason === "connector_not_installed" && result.connector_id, "chase");
});

test("other refusals keep the generic after-server error, even when the prose mentions installs", async () => {
  const { runConnectorNowAction } = await actions;
  nextError = rejection("Active connector install is invalid for chase: hash mismatch", null);
  assert.deepEqual(await runConnectorNowAction("chase", "cin_chase"), {
    message: "Active connector install is invalid for chase: hash mismatch",
    ok: false,
    phase: "after_server",
    reached_server: true,
    reason: "error",
  });
});
