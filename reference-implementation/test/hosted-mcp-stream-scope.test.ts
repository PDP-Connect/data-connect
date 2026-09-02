// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for per-stream field and date-range narrowing.
 *
 * The picker granted every field of every checked stream with no date bound,
 * and described that as "Everything in each data type you check, with no date
 * limit" — an unbuilt feature phrased as a property of the protocol.
 * `spec-core.md:761` makes `fields` a protocol-enforced allowlist and
 * `spec-core.md:758-759` makes `time_range` a protocol-enforced window, both
 * already enforced by the resource server.
 *
 * These tests pin the two rules most likely to be eroded later:
 *
 *   1. capability is read from the declaration, never assumed — offering a
 *      control the manifest does not support produces a 400 at issuance,
 *      after the owner has already chosen;
 *   2. schema-required fields are the consent floor (`spec-core.md:764`) and
 *      survive any submission that tries to drop them.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  describeStreamScope,
  describeTimeField,
  normalizeScopeBound,
  resolveStreamScopeCapability,
  resolveStreamScopeSelection,
  type StreamScopeSource,
} from "../server/hosted-mcp-stream-scope.ts";

/** Shaped like ChatGPT's `messages` stream, which declares both capabilities. */
function messagesStream(overrides: Partial<StreamScopeSource> = {}): StreamScopeSource {
  return {
    consent_time_field: "create_time",
    name: "messages",
    schema: {
      properties: { author: {}, content: {}, conversation_id: {}, create_time: {}, id: {} },
      required: ["id", "conversation_id"],
    },
    selection: { fields: true },
    ...overrides,
  };
}

const isoDay = (iso: string) => iso.slice(0, 10);

// ─── Capability resolution ───────────────────────────────────────────────────

test("capability splits required fields from the ones an owner may switch off", () => {
  const capability = resolveStreamScopeCapability(messagesStream());

  assert.deepEqual(capability.requiredFields, ["conversation_id", "id"]);
  assert.deepEqual(capability.optionalFields, ["author", "content", "create_time"]);
  assert.equal(capability.supportsFieldNarrowing, true);
  assert.equal(capability.timeField, "create_time");
});

test("a stream that does not declare selection.fields offers no field control", () => {
  const capability = resolveStreamScopeCapability(messagesStream({ selection: { fields: false } }));

  assert.equal(capability.supportsFieldNarrowing, false);
  assert.deepEqual(capability.optionalFields, [], "no control is offered for a capability the manifest lacks");
  // Required fields are still reported, so the scope can be described honestly.
  assert.deepEqual(capability.requiredFields, ["conversation_id", "id"]);
});

test("a stream without consent_time_field has no temporal scope", () => {
  // spec-core.md:547 — absence is the normative signal, not an oversight.
  const capability = resolveStreamScopeCapability(messagesStream({ consent_time_field: null }));

  assert.equal(capability.timeField, null);
});

// ─── Field narrowing ─────────────────────────────────────────────────────────

test("a narrowed field selection always includes the schema-required fields", () => {
  // The owner checked only `content`; `id` and `conversation_id` are the
  // consent floor and come along regardless (spec-core.md:764).
  const result = resolveStreamScopeSelection(messagesStream(), { fields: ["content"] });

  assert.ok("selection" in result);
  assert.deepEqual(result.selection.fields, ["content", "conversation_id", "id"]);
});

test("selecting every field omits the allowlist rather than restating it", () => {
  const all = ["author", "content", "conversation_id", "create_time", "id"];
  const result = resolveStreamScopeSelection(messagesStream(), { fields: all });

  assert.ok("selection" in result);
  assert.equal(result.selection.fields, null, "asking for everything is not a narrowing");
});

test("a field the schema does not declare is rejected, not silently dropped", () => {
  const result = resolveStreamScopeSelection(messagesStream(), { fields: ["content", "password"] });

  assert.ok("error" in result);
  assert.match(result.error.message, /no field named password/);
});

test("field narrowing on a stream that does not support it is rejected", () => {
  const result = resolveStreamScopeSelection(messagesStream({ selection: { fields: false } }), {
    fields: ["content"],
  });

  assert.ok("error" in result, "the resolver would 400 on this; catch it while the owner is still on the page");
});

test("omitting the field list asks for every field, which stays the default", () => {
  const result = resolveStreamScopeSelection(messagesStream(), {});

  assert.ok("selection" in result);
  assert.equal(result.selection.fields, null);
  assert.equal(result.selection.timeRange, null);
});

