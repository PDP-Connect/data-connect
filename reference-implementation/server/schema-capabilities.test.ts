// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildExpandCapabilities, buildFieldCapabilities, buildStreamDiscoveryCapabilities } from "./schema-capabilities.ts";

const schema = { properties: { amount: { type: "number" } } };

test("discovery does not advertise unavailable query features", () => {
  const stream = {
    name: "orders", schema,
    query: {
      expand: [{ name: "items" }],
      aggregations: { count: false, sum: false },
      range_filters: { amount: [] },
    },
  };
  const result = buildStreamDiscoveryCapabilities({ stream });
  assert.deepEqual(
    [result.expand, result.aggregate, result.aggregate_url, result.range_filters],
    [false, false, null, false],
  );
  assert.deepEqual(buildExpandCapabilities(stream), []);
  assert.deepEqual(buildFieldCapabilities(stream).amount?.range_filter, { declared: false, usable: false });
});

test("discovery still advertises supported query features", () => {
  const stream = {
    name: "orders", schema,
    relationships: [{ name: "items", stream: "line_items", cardinality: "many" }],
    query: {
      expand: [{ name: "items" }],
      aggregations: { sum: ["amount"] },
      range_filters: { amount: ["gte"] },
    },
  };
  const result = buildStreamDiscoveryCapabilities({ stream, connectorId: "fixture" });
  assert.deepEqual(
    [result.expand, result.aggregate, result.aggregate_url, result.range_filters],
    [true, true, "/v1/streams/orders/aggregate?connector_id=fixture", true],
  );
  assert.deepEqual(buildFieldCapabilities(stream).amount?.range_filter, {
    declared: true, usable: true, operators: ["gte"],
  });
  assert.equal(buildStreamDiscoveryCapabilities({
    stream: { name: "orders", query: { aggregations: { count: true } } },
  }).aggregate, true);
});
