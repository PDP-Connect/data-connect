// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mock, test } from "node:test";

class FakeUnreachableError extends Error {}
let nextError: Error | null = null;
const calls: unknown[][] = [];
const revalidated: string[] = [];
const action = (async () => {
  mock.module("next/cache", { namedExports: { revalidatePath: (path: string) => revalidated.push(path) } });
  mock.module("../lib/owner-token.ts", {
    namedExports: { ReferenceServerUnreachableError: FakeUnreachableError },
  });
  mock.module("../lib/operator-runs.ts", {
    namedExports: {
      runConnectionNow: async (...args: unknown[]) => {
        calls.push(args);
        if (nextError) throw nextError;
        return { run_id: "run_1", trace_id: "trace_1" };
      },
      runConnectorNow: async (...args: unknown[]) => {
        calls.push(args);
        if (nextError) throw nextError;
        return { run_id: "run_1", trace_id: "trace_1" };
      },
    },
  });
  return await import("./actions.ts");
})();

test("run-now action sends force and setup admission through the connection helper", async () => {
  const { runConnectorNowAction } = await action;
  calls.length = 0;
  revalidated.length = 0;
  nextError = null;
  assert.deepEqual(await runConnectorNowAction("gmail", "cin/1", { force: true }), {
    ok: true,
    run_id: "run_1",
    trace_id: "trace_1",
  });
  assert.deepEqual(calls, [["cin/1", { force: true, runAdmission: "setup" }]]);
  assert.deepEqual(revalidated, ["/sources", "/sources/cin%2F1"]);
});

test("run-now distinguishes transport failure from a server rejection", async () => {
  const { runConnectorNowAction } = await action;
  nextError = new FakeUnreachableError("network down");
  assert.deepEqual(await runConnectorNowAction("gmail"), {
    message: "Couldn't reach the reference server, so the sync was not started. Check the deployment is running, then retry.",
    ok: false,
    phase: "before_server",
    reached_server: false,
    reason: "error",
  });
  nextError = Object.assign(new Error("server rejected"), { status: 409 });
  assert.deepEqual(await runConnectorNowAction("gmail"), {
    message: "server rejected",
    ok: false,
    phase: "after_server",
    reached_server: true,
    reason: "error",
  });
});

test("run-now preserves already-running identity for the owner link", async () => {
  const { runConnectorNowAction } = await action;
  nextError = new Error("Connector already has an active run: run_123");
  assert.deepEqual(await runConnectorNowAction("gmail"), {
    message: "Sync already in progress.",
    ok: false,
    reason: "already_running",
    run_id: "run_123",
  });
});
