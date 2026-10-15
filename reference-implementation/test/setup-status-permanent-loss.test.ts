// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Source loss stays visible and un-hydrated: a stream whose recoverable pending
 * count is 0 only because every loss is permanent (`permanent_detail_gaps > 0`)
 * must never be classified as a trusted verified-empty setup.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { classifyTerminalSetupDisposition } from "../runtime/static-secret-setup-status.ts";

function fact(overrides: Record<string, unknown> = {}) {
  return {
    checkpoint: "committed",
    considered: 0,
    covered: 0,
    pending_detail_gaps: 0,
    skipped: null,
    stream: "items",
    ...overrides,
  };
}

function classify(streamFact: Record<string, unknown>) {
  return classifyTerminalSetupDisposition({
    collectionFacts: { streams: [streamFact as ReturnType<typeof fact>] },
    manifestStreams: [{ name: "items", required: true }],
    recordsEmitted: 0,
    status: "succeeded",
  });
}

test("a trusted-empty fact with no permanent loss is still verified_empty (control)", () => {
  assert.equal(classify(fact()), "verified_empty");
});

test("recoverable count 0 but permanent_detail_gaps > 0 is NOT verified_empty", () => {
  assert.notEqual(classify(fact({ permanent_detail_gaps: 2 })), "verified_empty");
});
