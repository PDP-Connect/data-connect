// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  assertNamedSkipMappingsFullyConsumed,
  riConfiguredNamedSkipMappingIdentities,
} from "./test-accounting/receipt.ts";

export interface TestShard {
  index: number;
  total: number;
}

export interface ShardReceipt {
  consumedMappingIdentities: string[];
  files: string[];
  profile: string;
  shard: TestShard;
}

const SHARD_PATTERN = /^([1-9]\d*)\/([1-9]\d*)$/;

/** One-based i/N, with no implicit fallback for malformed CI configuration. */
export function parseTestShard(raw: string | undefined): TestShard | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const match = SHARD_PATTERN.exec(raw);
  const index = Number(match?.[1]);
  const total = Number(match?.[2]);
  if (!(Number.isSafeInteger(index) && Number.isSafeInteger(total)) || index > total) {
    throw new Error("PDPP_TEST_SHARD must be i/N with safe integers 1 <= i <= N");
  }
  return { index, total };
}

/** Sort before round-robin assignment so filesystem enumeration order cannot affect ownership. */
export function selectShardFiles(files: readonly string[], shard: TestShard | undefined): string[] {
  const sorted = [...files].sort();
  return shard ? sorted.filter((_, index) => index % shard.total === shard.index - 1) : sorted;
}

/** Rejoin successful shards before applying complete-suite accounting. */
export function assertCompleteShardReceipts(
  receipts: readonly ShardReceipt[],
  allFiles: readonly string[],
  total: number,
  profile: string
): void {
  if (receipts.length !== total) {
    throw new Error(`expected ${total} shard receipts, received ${receipts.length}`);
  }
  for (let index = 1; index <= total; index += 1) {
    const matches = receipts.filter((row) => row.shard.index === index);
    const [receipt] = matches;
    if (matches.length !== 1 || !receipt || receipt.shard.total !== total || receipt.profile !== profile) {
      throw new Error(`missing, duplicate, or incompatible receipt for shard ${index}/${total}`);
    }
    const expected = selectShardFiles(allFiles, { index, total });
    if (JSON.stringify(receipt.files) !== JSON.stringify(expected)) {
      throw new Error(`file accounting differs for shard ${index}/${total}`);
    }
  }
  assertNamedSkipMappingsFullyConsumed(
    receipts.flatMap((receipt) => receipt.consumedMappingIdentities),
    riConfiguredNamedSkipMappingIdentities(profile)
  );
}
