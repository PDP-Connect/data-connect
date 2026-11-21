// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { mapPendingPressureGaps } from "./pending-pressure-gap-map.ts";

type Summary = Parameters<typeof mapPendingPressureGaps>[0][number];
const updated = "2026-11-20T18:00:00.000Z";
const attempted = "2026-11-20T17:00:00.000Z";

test("a refreshed summary with no actual attempt has no pressure timestamp", () => {
  const gap = { updated_at: updated } as Summary;
  assert.equal(mapPendingPressureGaps([gap])[0]?.lastPressureAt, null);
});

test("an actual attempt keeps its timestamp despite a later summary refresh", () => {
  const gap = { updated_at: updated, last_attempt_at: attempted } as Summary;
  assert.equal(mapPendingPressureGaps([gap])[0]?.lastPressureAt, attempted);
});