// ─── Date range ──────────────────────────────────────────────────────────────

test("a since bound becomes the start of that day, inclusive", () => {
  const result = resolveStreamScopeSelection(messagesStream(), { since: "2026-03-01" });

  assert.ok("selection" in result);
  assert.deepEqual(result.selection.timeRange, { since: "2026-03-01T00:00:00.000Z" });
});

test("an until bound covers the whole day the owner picked", () => {
  // `until` is exclusive (spec-core.md:759). Picking one day as both bounds
  // must authorize that day, not an empty window.
  const result = resolveStreamScopeSelection(messagesStream(), { since: "2026-03-01", until: "2026-03-01" });

  assert.ok("selection" in result);
  assert.deepEqual(result.selection.timeRange, {
    since: "2026-03-01T00:00:00.000Z",
    until: "2026-03-02T00:00:00.000Z",
  });
});

test("a date range on a stream with no consent_time_field is rejected", () => {
  const result = resolveStreamScopeSelection(messagesStream({ consent_time_field: null }), { since: "2026-03-01" });

  assert.ok("error" in result);
  assert.match(result.error.message, /cannot be limited by date/);
});

test("an unparseable date is a correction, not a silently ignored value", () => {
  for (const bad of ["yesterday", "03/01/2026", "2026-3-1", "2026-13-45"]) {
    const result = resolveStreamScopeSelection(messagesStream(), { since: bad });
    assert.ok("error" in result, `expected ${bad} to be rejected`);
  }
});

test("a backwards range is rejected before it reaches the resolver", () => {
  const result = resolveStreamScopeSelection(messagesStream(), { since: "2026-06-01", until: "2026-03-01" });

  assert.ok("error" in result);
  assert.match(result.error.message, /must come before/);
});

test("blank date inputs mean no bound, not an error", () => {
  const result = resolveStreamScopeSelection(messagesStream(), { since: "", until: "   " });

  assert.ok("selection" in result);
  assert.equal(result.selection.timeRange, null);
});

test("normalizeScopeBound distinguishes unset from unparseable", () => {
  assert.equal(normalizeScopeBound("", "since"), null, "unset");
  assert.equal(normalizeScopeBound(undefined, "since"), null, "unset");
  assert.equal(normalizeScopeBound("nonsense", "since"), undefined, "unparseable");
  assert.equal(normalizeScopeBound("2026-03-01", "since"), "2026-03-01T00:00:00.000Z");
});

// ─── Owner-facing description (spec-core.md:545) ─────────────────────────────

test("a scope is described in words, never as time_range", () => {
  const capability = resolveStreamScopeCapability(messagesStream());
  const result = resolveStreamScopeSelection(messagesStream(), { fields: ["content"], since: "2026-03-01" });

  assert.ok("selection" in result);
  const described = describeStreamScope(capability, result.selection, isoDay);

  // spec-core.md:545 wants "created on or after ...", not "in time_range".
  assert.equal(described, "3 of 5 fields · created on or after 2026-03-01");
  assert.doesNotMatch(described, /time_range|consent_time_field/);
});

test("a closed range reports the last day the owner chose, not the exclusive bound", () => {
  const capability = resolveStreamScopeCapability(messagesStream());
  const result = resolveStreamScopeSelection(messagesStream(), { since: "2026-03-01", until: "2026-03-31" });

  assert.ok("selection" in result);
  // The grant stores 2026-04-01T00:00:00Z; the owner picked March 31.
  assert.equal(describeStreamScope(capability, result.selection, isoDay), "All fields · created 2026-03-01 to 2026-03-31");
});

test("an unnarrowed scope says so plainly", () => {
  const capability = resolveStreamScopeCapability(messagesStream());
  const result = resolveStreamScopeSelection(messagesStream(), {});

  assert.ok("selection" in result);
  assert.equal(describeStreamScope(capability, result.selection, isoDay), "All fields · all dates");
});

test("time fields humanize to the verb an owner reads", () => {
  assert.equal(describeTimeField("create_time"), "created");
  assert.equal(describeTimeField("created_at"), "created");
  assert.equal(describeTimeField("updated_at"), "updated");
  assert.equal(describeTimeField("sent_at"), "sent");
  assert.equal(describeTimeField("played_at"), "played");
  // An unrecognized field must never print raw at the owner.
  assert.equal(describeTimeField("weird_internal_ts"), "dated");
  assert.equal(describeTimeField(null), "dated");
});
