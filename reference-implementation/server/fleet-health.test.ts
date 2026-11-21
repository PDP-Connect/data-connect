// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { composeFleetHealthVerdict, type FleetSummary } from "./fleet-health.ts";

const row = {
  connectorId: "connector-one",
  connectorInstanceId: "instance-one",
  displayName: "Synthetic connector",
  revokedAt: null,
  status: "active",
};
const matching = {
  connection_id: row.connectorInstanceId,
  connector_instance_id: row.connectorInstanceId,
  connector_id: row.connectorId,
  display_name: row.displayName,
  connection_health: {
    state: "healthy",
    badges: { syncing: false },
    axes: { attention: "none", coverage: "complete", freshness: "fresh", outbox: "idle", remote_surface: "none" },
    conditions: [],
    unknown_reasons: [],
    forward_disposition: "complete",
  },
  owner_state: { resolver: "healthy" },
  rendered_verdict: { actions: [], required_actions: [] },
  schedule: null,
} as unknown as FleetSummary;

function scope(summary: FleetSummary) {
  return composeFleetHealthVerdict({
    inventory: [row],
    summaries: [summary],
    streamHealth: { status: "pass" },
    runtime: { ok: true },
  }).scope;
}

for (const patch of [
  { connector_instance_id: "instance-two" },
  { connector_id: "connector-two" },
]) {
  test(`fleet leaves the inventory row unassessed for mismatched ${Object.keys(patch)[0]}`, () => {
    const result = scope({ ...matching, ...patch });
    assert.deepEqual(result.assessed, []);
    assert.deepEqual(result.unassessed, [{
      connection_id: row.connectorInstanceId,
      connector_instance_id: row.connectorInstanceId,
      connector_id: row.connectorId,
      display_name: row.displayName,
    }]);
  });
}

test("fleet assesses an exact connection, instance and connector match", () => {
  const result = scope(matching);
  assert.deepEqual(result.unassessed, []);
  assert.equal(result.assessed.length, 1);
  assert.equal(result.assessed[0]?.connector_instance_id, row.connectorInstanceId);
});
