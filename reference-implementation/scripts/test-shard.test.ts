// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { discoverTestFiles } from "./run-tests-discovery.ts";
import { riConfiguredNamedSkipMappingIdentities } from "./test-accounting/receipt.ts";
import { assertCompleteShardReceipts, parseTestShard, type ShardReceipt, selectShardFiles } from "./test-shard.ts";

const SHARD_ERROR = /PDPP_TEST_SHARD/;
const COMPLETE_OUTPUT = /files exactly once/;
const MISSING_RECEIPT = /ENOENT/;

test("sorted round-robin shards are complete, disjoint, deterministic, and balanced", () => {
  const files = ["z.test.ts", "a.test.ts", "c.test.ts", "b.test.ts", "d.test.ts", "e.test.ts", "f.test.ts"];
  const original = [...files];
  const shards = [1, 2, 3].map((index) => selectShardFiles(files, { index, total: 3 }));
  assert.deepEqual(shards, [
    ["a.test.ts", "d.test.ts", "z.test.ts"],
    ["b.test.ts", "e.test.ts"],
    ["c.test.ts", "f.test.ts"],
  ]);
  assert.deepEqual(shards.flat().sort(), [...files].sort());
  assert.equal(new Set(shards.flat()).size, files.length);
  assert.deepEqual(selectShardFiles([...files].reverse(), { index: 1, total: 3 }), shards[0]);
  assert.deepEqual(files, original);
});

test("N=1 and no shard preserve every file; empty shards are valid", () => {
  const files = ["b.test.ts", "a.test.ts"];
  assert.deepEqual(selectShardFiles(files, parseTestShard("1/1")), [...files].sort());
  assert.deepEqual(selectShardFiles(files, parseTestShard(undefined)), [...files].sort());
  assert.deepEqual(selectShardFiles(files, parseTestShard("3/3")), []);
});

test("shard configuration rejects malformed and out-of-range values", () => {
  assert.deepEqual(parseTestShard("2/3"), { index: 2, total: 3 });
  for (const raw of ["", "0/3", "1/0", "4/3", "-1/3", "1.5/3", "1/3x", " 1/3", "01/3", "1/9007199254740992"]) {
    assert.throws(() => parseTestShard(raw), SHARD_ERROR);
  }
});

test("all discovered RI files, including this test, run exactly once across three shards", async () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const files = await discoverTestFiles(root, join(root, "test"));
  assert.ok(files.includes("scripts/test-shard.test.ts"));
  const shards = [1, 2, 3].map((index) => selectShardFiles(files, { index, total: 3 }));
  assert.deepEqual(shards.flat().sort(), files);
  assert.equal(new Set(shards.flat()).size, files.length);
  console.log(`RI partition: ${shards.map((partition) => partition.length).join(" / ")} (${files.length} files)`);
});

function receipts(): ShardReceipt[] {
  return [1, 2, 3].map((index) => ({
    consumedMappingIdentities: index === 1 ? [...riConfiguredNamedSkipMappingIdentities("memory-default")] : [],
    files: selectShardFiles(["a", "b", "c", "d"], { index, total: 3 }),
    profile: "memory-default",
    shard: { index, total: 3 },
  }));
}

test("complete-suite accounting joins mappings across shards and rejects missing, duplicate, or wrong files", () => {
  const files = ["a", "b", "c", "d"];
  assert.doesNotThrow(() => assertCompleteShardReceipts(receipts(), files, 3, "memory-default"));
  for (const mutate of [
    (rows: ShardReceipt[]) => rows.pop(),
    (rows: ShardReceipt[]) => {
      rows[1] = rows[0];
    },
    (rows: ShardReceipt[]) => {
      rows[1].files = ["a"];
    },
    (rows: ShardReceipt[]) => {
      rows[1].files = [];
    },
    (rows: ShardReceipt[]) => {
      rows[1].profile = "postgres";
    },
    (rows: ShardReceipt[]) => {
      rows[1].shard.total = 4;
    },
    (rows: ShardReceipt[]) => {
      rows[0].consumedMappingIdentities = [];
    },
    (rows: ShardReceipt[]) => {
      rows[1].consumedMappingIdentities = ["unconfigured mapping"];
    },
  ]) {
    const rows = receipts();
    mutate(rows);
    assert.throws(() => assertCompleteShardReceipts(rows, files, 3, "memory-default"));
  }
});

test("the gate CLI accepts a complete inventory and fails when one shard receipt is missing", async () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const files = await discoverTestFiles(root, join(root, "test"));
  const directory = await mkdtemp(join(tmpdir(), "ri-shard-receipts-"));
  try {
    await Promise.all(
      receipts().map(async (receipt) => {
        receipt.files = selectShardFiles(files, receipt.shard);
        await writeFile(join(directory, `shard-${receipt.shard.index}.json`), JSON.stringify(receipt));
      })
    );
    const run = () =>
      spawnSync(process.execPath, [join(root, "scripts/check-test-shards.ts"), directory, "3", "memory-default"], {
        encoding: "utf8",
      });
    const complete = run();
    assert.equal(complete.status, 0, complete.stderr);
    assert.match(complete.stdout, COMPLETE_OUTPUT);
    await rm(join(directory, "shard-2.json"));
    const missing = run();
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, MISSING_RECEIPT);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
