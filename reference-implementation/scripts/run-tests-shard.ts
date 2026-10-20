// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ProcessEnvLike } from "./test-env.ts";

/** Stable slices of the runner's already selected file list. */
export function selectTestShard(files: readonly string[], index: number, count: number): string[] {
  if (!Number.isSafeInteger(count) || count < 1 || !Number.isSafeInteger(index) || index < 0 || index >= count) {
    throw new Error("invalid test shard index or count");
  }
  const selected = files.filter((_, fileIndex) => fileIndex % count === index);
  if (selected.length === 0) {
    throw new Error(`test shard ${index}/${count} selected zero files`);
  }
  return selected;
}

/** A test file may start a nested runner; it must select its own files. */
export function withoutShardEnvironment(env: ProcessEnvLike): ProcessEnvLike {
  const childEnv = { ...env };
  delete childEnv.PDPP_TEST_SHARD_INDEX;
  delete childEnv.PDPP_TEST_SHARD_COUNT;
  delete childEnv.PDPP_TEST_SHARD_RECEIPT;
  return childEnv;
}
