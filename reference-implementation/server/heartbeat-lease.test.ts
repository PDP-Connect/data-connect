// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { HEARTBEAT_LEASE_MS, presentHeartbeatHealth } from "./heartbeat-lease.ts";

const NOW = Date.parse("2026-11-20T00:00:00Z");
const at = (offset: number) => new Date(NOW + offset).toISOString();
const present = (ageMs: number, leaseMs?: number) => presentHeartbeatHealth({
  lastHeartbeatAt: at(-ageMs),
  lastHeartbeatStatus: "healthy",
  nowIso: at(0),
  ...(leaseMs === undefined ? {} : { leaseMs }),
});

test("a future heartbeat is not evidence of current health", () => {
  assert.deepEqual(present(-1), {
    ageMs: null, lastObservedStatus: "healthy", leaseMs: HEARTBEAT_LEASE_MS, status: "unknown",
  });
});

for (const invalid of [NaN, Infinity, -Infinity, -1]) {
  test(`an invalid lease (${invalid}) falls back to the declared policy`, () => {
    assert.equal(present(0, invalid).leaseMs, HEARTBEAT_LEASE_MS);
    assert.equal(present(HEARTBEAT_LEASE_MS, invalid).status, "healthy");
    assert.equal(present(HEARTBEAT_LEASE_MS + 1, invalid).status, "stale");
  });
}

test("zero and the inclusive lease boundary are current", () => {
  assert.equal(present(0, 0).status, "healthy");
  assert.equal(present(0, 20).status, "healthy");
  assert.equal(present(20, 20).status, "healthy");
  assert.equal(present(21, 20).status, "stale");
});
