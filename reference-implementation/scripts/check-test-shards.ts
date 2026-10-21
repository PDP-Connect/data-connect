// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverTestFiles } from "./run-tests-discovery.ts";
import { assertCompleteShardReceipts, parseTestShard, type ShardReceipt } from "./test-shard.ts";

const [directory, totalArg, profile] = process.argv.slice(2);
const shard = parseTestShard(`1/${totalArg}`);
if (!(directory && profile && shard)) {
  throw new Error("usage: check-test-shards.ts RECEIPT_DIR TOTAL PROFILE");
}
const receipts: ShardReceipt[] = await Promise.all(
  Array.from({ length: shard.total }, async (_, index) =>
    JSON.parse(await readFile(`${directory}/shard-${index + 1}.json`, "utf8"))
  )
);
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const allFiles = await discoverTestFiles(repoRoot, join(repoRoot, "test"));
assertCompleteShardReceipts(receipts, allFiles, shard.total, profile);
console.log(
  `Verified ${shard.total} shards: ${allFiles.length} files exactly once; named skip mappings fully consumed.`
);
