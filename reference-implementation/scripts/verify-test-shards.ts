// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverSelectedTestFiles } from "./run-tests-discovery.ts";
import { selectTestShard } from "./run-tests-shard.ts";
import {
  assertNamedSkipMappingsFullyConsumed,
  repositoryPaths,
  riConfiguredNamedSkipMappingIdentities,
} from "./test-accounting/receipt.ts";

export interface ShardReceipt {
  index: number;
  count: number;
  files: string[];
  consumedMappingIdentities: string[];
}

/** Reassemble the same complete-suite accounting check after every shard succeeds. */
export function verifyShardReceipts(
  fullFiles: readonly string[],
  receipts: readonly ShardReceipt[],
  expectedCount: number,
  configuredMappings: readonly string[]
): void {
  if (receipts.length !== expectedCount) {
    throw new Error(`missing shard receipt: expected ${expectedCount}, got ${receipts.length}`);
  }
  const seen = new Set<number>();
  for (const receipt of receipts) {
    if (
      !Number.isSafeInteger(receipt.index) ||
      receipt.index < 0 ||
      receipt.index >= expectedCount ||
      receipt.count !== expectedCount ||
      seen.has(receipt.index)
    ) {
      throw new Error("invalid or duplicate shard receipt");
    }
    seen.add(receipt.index);
    const expectedFiles = selectTestShard(fullFiles, receipt.index, expectedCount);
    if (JSON.stringify(receipt.files) !== JSON.stringify(expectedFiles)) {
      throw new Error(`shard ${receipt.index} file selection differs from the full suite`);
    }
    if (
      !Array.isArray(receipt.consumedMappingIdentities) ||
      !receipt.consumedMappingIdentities.every((identity) => typeof identity === "string")
    ) {
      throw new Error(`shard ${receipt.index} has invalid skip mapping identities`);
    }
  }
  assertNamedSkipMappingsFullyConsumed(
    receipts.flatMap((receipt) => receipt.consumedMappingIdentities),
    configuredMappings
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [receiptDir, countArgument] = process.argv.slice(2);
  const count = Number(countArgument);
  if (!receiptDir || !Number.isSafeInteger(count) || count < 1) {
    throw new Error("usage: verify-test-shards.ts RECEIPT_DIR SHARD_COUNT");
  }
  const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const fullFiles = repositoryPaths(
    "reference-implementation",
    await discoverSelectedTestFiles(repoRoot, join(repoRoot, "test"), undefined)
  );
  const receiptNames = (await readdir(receiptDir)).filter((name) => name.endsWith(".json"));
  const receipts = await Promise.all(
    receiptNames.map(async (name) => JSON.parse(await readFile(join(receiptDir, name), "utf8")) as ShardReceipt)
  );
  verifyShardReceipts(fullFiles, receipts, count, riConfiguredNamedSkipMappingIdentities("memory-default"));
  process.stdout.write(`Verified ${count} shards cover ${fullFiles.length} files and all named skip mappings.\n`);
}
