// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { assertGateConcurrencyReceipt, type GateConcurrencyReceipt } from "./gate-concurrency-receipt.ts";

function readReceipt(cap: 2 | 8): { receipt: GateConcurrencyReceipt; transcript: string } {
  const directory = new URL("../docs/receipts/", import.meta.url);
  const prefix = `gate-concurrency-memory-cap-${cap}`;
  return {
    receipt: JSON.parse(readFileSync(new URL(`${prefix}.receipt.json`, directory), "utf8")) as GateConcurrencyReceipt,
    transcript: readFileSync(new URL(`${prefix}.transcript`, directory), "utf8"),
  };
}

function comparableCounts(receipt: GateConcurrencyReceipt) {
  const { assertions, completed_files, failed, passed, planned_files, skip_reasons, skipped } = receipt.counts;
  return { assertions, completed_files, failed, passed, planned_files, skip_reasons, skipped };
}

test("checked-in cap-2 and cap-8 receipts retain an equivalent memory-default result", () => {
  const capTwo = readReceipt(2);
  const capEight = readReceipt(8);

  assertGateConcurrencyReceipt(capTwo.receipt, capTwo.transcript);
  assertGateConcurrencyReceipt(capEight.receipt, capEight.transcript);
  assert.equal(capTwo.receipt.cap, 2);
  assert.equal(capEight.receipt.cap, 8);
  assert.deepEqual(comparableCounts(capTwo.receipt), comparableCounts(capEight.receipt));
  assert.deepEqual(capTwo.receipt.failure_identities, capEight.receipt.failure_identities);
  assert.deepEqual(capTwo.receipt.selected_files, capEight.receipt.selected_files);
  assert.equal(capTwo.receipt.git_head, capEight.receipt.git_head);
  assert.equal(capTwo.receipt.node_version, capEight.receipt.node_version);
  assert.equal(capTwo.receipt.selection_manifest_sha256, capEight.receipt.selection_manifest_sha256);
  assert.equal(capTwo.receipt.source_tree_sha256, capEight.receipt.source_tree_sha256);
  assert.ok(Date.parse(capTwo.receipt.ended_at) > Date.parse(capTwo.receipt.started_at));
  assert.ok(Date.parse(capEight.receipt.ended_at) > Date.parse(capEight.receipt.started_at));
});
