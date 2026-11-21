// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildRecordProjectionFromRetainedRows, projectStreamRecordSummaries } from "./record-projection-read-model.ts";

test("stream summaries retain counts and latest timestamps independently of row order", () => {
  const earlier = "2026-01-01T00:00:00.000Z";
  const later = "2026-01-02T00:00:00.000Z";
  const input = [
    { stream: "fixture", record_count: "2", last_updated: earlier },
    { stream: "fixture", record_count: 7, last_updated: later },
    { stream: "other", record_count: 3, last_updated: null },
  ];
  for (const rows of [input, [...input].reverse()]) {
    const projection = buildRecordProjectionFromRetainedRows({ retainedBytes: null, rows });
    const streams = projectStreamRecordSummaries(projection.byStream);
    assert.deepEqual(streams, [
      { stream: "fixture", record_count: 9, last_updated: later },
      { stream: "other", record_count: 3, last_updated: null },
    ]);
    assert.equal(projection.totalRecords, 12);
    assert.equal(streams.reduce((sum, stream) => sum + stream.record_count, 0), projection.totalRecords);
  }
});
