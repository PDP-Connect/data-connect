// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRecordContentLadder,
  buildRecordSetContentLadder,
  decodeContentHandle,
  defaultEncodeResourceUri,
  encodeContentHandle,
  sanitizeRecordForEvidence,
  summarizeFieldWindowEvidence,
  summarizeRecordEvidence,
} from "../src/index.ts";

test("record ladder uses envelope identity and carries instance through every continuation", () => {
  const ladder = buildRecordContentLadder({
    object: "record",
    id: "canonical/id:1",
    instance_id: "inst/a:b",
    stream: "messages",
    data: {
      id: "payload-id-is-not-canonical",
      body: "body ".repeat(500),
      details: { nested: true },
    },
  });

  assert.equal(ladder.id, "canonical/id:1");
  assert.equal(ladder.instance_id, "inst/a:b");
  assert.equal(ladder.stream, "messages");
  assert.equal("connection_id" in ladder, false);
  assert.equal("connector_instance_id" in ladder, false);
  assert.deepEqual(ladder.field_windows[0].read.args, {
    id: "canonical/id:1",
    instance_id: "inst/a:b",
    stream: "messages",
    field_path: "body",
    offset_chars: 0,
    limit_chars: 2048,
  });
  assert.deepEqual(
    {
      id: ladder.field_windows[0].id,
      instance_id: ladder.field_windows[0].instance_id,
      stream: ladder.field_windows[0].stream,
    },
    { id: "canonical/id:1", instance_id: "inst/a:b", stream: "messages" }
  );
  assert.deepEqual(
    {
      id: ladder.json_fields[0].id,
      instance_id: ladder.json_fields[0].instance_id,
      stream: ladder.json_fields[0].stream,
    },
    { id: "canonical/id:1", instance_id: "inst/a:b", stream: "messages" }
  );
  assert.deepEqual(ladder.json_fields[0].read.args, {
    id: "canonical/id:1",
    instance_id: "inst/a:b",
    stream: "messages",
    fields: ["details"],
  });

  const record = decodeContentHandle(ladder.record_uri.replace("pdpp://record/", ""), "record");
  assert.deepEqual(
    { id: record.id, instance_id: record.instance_id, stream: record.stream },
    { id: "canonical/id:1", instance_id: "inst/a:b", stream: "messages" }
  );
  const field = decodeContentHandle(
    ladder.field_windows[0].resource_uri.replace("pdpp://field-window/", ""),
    "field-window"
  );
  assert.deepEqual(
    { id: field.id, instance_id: field.instance_id, stream: field.stream },
    { id: "canonical/id:1", instance_id: "inst/a:b", stream: "messages" }
  );
});

test("same canonical key in two instances retains two record-set entries and handles", () => {
  const ladder = buildRecordSetContentLadder(
    {
      records: [
        { object: "record", id: "shared", instance_id: "inst/a", stream: "messages", data: { text: "a" } },
        { object: "record", id: "shared", instance_id: "inst:b", stream: "messages", data: { text: "b" } },
      ],
    },
    { recordLimit: 2 }
  );

  assert.equal(ladder.records.length, 2);
  assert.deepEqual(ladder.records.map(({ id, instance_id }) => ({ id, instance_id })), [
    { id: "shared", instance_id: "inst/a" },
    { id: "shared", instance_id: "inst:b" },
  ]);
  assert.notEqual(ladder.records[0].record_uri, ladder.records[1].record_uri);
});

test("legacy connection_id input alias is accepted and conflicting aliases fail with a typed error", () => {
  const ladder = buildRecordContentLadder(
    { id: "messages:m1", stream: "messages", data: { body: "hello" } },
    { fallback: { connection_id: "legacy/a" } }
  );

  assert.equal(ladder.instance_id, "legacy/a");
  assert.equal("connection_id" in ladder, false);
  assert.throws(
    () =>
      buildRecordContentLadder(
        { id: "m1", stream: "messages", instance_id: "inst-new", connection_id: "legacy-old", data: {} },
        { fallback: { stream: "messages" } }
      ),
    { name: "RecordIdentityConflictError", code: "conflicting_instance_id" }
  );
  assert.throws(
    () =>
      buildRecordContentLadder(
        { id: "m1", stream: "messages", data: {} },
        { fallback: { stream: "messages", instance_id: "inst-new", connection_id: "legacy-old" } }
      ),
    { name: "RecordIdentityConflictError", code: "conflicting_instance_id" }
  );
});

