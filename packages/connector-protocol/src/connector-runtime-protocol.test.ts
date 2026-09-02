// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import {
  CONNECTOR_PROTOCOL_CAPABILITIES,
  CONNECTOR_PROTOCOL_VERSION,
  isConnectorProtocolCapabilityArray,
  type RuntimeContinuationFact,
  STREAM_EVIDENCE_CAPABILITY,
  selectAuthoritativeContinuation,
  selectAuthoritativeSkip,
  validateStreamEvidenceCounts,
} from "./connector-runtime-protocol.ts";
import { type EmittedMessage, parseJsonlLine, type SkipResultBoundaryClaim, stringifyForJsonl } from "./index.ts";

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
    outcomes: { emitted: 7, gapped: 0, unaccounted: 0, unchanged: 3 },
    reference_only: true,
    stream: "message_bodies",
    type: "STREAM_EVIDENCE",
  };

  assert.equal(evidence.type, "STREAM_EVIDENCE");
});

test("protocol 0.0.2 parses STREAM_EVIDENCE independently of runtime advertisement", () => {
  const evidence: EmittedMessage = {
    considered: 1,
    outcomes: { emitted: 0, gapped: 0, unaccounted: 0, unchanged: 1 },
    reference_only: true,
    stream: "message_bodies",
    type: "STREAM_EVIDENCE",
  };

  assert.deepEqual(parseJsonlLine(stringifyForJsonl(evidence)), evidence);
});

test("STREAM_EVIDENCE requires the literal reference_only value", () => {
  const evidence: EmittedMessage = {
    considered: 10,
    outcomes: { emitted: 7, gapped: 0, unaccounted: 0, unchanged: 3 },
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
    outcomes: { emitted: 7, gapped: 0, unaccounted: 0, unchanged: 3 },
    reference_only: true,
    // @ts-expect-error stream must be a string.
    stream: 42,
    type: "STREAM_EVIDENCE",
  };
  assert.equal(evidence.type, "STREAM_EVIDENCE");
});

test("STREAM_EVIDENCE requires a numeric considered count and numeric outcome fields", () => {
  const invalidConsidered: EmittedMessage = {
    // @ts-expect-error considered must be a number.
    considered: "10",
    outcomes: { emitted: 7, gapped: 0, unaccounted: 0, unchanged: 3 },
    reference_only: true,
    stream: "message_bodies",
    type: "STREAM_EVIDENCE",
  };
  const invalidOutcomes: EmittedMessage = {
    considered: 10,
    outcomes: {
      emitted: 7,
      gapped: 0,
      unaccounted: 0,
      // @ts-expect-error unchanged must be a number.
      unchanged: "3",
    },
    reference_only: true,
    stream: "message_bodies",
    type: "STREAM_EVIDENCE",
  };
  assert.equal(invalidConsidered.type, "STREAM_EVIDENCE");
  assert.equal(invalidOutcomes.type, "STREAM_EVIDENCE");
});

test("STREAM_EVIDENCE has no scalar covered field on the wire", () => {
  const evidence: EmittedMessage = {
    considered: 10,
    // @ts-expect-error covered was replaced by the outcomes partition.
    covered: 7,
    outcomes: { emitted: 7, gapped: 0, unaccounted: 0, unchanged: 3 },
    reference_only: true,
    stream: "message_bodies",
    type: "STREAM_EVIDENCE",
  };
  assert.equal(evidence.type, "STREAM_EVIDENCE");
});

test("validateStreamEvidenceCounts accepts a disjoint partition that sums to considered", () => {
  assert.doesNotThrow(() =>
    validateStreamEvidenceCounts({
      considered: 214,
      outcomes: { emitted: 200, gapped: 2, unaccounted: 1, unchanged: 11 },
    })
  );
});

test("validateStreamEvidenceCounts rejects a sum that does not equal considered", () => {
  assert.throws(() =>
    validateStreamEvidenceCounts({
      considered: 214,
      outcomes: { emitted: 200, gapped: 2, unaccounted: 1, unchanged: 10 },
    })
  );
});

test("validateStreamEvidenceCounts rejects a non-integer outcome field", () => {
  assert.throws(() =>
    validateStreamEvidenceCounts({
      considered: 10,
      outcomes: { emitted: 7.5, gapped: 0, unaccounted: 0, unchanged: 2.5 },
    })
  );
});

