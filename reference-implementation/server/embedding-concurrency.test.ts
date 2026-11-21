// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import { intraOpNumThreadsForWorkLimit, resolveEmbeddingConcurrency } from "./embedding-concurrency.ts";

test("invalid CPU budget uses the single-worker and single-thread floor", () => {
  for (const cpuCount of [NaN, Infinity, -Infinity, 0, -1]) {
    assert.deepEqual(resolveEmbeddingConcurrency(cpuCount, 8 * 1024 ** 3), {
      workLimit: 1, intraOpNumThreads: 1,
    });
    assert.equal(intraOpNumThreadsForWorkLimit(4, cpuCount), 1);
  }
});

test("valid CPU budget retains the existing allocation", () => {
  assert.deepEqual(resolveEmbeddingConcurrency(6, 8 * 1024 ** 3), {
    workLimit: 4, intraOpNumThreads: 1,
  });
  assert.equal(intraOpNumThreadsForWorkLimit(2, 6), 3);
});