test("unresolved instance identity does not produce usable read capabilities", () => {
  const ladder = buildRecordContentLadder({ id: "k", stream: "messages", data: { body: "hello" } });
  assert.equal(ladder, null);

  const records = buildRecordSetContentLadder({
    records: [
      { id: "k", stream: "messages", data: { body: "from A" } },
      { id: "k", stream: "messages", data: { body: "from B" } },
    ],
  });
  assert.equal(records, null);

  assert.throws(() => encodeContentHandle("record", { id: "k", stream: "messages" }), {
    name: "RecordIdentityConflictError",
    code: "missing_instance_id",
  });
  assert.throws(() => defaultEncodeResourceUri("record", { id: "k", instance_id: null, stream: "messages" }), {
    name: "RecordIdentityConflictError",
    code: "malformed_instance_id",
  });
});

test("present malformed instance aliases are refused", () => {
  for (const bad of [123, ["A"], {}, true, ""]) {
    assert.throws(
      () => buildRecordContentLadder({ id: "k", instance_id: bad, stream: "messages", data: { body: "x" } }),
      { name: "RecordIdentityConflictError", code: "malformed_instance_id" }
    );
  }
  assert.throws(
    () => buildRecordContentLadder({ id: "k", instance_id: 123, connection_id: "A", stream: "messages", data: {} }),
    { name: "RecordIdentityConflictError", code: "malformed_instance_id" }
  );
  for (const [field, fallback] of [
    ["connection_id", { connection_id: "" }],
    ["connector_instance_id", { connector_instance_id: false }],
    ["connectionId", { connectionId: [] }],
    ["instanceId", { instanceId: {} }],
  ]) {
    assert.throws(
      () => buildRecordContentLadder({ id: "k", stream: "messages", data: {} }, { fallback }),
      { name: "RecordIdentityConflictError", code: "malformed_instance_id" },
      field
    );
  }
  assert.throws(
    () => buildRecordContentLadder({ id: "k", stream: "messages", data: {} }, { fallback: { recordId: "" } }),
    { name: "RecordIdentityConflictError", code: "malformed_record_id" }
  );
});

test("present malformed envelope record ids are refused instead of using payload ids", () => {
  for (const id of [42, ["a", "b"], {}, true, ""]) {
    assert.throws(
      () => buildRecordContentLadder({ id, instance_id: "A", stream: "messages", data: { id: "payload", body: "x" } }),
      { name: "RecordIdentityConflictError", code: "malformed_record_id" }
    );
  }
});

test("a URL-shaped canonical key is not parsed as a legacy instance handle", () => {
  assert.equal(buildRecordContentLadder({ id: "https://x.example/a:b", data: { body: "x" } }), null);
  assert.equal(buildRecordContentLadder({ id: "mailto:/path:a", instance_id: "A", data: { body: "x" } }), null);
  assert.equal(
    buildRecordContentLadder({ id: "https://x.example/a:b", instance_id: "A", data: { body: "x" } }),
    null
  );
});

test("canonical record envelope ids are never parsed as legacy handles", () => {
  assert.equal(
    buildRecordContentLadder({ object: "record", id: "canonical/id:1", instance_id: "A", data: { body: "x" } }),
    null
  );
});

test("legacy identity is never inferred from application payload fields, which remain evidence", () => {
  const record = {
    object: "record",
    id: "m1",
    stream: "messages",
    data: { connection_id: "application value", connector_instance_id: "also application data", body: "text" },
  };
  const ladder = buildRecordContentLadder(record);

  assert.equal(ladder, null);
  assert.deepEqual(sanitizeRecordForEvidence(record).data, record.data);
});

test("tombstones retain the pairwise record identity without requiring data", () => {
  const ladder = buildRecordContentLadder({
    object: "record",
    id: "shared",
    instance_id: "inst/a",
    stream: "messages",
    deleted: true,
  });

  assert.equal(ladder.id, "shared");
  assert.equal(ladder.instance_id, "inst/a");
  const uri = decodeContentHandle(ladder.record_uri.replace("pdpp://record/", ""), "record");
  assert.equal(uri.instance_id, "inst/a");
});

test("record evidence normalizes envelope aliases and keeps application data untouched", () => {
  const text = summarizeRecordEvidence(
    {
      records: [
        {
          object: "record",
          id: "canonical",
          instance_id: "inst/a",
          connection_id: "inst/a",
          stream: "messages",
          data: { connection_id: "application value", connector_instance_id: "application value 2" },
        },
      ],
    },
    "messages"
  );
  assert.match(text, /"instance_id":"inst\/a"/);
  assert.match(text, /"connection_id":"application value"/);
  assert.match(text, /"connector_instance_id":"application value 2"/);
});

test("field-window evidence renders identity as an unambiguous tuple", () => {
  const text = summarizeFieldWindowEvidence({
    instance_id: "inst/a:b",
    stream: "messages/old",
    id: "canonical/id:with/slashes",
    record_id: "id:with/slashes",
    field: { path: "body" },
    window: { text: "x", complete: true },
  });
  assert.match(text, /record=\["inst\/a:b","messages\/old","canonical\/id:with\/slashes"\]/);
  assert.doesNotMatch(text, /connection_id|connector_instance_id/);
});
