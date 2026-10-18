// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Pure, no-DB unit tests for operations/read-projection.ts — the shared read-side
// field-projection helpers. No test imports this module by name. These implement
// the `fields` query-param contract used across read operations: parse the field
// list, then whitelist a record's data down to those fields.
//
// Mutation surface:
//   normalizeProjectionFields -- array OR comma-string input, flattens nested
//     commas, trims, drops blanks, DEDUPES, and returns null for an empty result.
//   projectRecordEnvelope -- when the record has a plain-object `data`, projects
//     `data` (preserving sibling envelope fields like id); otherwise projects the
//     record itself; no/empty fields -> the record unchanged; whitelist semantics
//     (only present, requested keys survive); a tombstone (object "record",
//     deleted true, no data) is returned unchanged.

import assert from "node:assert/strict";
import test from "node:test";

import { normalizeProjectionFields, projectRecordEnvelope } from "../operations/read-projection.ts";

// ---------------------------------------------------------------------------
// normalizeProjectionFields
// ---------------------------------------------------------------------------

test("normalizeProjectionFields: a comma string is split into fields", () => {
  assert.deepEqual(normalizeProjectionFields("a,b,c"), ["a", "b", "c"]);
});

test("normalizeProjectionFields: an array of fields passes through", () => {
  assert.deepEqual(normalizeProjectionFields(["a", "b"]), ["a", "b"]);
});

test("normalizeProjectionFields: nested commas inside array entries are flattened", () => {
  assert.deepEqual(normalizeProjectionFields(["a,b", "c"]), ["a", "b", "c"]);
});

test("normalizeProjectionFields: trims whitespace, drops blanks, and DEDUPES", () => {
  assert.deepEqual(normalizeProjectionFields(" a , a , b , "), ["a", "b"], "dedup + trim + drop empties");
});

test("normalizeProjectionFields: empty / whitespace / non-string-non-array -> null", () => {
  assert.equal(normalizeProjectionFields(""), null);
  assert.equal(normalizeProjectionFields("   "), null, "only-whitespace yields no fields -> null");
  assert.equal(normalizeProjectionFields([]), null);
  assert.equal(normalizeProjectionFields(null), null);
  assert.equal(normalizeProjectionFields(42), null, "a bare number is not a field spec");
});

// ---------------------------------------------------------------------------
// projectRecordEnvelope
// ---------------------------------------------------------------------------

test("projectRecordEnvelope: projects the data sub-object, preserving envelope siblings", () => {
  const out = projectRecordEnvelope({ data: { a: 1, b: 2, c: 3 }, id: "rec-1", object: "record" }, ["a", "c"]);
  assert.deepEqual(out.data, { a: 1, c: 3 }, "only requested data fields survive");
  assert.equal(out.id, "rec-1", "envelope id preserved");
  assert.equal(out.object, "record", "envelope object preserved");
});

test("projectRecordEnvelope: a record without a data object is projected directly", () => {
  const out = projectRecordEnvelope({ a: 1, b: 2, c: 3 }, ["a"]);
  assert.deepEqual(out, { a: 1 });
});

test("projectRecordEnvelope: no / empty fields returns the record unchanged", () => {
  const record = { data: { a: 1 }, id: "1" };
  assert.equal(projectRecordEnvelope(record, null), record, "null fields -> unchanged (same ref)");
  assert.equal(projectRecordEnvelope(record, []), record, "empty fields -> unchanged");
});

test("projectRecordEnvelope: a requested field absent from data simply does not appear (no undefined key)", () => {
  const out = projectRecordEnvelope({ data: { a: 1 }, id: "1" }, ["a", "missing"]);
  assert.deepEqual(out.data, { a: 1 }, "absent requested field is omitted, not set to undefined");
  assert.ok(!("missing" in out.data), "no phantom key created");
});

test("projectRecordEnvelope: an array-valued data is NOT treated as a projectable object", () => {
  // data is an array -> the not-a-plain-object branch projects the record itself.
  const out = projectRecordEnvelope({ data: [1, 2, 3], id: "1" }, ["id"]);
  assert.deepEqual(out, { id: "1" }, "array data falls through to record-level projection");
});

// spec-core §4 "Tombstones": a tombstone is the `object: "record"` envelope with
// `deleted: true`, both timestamps, and no `data`. Sparse `fields` select data
// fields, so there is nothing to project; the envelope must survive intact.
const TOMBSTONE = Object.freeze({
  connection_id: "cin_a",
  deleted: true,
  deleted_at: "2026-04-01T10:00:00Z",
  emitted_at: "2026-04-01T10:00:01Z",
  id: "r1",
  object: "record",
  stream: "playlists",
});

test("projectRecordEnvelope: a tombstone keeps its whole envelope under any sparse field list", () => {
  for (const fields of [["id"], ["name"], ["id", "name"], ["deleted"]]) {
    const out = projectRecordEnvelope({ ...TOMBSTONE }, fields);
    assert.deepEqual(out, TOMBSTONE, `fields=${fields.join(",")} must not strip tombstone markers`);
    assert.ok(!Object.hasOwn(out, "data"), "a tombstone never gains a data field");
  }
});

test("projectRecordEnvelope: a decorated tombstone with an undefined data key keeps its envelope", () => {
  // The native host's blob-ref decorator copies the record and assigns
  // `data` even when it is absent, leaving `data: undefined`.
  const out = projectRecordEnvelope({ ...TOMBSTONE, data: undefined }, ["id"]);
  assert.deepEqual(JSON.parse(JSON.stringify(out)), TOMBSTONE);
});

test("projectRecordEnvelope: only a complete tombstone shape bypasses projection", () => {
  // Without `deleted: true`, or with `object` other than "record", the flat
  // fallback still applies; a data-bearing record is still projected inside data.
  assert.deepEqual(projectRecordEnvelope({ deleted: false, id: "r1", object: "record", x: 1 }, ["id"]), { id: "r1" });
  assert.deepEqual(projectRecordEnvelope({ deleted: true, id: "r1", object: "other", x: 1 }, ["id"]), { id: "r1" });
  assert.deepEqual(
    projectRecordEnvelope({ data: { a: 1, b: 2 }, deleted: true, id: "r1", object: "record" }, ["a"]),
    { data: { a: 1 }, deleted: true, id: "r1", object: "record" }
  );
});
