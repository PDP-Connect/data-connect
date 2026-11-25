// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { buildRecordProjectionFromRetainedRows } from "../server/ref-control.ts";

test("duplicate stream rows sum their counts and keep the latest timestamp, in any row order", () => {
  const earlier = "2026-01-01T00:00:00.000Z";
  const later = "2026-01-02T00:00:00.000Z";
  const input = [
    { last_updated: earlier, record_count: "2", stream: "fixture" },
    { last_updated: later, record_count: 7, stream: "fixture" },
    { last_updated: null, record_count: 3, stream: "other" },
  ];
  for (const rows of [input, [...input].reverse()]) {
    const projection = buildRecordProjectionFromRetainedRows({
      retainedBytes: null,
      retainedSizeReliable: false,
      rows,
    });
    const fixture = projection.byStream.get("fixture");
    assert.equal(fixture?.record_count, 9);
    assert.equal(fixture?.last_updated, later);
    assert.equal(projection.byStream.get("other")?.record_count, 3);
    assert.equal(projection.byStream.get("other")?.last_updated, null);
    const perStreamTotal = [...projection.byStream.values()].reduce((sum, entry) => sum + entry.record_count, 0);
    assert.equal(projection.totalRecords, 12);
    assert.equal(perStreamTotal, projection.totalRecords);
  }
});
