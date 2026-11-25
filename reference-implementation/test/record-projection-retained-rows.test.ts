// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { buildRecordProjectionFromRetainedRows } from "../server/ref-control.ts";

test("a stream reported by several connections sums its counts and keeps its newest update", () => {
  const projection = buildRecordProjectionFromRetainedRows({
    retainedBytes: null,
    retainedSizeReliable: false,
    rows: [
      { connector_instance_id: "cin_a", last_updated: "2026-01-02T00:00:00.000Z", record_count: 3, stream: "items" },
      { connector_instance_id: "cin_b", last_updated: "2026-01-01T00:00:00.000Z", record_count: "4", stream: "items" },
      { connector_instance_id: "cin_b", last_updated: null, record_count: 2, stream: "events" },
    ],
  });
  assert.equal(projection.byStream.get("items")?.record_count, 7);
  assert.equal(projection.byStream.get("items")?.last_updated, "2026-01-02T00:00:00.000Z");
  assert.equal(projection.byStream.get("events")?.record_count, 2);
  assert.equal(projection.totalRecords, 9);
});
