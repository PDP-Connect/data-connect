// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import type { DeleteConnectionResult } from "./connection-control-result.ts";
import { deleteConnectionWithRunCancel } from "./delete-connection-with-run-cancel.ts";

function scripted(results: DeleteConnectionResult[]) {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      cancelRun: (runId: string) => {
        calls.push(`cancel:${runId}`);
        return Promise.resolve({ status: "cancel_requested" as const });
      },
      deleteConnection: (connectionId: string) => {
        calls.push(`delete:${connectionId}`);
        const next = results.shift();
        assert.ok(next, "unexpected extra delete call");
        return Promise.resolve(next);
      },
      sleep: () => Promise.resolve(),
    },
  };
}

test("409 run_active with a confirmed cancel: cancels that run, then the retried delete succeeds", async () => {
  const { calls, deps } = scripted([
    { activeRunId: "run_1", status: "run_active" },
    { activeRunId: "run_1", status: "run_active" },
    { deletedRecordCount: 3, status: "deleted" },
  ]);

  const result = await deleteConnectionWithRunCancel("cin_a", "run_1", deps);

  assert.deepEqual(result, { cancelledRunId: "run_1", deletedRecordCount: 3, status: "deleted" });
  assert.deepEqual(calls, ["delete:cin_a", "cancel:run_1", "delete:cin_a", "delete:cin_a"]);
});

test("409 run_active without a cancel request surfaces run_active and cancels nothing", async () => {
  const { calls, deps } = scripted([{ activeRunId: "run_1", status: "run_active" }]);

  const result = await deleteConnectionWithRunCancel("cin_a", null, deps);

  assert.deepEqual(result, { activeRunId: "run_1", status: "run_active" });
  assert.deepEqual(calls, ["delete:cin_a"]);
});

test("a different run than the one the owner saw is not cancelled", async () => {
  const { calls, deps } = scripted([{ activeRunId: "run_2", status: "run_active" }]);

  const result = await deleteConnectionWithRunCancel("cin_a", "run_1", deps);

  assert.equal(result.status, "run_active");
  assert.deepEqual(calls, ["delete:cin_a"]);
});

test("a run that does not stop in time is reported as still active", async () => {
  const { deps } = scripted([
    { activeRunId: "run_1", status: "run_active" },
    { activeRunId: "run_1", status: "run_active" },
    { activeRunId: "run_1", status: "run_active" },
  ]);

  const result = await deleteConnectionWithRunCancel("cin_a", "run_1", deps, { attempts: 2, intervalMs: 0 });

  assert.deepEqual(result, { activeRunId: "run_1", cancelledRunId: "run_1", status: "run_active" });
});

test("a delete with no run in flight is a single call", async () => {
  const { calls, deps } = scripted([{ deletedRecordCount: 0, status: "deleted" }]);

  const result = await deleteConnectionWithRunCancel("cin_a", "run_1", deps);

  assert.equal(result.status, "deleted");
  assert.deepEqual(calls, ["delete:cin_a"]);
});
