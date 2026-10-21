// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { verifyShardReceipts, type ShardReceipt } from "./verify-test-shards.ts";

const files = ["a", "b", "c", "d"];
const receipts: ShardReceipt[] = [
  { index: 0, count: 2, files: ["a", "c"], consumedMappingIdentities: ["skip-a"] },
  { index: 1, count: 2, files: ["b", "d"], consumedMappingIdentities: ["skip-b"] },
];

test("aggregate verifies the complete file partition and whole-suite skip mapping", () => {
  assert.doesNotThrow(() => verifyShardReceipts(files, receipts, 2, ["skip-a", "skip-b"]));
  assert.throws(() => verifyShardReceipts(files, receipts.slice(0, 1), 2, ["skip-a", "skip-b"]), /missing shard/);
  assert.throws(
    () => verifyShardReceipts(files, [receipts[0]!, { ...receipts[1]!, files: ["b"] }], 2, ["skip-a", "skip-b"]),
    /file selection/
  );
  assert.throws(() => verifyShardReceipts(files, receipts, 2, ["skip-a", "skip-b", "stale"]), /stale named skip/);
});
