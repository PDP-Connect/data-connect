// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { normalizeAggregateRequest } from "./aggregate-request-validation.ts";

const manifest = {
  name: "synthetic",
  query: { aggregations: { count: true, group_by_time: ["created_at"] } },
  schema: { properties: { created_at: { type: "string", format: "date-time" } } },
};
const grant = { fields: ["created_at"] };

test("aggregate granularity requires an actual string before the allowlist", () => {
  assert.throws(
    () => normalizeAggregateRequest(
      { metric: "count", group_by_time: "created_at", granularity: ["day"], field: null, group_by: null, time_zone: null },
      grant,
      manifest
    ),
    /granularity must be a nonblank string/
  );
});

test("undefined aggregate dimensions are absent", () => {
  const result = normalizeAggregateRequest({ metric: "count", granularity: undefined }, grant, manifest);
  assert.equal(result.field, null);
  assert.equal(result.groupBy, null);
  assert.equal(result.groupByTime, null);
  assert.equal(result.granularity, null);
  assert.equal(result.timeZone, null);
});

test("a declared day grouping accepts string granularity", () => {
  const result = normalizeAggregateRequest(
    { metric: "count", group_by_time: "created_at", granularity: "day", field: null, group_by: null, time_zone: null },
    grant,
    manifest
  );
  assert.equal(result.granularity, "day");
  assert.equal(result.groupByTime, "created_at");
});

test("a blank optional aggregate dimension is not a string value", () => {
  assert.throws(
    () => normalizeAggregateRequest(
      { metric: "count", field: " ", group_by: null, group_by_time: null, granularity: null, time_zone: null },
      grant,
      manifest
    ),
    /field must be a nonblank string/
  );
});
