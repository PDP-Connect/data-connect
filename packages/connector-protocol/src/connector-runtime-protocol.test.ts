// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import type {
  EmittedMessage,
  SkipResultBoundaryClaim,
} from "./connector-runtime-protocol.ts";
import {
  type RuntimeContinuationFact,
  selectAuthoritativeContinuation,
  selectAuthoritativeSkip,
} from "./connector-runtime-protocol.ts";

const CONTINUATION: RuntimeContinuationFact = {
  boundary: "uidvalidity-123",
  considered: 2,
  covered: 2,
  owner: "runtime",
  remaining: true,
  slice_end: 500,
  slice_start: 1,
};

test("a newer terminal skip cannot inherit an older valid continuation", () => {
  const gaps = [
    { continuation: CONTINUATION, kind: "skip_result", stream: "messages" },
    { kind: "skip_result", reason: "auth_failed", stream: "messages" },
  ];

  assert.equal(selectAuthoritativeSkip(gaps, "messages"), gaps[1]);
  assert.equal(selectAuthoritativeContinuation(gaps, "messages"), undefined);
});

test("a malformed newest continuation fails closed instead of falling back", () => {
  const gaps = [
    { continuation: CONTINUATION, kind: "skip_result", stream: "messages" },
    {
      continuation: { ...CONTINUATION, remaining: false },
      kind: "skip_result",
      stream: "messages",
    },
  ];

  assert.equal(selectAuthoritativeSkip(gaps, "messages"), gaps[1]);
  assert.equal(selectAuthoritativeContinuation(gaps, "messages"), undefined);
});

test("the newest valid continuation remains authoritative", () => {
  const gaps = [
    { kind: "skip_result", reason: "transient", stream: "messages" },
    { continuation: CONTINUATION, kind: "skip_result", stream: "messages" },
  ];

  assert.equal(selectAuthoritativeSkip(gaps, "messages"), gaps[1]);
  assert.equal(selectAuthoritativeContinuation(gaps, "messages"), gaps[1]);
});

test("selection remains isolated by stream and message kind", () => {
  const gaps = [
    { continuation: CONTINUATION, kind: "detail_coverage", stream: "messages" },
    { continuation: CONTINUATION, kind: "skip_result", stream: "threads" },
  ];

  assert.equal(selectAuthoritativeSkip(gaps, "messages"), undefined);
  assert.equal(selectAuthoritativeContinuation(gaps, "messages"), undefined);
});

test("SkipResultBoundaryClaim is a closed vocabulary, not a bare string", () => {
  const claim: SkipResultBoundaryClaim = "provider_history_boundary";
  assert.equal(claim, "provider_history_boundary");

  // @ts-expect-error widening the vocabulary must fail at build time, not silently pass.
  const widened: SkipResultBoundaryClaim = "anything";
  void widened;
});

test("EmittedMessage SKIP_RESULT accepts an optional boundary_claim without other fields changing", () => {
  const withoutClaim: EmittedMessage = {
    type: "SKIP_RESULT",
    stream: "messages",
    reason: "auth_failed",
    message: "boundary reached",
  };
  const withClaim: EmittedMessage = {
    ...withoutClaim,
    boundary_claim: "provider_history_boundary",
  };

  assert.equal(withoutClaim.type, "SKIP_RESULT");
  assert.equal(withClaim.boundary_claim, "provider_history_boundary");

  const invalidClaim: EmittedMessage = {
    ...withoutClaim,
    // @ts-expect-error an unrecognized boundary_claim value must fail at build time.
    boundary_claim: "not_a_real_boundary",
  };
  void invalidClaim;
});