test("validateStreamEvidenceCounts rejects a negative outcome field", () => {
  assert.throws(() =>
    validateStreamEvidenceCounts({
      considered: 10,
      outcomes: { emitted: -1, gapped: 0, unaccounted: 0, unchanged: 11 },
    })
  );
});

test("validateStreamEvidenceCounts rejects a count above Number.MAX_SAFE_INTEGER", () => {
  assert.throws(() =>
    validateStreamEvidenceCounts({
      considered: Number.MAX_SAFE_INTEGER + 1,
      outcomes: { emitted: Number.MAX_SAFE_INTEGER + 1, gapped: 0, unaccounted: 0, unchanged: 0 },
    })
  );
});

test("validateStreamEvidenceCounts accepts a count exactly at Number.MAX_SAFE_INTEGER", () => {
  assert.doesNotThrow(() =>
    validateStreamEvidenceCounts({
      considered: Number.MAX_SAFE_INTEGER,
      outcomes: { emitted: Number.MAX_SAFE_INTEGER, gapped: 0, unaccounted: 0, unchanged: 0 },
    })
  );
});

test("validateStreamEvidenceCounts rejects a missing outcomes object", () => {
  assert.throws(() => validateStreamEvidenceCounts({ considered: 10 }));
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

test("the protocol wire-version constant is independent of the package release version", () => {
  // CONNECTOR_PROTOCOL_VERSION tracks the wire contract (bumped only when the
  // message shapes change); package.json's version tracks release cadence
  // and is owned by semantic-release. They are unrelated numbers that happen
  // to look similar today — this package must never assert they're equal.
  assert.equal(CONNECTOR_PROTOCOL_VERSION, "0.0.2");
  assert.equal(STREAM_EVIDENCE_CAPABILITY, "STREAM_EVIDENCE");
});

// isConnectorProtocolCapabilityArray is the ONE vocabulary-authority check
// every untyped boundary (the placement gate, the collector-definitions
// generator, the snapshot generator) delegates to. Each case here is
// mutant-sensitive: flipping `.every` to `.some`, dropping the `Array.isArray`
// guard, or dropping the membership check against CONNECTOR_PROTOCOL_CAPABILITIES
// would each let a specific one of these cases wrongly pass.

test("isConnectorProtocolCapabilityArray accepts an empty array", () => {
  assert.equal(isConnectorProtocolCapabilityArray([]), true);
});

test("isConnectorProtocolCapabilityArray accepts every allowed capability value", () => {
  assert.equal(isConnectorProtocolCapabilityArray([...CONNECTOR_PROTOCOL_CAPABILITIES]), true);
  assert.equal(isConnectorProtocolCapabilityArray(["STREAM_EVIDENCE"]), true);
});

test("isConnectorProtocolCapabilityArray rejects a forged string member", () => {
  // Would wrongly pass if the check only verified Array.isArray without
  // checking membership of each element.
  assert.equal(isConnectorProtocolCapabilityArray(["FORGED"]), false);
});

test("isConnectorProtocolCapabilityArray rejects a null member", () => {
  assert.equal(isConnectorProtocolCapabilityArray([null]), false);
});

test("isConnectorProtocolCapabilityArray rejects an object member", () => {
  assert.equal(isConnectorProtocolCapabilityArray([{}]), false);
});

test("isConnectorProtocolCapabilityArray rejects a mix of one valid and one invalid member", () => {
  // Would wrongly pass if the check used `.some` instead of `.every` — a
  // single bad member must invalidate the whole array, not just be filtered.
  assert.equal(isConnectorProtocolCapabilityArray(["STREAM_EVIDENCE", "FORGED"]), false);
});

test("isConnectorProtocolCapabilityArray rejects non-array values", () => {
  assert.equal(isConnectorProtocolCapabilityArray(null), false);
  assert.equal(isConnectorProtocolCapabilityArray(undefined), false);
  assert.equal(isConnectorProtocolCapabilityArray("STREAM_EVIDENCE"), false);
  assert.equal(isConnectorProtocolCapabilityArray({}), false);
  assert.equal(isConnectorProtocolCapabilityArray(42), false);
});
