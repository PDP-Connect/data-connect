// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { readCollectionFactsFromTerminalData, readRuntimeCollectionFact } from "./runtime-collection-facts.ts";

test("invalid pending gaps and invalid stream entries remain unknown, never zero", () => {
  assert.equal(readRuntimeCollectionFact({ stream: "orders", pending_detail_gaps: "unknown" }), null);
  assert.deepEqual(readCollectionFactsFromTerminalData({
    collection_facts: { streams: [{ stream: "orders", pending_detail_gaps: "unknown" }, false] },
  }), {
    streams: [],
    unknown_streams: [
      { index: 0, stream: "orders", reason: "pending_detail_gaps" },
      { index: 1, reason: "invalid_stream" },
    ],
  });
});

test("malformed optional evidence is marked without discarding real pending gaps", () => {
  const malformed = readRuntimeCollectionFact({
    stream: "orders", pending_detail_gaps: 2, coverage_statuses: [false], permanent_detail_gaps: -1,
  });
  assert.equal(malformed?.pending_detail_gaps, 2);
  assert.deepEqual(malformed?.unknown_fields, ["coverage_statuses", "permanent_detail_gaps"]);
  assert.equal(Object.hasOwn(malformed!, "coverage_statuses"), false);
  assert.equal(Object.hasOwn(malformed!, "permanent_detail_gaps"), false);
});

test("valid statuses, gap counts and empty optional evidence keep the existing shape", () => {
  const row = readRuntimeCollectionFact({
    stream: "orders", pending_detail_gaps: 2, coverage_statuses: ["partial", "complete", "partial"], permanent_detail_gaps: 3,
  });
  assert.equal(row?.pending_detail_gaps, 2);
  assert.deepEqual(row?.coverage_statuses, ["complete", "partial"]);
  assert.equal(row?.permanent_detail_gaps, 3);
  assert.equal(Object.hasOwn(row!, "unknown_fields"), false);
  const empty = readRuntimeCollectionFact({
    stream: "orders", pending_detail_gaps: 0, coverage_statuses: [], permanent_detail_gaps: 0,
  });
  assert.equal(empty?.pending_detail_gaps, 0);
  assert.equal(Object.hasOwn(empty!, "unknown_fields"), false);
});
