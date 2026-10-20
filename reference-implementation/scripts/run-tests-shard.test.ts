// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { discoverSelectedTestFiles } from "./run-tests-discovery.ts";
import { selectTestShard, withoutShardEnvironment } from "./run-tests-shard.ts";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test("five shards partition the actual unsharded file list exactly and deterministically", async () => {
  const full = await discoverSelectedTestFiles(repoRoot, join(repoRoot, "test"), undefined);
  const shards = Array.from({ length: 5 }, (_, index) => selectTestShard(full, index, 5));
  assert.ok(shards.every((files) => files.length > 0));
  assert.deepEqual(shards.flat().sort(), full);
  assert.equal(new Set(shards.flat()).size, full.length);
  assert.deepEqual(shards, Array.from({ length: 5 }, (_, index) => selectTestShard(full, index, 5)));
});

test("sharding uses the selected list and rejects invalid or empty slices", () => {
  assert.deepEqual(selectTestShard(["a", "b", "c"], 1, 2), ["b"]);
  assert.throws(() => selectTestShard(["a"], 1, 2), /zero files/);
  const invalidShards: Array<[number, number]> = [[-1, 2], [2, 2], [0, 0], [0.5, 2], [0, 2.5]];
  for (const [index, count] of invalidShards) {
    assert.throws(() => selectTestShard(["a"], index, count), /shard/);
  }
});

test("test children do not inherit outer shard controls", () => {
  const outer = {
    PDPP_TEST_PROFILE: "memory-default",
    PDPP_TEST_SHARD_INDEX: "2",
    PDPP_TEST_SHARD_COUNT: "5",
    PDPP_TEST_SHARD_RECEIPT: "/scratch/shard.json",
  };
  assert.deepEqual(withoutShardEnvironment(outer), { PDPP_TEST_PROFILE: "memory-default" });
  assert.equal(outer.PDPP_TEST_SHARD_INDEX, "2", "the parent environment is unchanged");
});
