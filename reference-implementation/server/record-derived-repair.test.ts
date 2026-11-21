// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import { finishRecordDerivedRepairRound } from "./record-derived-repair.ts";

test("a completed snapshot is incomplete when its connector still has repairs pending", async () => {
  const pending = new Map([["fixture", 5], ["other", 8]]);
  const result = await finishRecordDerivedRepairRound(
    { attempted: 1000, completed: 1000, failed: 0, incomplete: false },
    "fixture",
    async (connectorId) => (pending.get(connectorId ?? "") ?? 0) > 0,
  );
  assert.deepEqual(result, { attempted: 1000, completed: 1000, failed: 0, incomplete: true });
});

test("a round with nothing due is incomplete when only backoff rows remain", async () => {
  const pending = [{ connectorId: "fixture", nextAttemptAt: "2099-01-01T00:00:00Z" }];
  const result = await finishRecordDerivedRepairRound(
    { attempted: 0, completed: 0, failed: 0, incomplete: false },
    "fixture",
    async (connectorId) => pending.some((row) => row.connectorId === connectorId),
  );
  assert.equal(result.incomplete, true);
});

test("an empty connector queue is complete even when another connector is pending", async () => {
  const pending = [{ connectorId: "other" }];
  const result = await finishRecordDerivedRepairRound(
    { attempted: 0, completed: 0, failed: 0, incomplete: false },
    "fixture",
    async (connectorId) => pending.some((row) => row.connectorId === connectorId),
  );
  assert.equal(result.incomplete, false);
});
