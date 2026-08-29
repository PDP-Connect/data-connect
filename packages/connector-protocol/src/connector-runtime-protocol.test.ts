// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  CONNECTOR_PROTOCOL_CAPABILITIES,
  CONNECTOR_PROTOCOL_VERSION,
  isConnectorProtocolCapabilityArray,
  STREAM_EVIDENCE_CAPABILITY,
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

test("the package identity matches the protocol wire-version constant", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
    version?: unknown;
  };

  assert.equal(CONNECTOR_PROTOCOL_VERSION, packageJson.version);
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
