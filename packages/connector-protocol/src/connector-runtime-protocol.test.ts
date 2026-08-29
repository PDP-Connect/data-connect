// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import {
  type RuntimeContinuationFact,
  selectAuthoritativeContinuation,
  selectAuthoritativeSkip,
} from "./connector-runtime-protocol.ts";
import type { EmittedMessage, SkipResultBoundaryClaim } from "./index.ts";

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

test("the public barrel accepts a well-formed STREAM_EVIDENCE message", () => {
  const evidence: EmittedMessage = {
    considered: 10,
    covered: 7,
    reference_only: true,
    stream: "message_bodies",
    type: "STREAM_EVIDENCE",
  };

  assert.equal(evidence.type, "STREAM_EVIDENCE");
});

test("STREAM_EVIDENCE requires the literal reference_only value", () => {
  const evidence: EmittedMessage = {
    considered: 10,
    covered: 7,
    // @ts-expect-error reference_only must be the literal true.
    reference_only: false,
    stream: "message_bodies",
    type: "STREAM_EVIDENCE",
  };
  assert.equal(evidence.type, "STREAM_EVIDENCE");
});

test("STREAM_EVIDENCE requires a string stream", () => {
  const evidence: EmittedMessage = {
    considered: 10,
    covered: 7,
    reference_only: true,
    // @ts-expect-error stream must be a string.
    stream: 42,
    type: "STREAM_EVIDENCE",
  };
  assert.equal(evidence.type, "STREAM_EVIDENCE");
});

test("STREAM_EVIDENCE requires numeric considered and covered counts", () => {
  const invalidConsidered: EmittedMessage = {
    // @ts-expect-error considered must be a number.
    considered: "10",
    covered: 7,
    reference_only: true,
    stream: "message_bodies",
    type: "STREAM_EVIDENCE",
  };
  const invalidCovered: EmittedMessage = {
    considered: 10,
    // @ts-expect-error covered must be a number.
    covered: "7",
    reference_only: true,
    stream: "message_bodies",
    type: "STREAM_EVIDENCE",
  };
  assert.equal(invalidConsidered.type, "STREAM_EVIDENCE");
  assert.equal(invalidCovered.type, "STREAM_EVIDENCE");
});

test("SKIP_RESULT rejects an unrecognized boundary claim", () => {
  const skip: EmittedMessage = {
    // @ts-expect-error boundary_claim is a closed protocol vocabulary.
    boundary_claim: "provider_guess",
    message: "Provider stopped serving history",
    reason: "provider_history_boundary",
    stream: "messages",
    type: "SKIP_RESULT",
  };
  assert.equal(skip.type, "SKIP_RESULT");
});

test("the public barrel exports the SKIP_RESULT boundary claim", () => {
  const claim: SkipResultBoundaryClaim = "provider_history_boundary";

  assert.equal(claim, "provider_history_boundary");
});
