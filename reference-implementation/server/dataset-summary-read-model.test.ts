// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";

import { metadataAfterDatasetSummaryTimeReconcile } from "./dataset-summary-read-model.ts";

const staleAt = "2026-01-01T00:00:00.000Z";
const repairedAt = "2026-01-02T00:00:00.000Z";
const base = {
  computed_at: staleAt,
  last_error: null,
  rebuild_status: "idle",
  source_high_watermark: "delta:fixture",
  stale_since: staleAt,
  state: "stale",
};

test("repairing the last dirty time row does not clear a dropped record delta", () => {
  const prior = {
    ...base,
    last_error: "record delta arrived during projection rebuild",
    needs_full_rebuild: true,
  };
  const repaired = metadataAfterDatasetSummaryTimeReconcile(prior, repairedAt, false);
  assert.equal(repaired.state, "stale");
  assert.equal(repaired.stale_since, staleAt);
  assert.equal(repaired.last_error, prior.last_error);
  assert.equal(repaired.source_high_watermark, prior.source_high_watermark);
  assert.equal(repaired.needs_full_rebuild, true);
});

test("time-only stale state clears only after the last time row is repaired", () => {
  const waiting = metadataAfterDatasetSummaryTimeReconcile(base, repairedAt, true);
  assert.equal(waiting.state, "stale");
  assert.equal(waiting.stale_since, staleAt);
  const repaired = metadataAfterDatasetSummaryTimeReconcile(waiting, repairedAt, false);
  assert.equal(repaired.state, "fresh");
  assert.equal(repaired.stale_since, null);
  assert.equal(repaired.last_error, null);
});
