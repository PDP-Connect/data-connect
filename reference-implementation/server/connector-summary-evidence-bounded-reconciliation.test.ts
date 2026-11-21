// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import { runBoundedConnectorReconciliation } from "./connector-summary-evidence-bounded-reconciliation.ts";

function reconcile(deadline: number | null, fail = false) {
  let reads = 0;
  let finalPrunes = 0;
  const result = runBoundedConnectorReconciliation({
    candidateReasons: undefined,
    deadline,
    discover: async (ids) => ({
      candidates: new Map(ids.map((id) => [id, "fixture"] as const)),
      instanceRows: ids,
    }),
    maxCandidates: undefined,
    pageSize: 2,
    prune: async () => 0,
    pruneComplete: async () => { finalPrunes++; return 0; },
    readPage: async () => { reads++; return ["instance"]; },
    repair: async () => ({ deferred: false, failed: fail, persisted: false, row: "detail" }),
  });
  return { result, calls: () => ({ reads, finalPrunes }) };
}

test("an expired round reports deadline without reading or pruning", async () => {
  const round = reconcile(0);
  assert.equal((await round.result).stopReason, "deadline");
  assert.deepEqual(round.calls(), { reads: 0, finalPrunes: 0 });
});

test("an exhausted scan records final prune before reporting exhaustion", async () => {
  const round = reconcile(null);
  const result = await round.result;
  assert.equal(result.stopReason, "exhausted");
  assert.equal(result.repaired, 1);
  assert.deepEqual(round.calls(), { reads: 1, finalPrunes: 1 });
});

test("an attempted failure is neither repaired nor skipped", async () => {
  const result = await reconcile(null, true).result;
  assert.equal(result.repaired, 0);
  assert.equal(result.failed, 1);
  assert.equal(result.skipped, 0);
  assert.deepEqual(result.attemptedIds, ["instance"]);
  assert.equal(result.failedRows.get("instance"), "detail");
});
