// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import { readPostgresCheckpoint } from "./record-source-checkpoint.ts";

test("Postgres checkpoint keeps generation and counters in one query snapshot", async () => {
  const calls: string[] = [];
  const result = await readPostgresCheckpoint("fixture", async (sql, params) => {
    calls.push(sql);
    assert.deepEqual(params, ["fixture"]);
    if (calls.length === 1) {
      assert.match(sql, /record_reset_generation::text/);
      assert.match(sql, /max_version::text/);
      return { rows: [{ reset_generation: "17", stream: "messages", max_version: "9007199254741009" }] };
    }
    // A committed reset would make a second statement observe a new vector.
    return { rows: [{ reset_generation: "18", stream: "messages", max_version: "1" }] };
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(result, {
    reset_generation: "17",
    streams: [{ stream: "messages", max_version: "9007199254741009" }],
  });
});

test("Postgres checkpoint preserves reset generation with no version counters", async () => {
  const result = await readPostgresCheckpoint("fixture", async () => ({
    rows: [{ reset_generation: "17", stream: null, max_version: null }],
  }));
  assert.deepEqual(result, { reset_generation: "17", streams: [] });
});
