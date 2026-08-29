// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the pure literal-emission helpers backing
 * `generate-collector-definitions-snapshot.ts`. That script's real source
 * (`packages/polyfill-connectors/src/collector-registry.ts`) does not exist
 * in this checkout — see its module doc — so these tests exercise the
 * helpers directly against hand-built fixtures instead.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  type CollectorDefinitionSource,
  definitionLiteral,
  jsonStringArray,
} from "../scripts/collector-definitions-literal.ts";

const baseDefinition: CollectorDefinitionSource = {
  bindings: { filesystem: { required: true } },
  connector_id: "fixture_connector",
  entry: "fixture_connector",
  protocol_capabilities: [],
  streams: ["events"],
};

test("definitionLiteral always emits protocol_capabilities, even when explicitly empty", () => {
  const literal = definitionLiteral(baseDefinition);
  assert.match(literal, /protocol_capabilities: \[\],/);
});

test("definitionLiteral emits a non-empty protocol_capabilities array", () => {
  const literal = definitionLiteral({ ...baseDefinition, protocol_capabilities: ["STREAM_EVIDENCE"] });
  assert.match(literal, /protocol_capabilities: \["STREAM_EVIDENCE"\],/);
});

test("definitionLiteral throws (does not silently omit the line) when protocol_capabilities is missing", () => {
  // The exact defect this fix closes: the old code's `...(definition.protocol_capabilities
  // ? [...] : [])` spread silently omitted the line for a definition missing
  // the field. A missing field must fail loudly, naming the connector,
  // never produce a truncated literal.
  const malformed = { ...baseDefinition } as { protocol_capabilities?: readonly string[] };
  delete malformed.protocol_capabilities;
  assert.throws(
    () => definitionLiteral(malformed as unknown as CollectorDefinitionSource),
    /fixture_connector.*protocol_capabilities/s
  );
});

test("definitionLiteral throws when protocol_capabilities is present but not an array", () => {
  const malformed = {
    ...baseDefinition,
    protocol_capabilities: "STREAM_EVIDENCE",
  } as unknown as CollectorDefinitionSource;
  assert.throws(() => definitionLiteral(malformed), /fixture_connector.*protocol_capabilities/s);
});

test("definitionLiteral throws when protocol_capabilities is null", () => {
  const malformed = { ...baseDefinition, protocol_capabilities: null } as unknown as CollectorDefinitionSource;
  assert.throws(() => definitionLiteral(malformed), /fixture_connector.*protocol_capabilities/s);
});

// Round 3 review finding: an untyped generator input with a well-formed
// ARRAY containing a forged/malformed MEMBER (as opposed to the field being
// missing, null, or not an array at all) previously passed the old
// `Array.isArray`-only check and got emitted verbatim into the generated
// snapshot. Each case below is mutant-sensitive to the element-validation
// check specifically, not just the array-shape check above.

test("definitionLiteral throws when protocol_capabilities contains a forged string member", () => {
  const malformed = {
    ...baseDefinition,
    protocol_capabilities: ["FORGED"],
  } as unknown as CollectorDefinitionSource;
  assert.throws(() => definitionLiteral(malformed), /fixture_connector.*protocol_capabilities/s);
});

test("definitionLiteral throws when protocol_capabilities contains a null member", () => {
  const malformed = {
    ...baseDefinition,
    protocol_capabilities: [null],
  } as unknown as CollectorDefinitionSource;
  assert.throws(() => definitionLiteral(malformed), /fixture_connector.*protocol_capabilities/s);
});

test("definitionLiteral throws when protocol_capabilities contains an object member", () => {
  const malformed = {
    ...baseDefinition,
    protocol_capabilities: [{}],
  } as unknown as CollectorDefinitionSource;
  assert.throws(() => definitionLiteral(malformed), /fixture_connector.*protocol_capabilities/s);
});

test("definitionLiteral throws when protocol_capabilities mixes one valid and one invalid member", () => {
  // Would wrongly pass (and emit the bad member) if the guard used `.some`
  // (any valid member present) instead of `.every` (all members valid).
  const malformed = {
    ...baseDefinition,
    protocol_capabilities: ["STREAM_EVIDENCE", "FORGED"],
  } as unknown as CollectorDefinitionSource;
  assert.throws(() => definitionLiteral(malformed), /fixture_connector.*protocol_capabilities/s);
});

test("jsonStringArray renders an empty array as []", () => {
  assert.equal(jsonStringArray([]), "[]");
});

test("jsonStringArray renders each value as a JSON string literal", () => {
  assert.equal(jsonStringArray(["a", "b"]), `["a", "b"]`);
});
