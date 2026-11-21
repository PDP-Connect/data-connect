// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveReferenceFreshness } from "./freshness.ts";

const now = "2026-01-02T12:00:00.000Z";
const policy = { now, maximumStalenessSeconds: 3600 };

test("discards future evidence without hiding usable past evidence", () => {
  const past = "2026-01-02T11:45:00.000Z";
  const future = "2026-01-02T13:00:00.000Z";
  assert.deepEqual(deriveReferenceFreshness({ ...policy, lastSuccessfulRunAt: future }), { status: "unknown" });
  assert.deepEqual(deriveReferenceFreshness({
    ...policy, lastSuccessfulRunAt: past, lastAttemptedAt: future, lastAttemptStatus: "failed",
  }), { status: "current", captured_at: past });
  assert.deepEqual(deriveReferenceFreshness({
    ...policy, lastSuccessfulRunAt: future, recordLastUpdatedAt: past,
  }), { status: "current", captured_at: past });
});

test("uses an inclusive staleness boundary and ignores invalid policies", () => {
  const capture = "2026-01-02T11:00:00.000Z";
  assert.equal(deriveReferenceFreshness({ ...policy, lastSuccessfulRunAt: capture }).status, "current");
  assert.equal(deriveReferenceFreshness({
    ...policy, lastSuccessfulRunAt: "2026-01-02T10:59:59.999Z",
  }).status, "stale");
  for (const maximumStalenessSeconds of [-1, Number.MAX_VALUE, Infinity, NaN]) {
    assert.equal(deriveReferenceFreshness({ now, maximumStalenessSeconds, lastSuccessfulRunAt: capture }).status, "unknown");
  }
});
