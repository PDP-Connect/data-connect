// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRecordContentLadder,
  buildRecordSetContentLadder,
  summarizeRecordEvidence,
} from "../src/index.ts";

// Canonical keys and opaque instance handles may contain any byte, including
// the `/` and `:` used by the legacy self-contained `instance/stream:key` id.
const DELIMITER_KEYS = ["o2", "https://example.test/a", "order:part", '["a:b","x/y"]', "a/b", "x/y:z"];

function searchResult(key: string, instance: string) {
  return {
    id: `${instance}/orders:${key}`,
    record_key: key,
    connection_id: instance,
    stream: "orders",
    data: { body: "hello" },
  };
}

test("N1: MCP SearchResult keeps every explicit canonical key, including delimiter bytes", () => {
  for (const key of DELIMITER_KEYS) {
    const ladder = buildRecordContentLadder(searchResult(key, "inst_public"), {
      fallback: { recordId: key, connectionId: "inst_public", stream: "orders" },
    });
    assert.equal(ladder?.id, key, key);
    assert.equal(ladder?.instance_id, "inst_public", key);
    assert.equal(ladder?.stream, "orders", key);
    assert.deepEqual(
      ladder?.field_windows[0].read.args,
      { id: key, instance_id: "inst_public", stream: "orders", field_path: "body", offset_chars: 0, limit_chars: 2048 },
      key
    );
  }
});

test("N1: opaque instance handles containing delimiters do not break plain or delimiter keys", () => {
  for (const instance of ["inst/a", "inst:b", "a/b:c"]) {
    for (const key of ["k", "x/y:z"]) {
      const ladder = buildRecordContentLadder(searchResult(key, instance), {
        fallback: { recordId: key, connectionId: instance, stream: "orders" },
      });
      assert.deepEqual(
        { id: ladder?.id, instance_id: ladder?.instance_id },
        { id: key, instance_id: instance },
        `${instance} ${key}`
      );
    }
  }
});

test("N1: the stream-only legacy handle and a literal-key id are accepted as consistent", () => {
  for (const id of ["orders:x/y:z", "x/y:z"]) {
    const ladder = buildRecordContentLadder(
      { id, record_key: "x/y:z", connection_id: "A", stream: "orders", data: { body: "b" } },
      {}
    );
    assert.equal(ladder?.id, "x/y:z", id);
  }
});

test("N1: a SearchResult handle that names a different record is refused, not reverse-parsed", () => {
  for (const id of ["A/orders:other", "B/orders:k", "A/other:k", "orders:other"]) {
    assert.throws(
      () =>
        buildRecordContentLadder(
          { id, record_key: "k", connection_id: "A", stream: "orders", data: { body: "b" } },
          { fallback: { recordId: "k", connectionId: "A", stream: "orders" } }
        ),
      { name: "RecordIdentityConflictError", code: "conflicting_record_id" },
      id
    );
  }
});

test("N2: explicitly undefined optional inputs are absent, not malformed (real MCP fallback shapes)", () => {
  const record = { object: "record", id: "o1", instance_id: "A", stream: "orders", data: { t: "x" } };
  for (const fallback of [
    { stream: undefined, connectionId: undefined },
    { stream: "orders", connectionId: undefined },
    { stream: undefined, recordId: undefined, connectionId: undefined },
    { id: undefined, connectionId: undefined },
    { instance_id: undefined, instanceId: undefined, connection_id: undefined, connector_instance_id: undefined },
    { record_id: undefined, stream_name: undefined },
  ]) {
    const ladder = buildRecordContentLadder(record, { fallback });
    assert.deepEqual(
      { id: ladder?.id, instance_id: ladder?.instance_id, stream: ladder?.stream },
      { id: "o1", instance_id: "A", stream: "orders" },
      JSON.stringify(Object.keys(fallback))
    );
  }
  const envelope = buildRecordContentLadder({
    object: "record",
    id: "o1",
    instance_id: "A",
    connection_id: undefined,
    connector_instance_id: undefined,
    record_key: undefined,
    stream: "orders",
    data: { t: "x" },
  });
  assert.equal(envelope?.instance_id, "A");
});

test("N2: present null, empty and non-string identity values stay malformed", () => {
  const record = { object: "record", id: "o1", instance_id: "A", stream: "orders", data: { t: "x" } };
  for (const [fallback, code] of [
    [{ connectionId: null }, "malformed_instance_id"],
    [{ instanceId: "" }, "malformed_instance_id"],
    [{ stream: null }, "malformed_stream"],
    [{ recordId: null }, "malformed_record_id"],
    [{ id: 7 }, "malformed_record_id"],
  ] as const) {
    assert.throws(() => buildRecordContentLadder(record, { fallback }), {
      name: "RecordIdentityConflictError",
      code,
    });
  }
  assert.throws(() => buildRecordContentLadder({ ...record, connection_id: null }), {
    name: "RecordIdentityConflictError",
    code: "malformed_instance_id",
  });
});

test("N3: an unmarked row with an explicit stream keeps its literal id", () => {
  for (const id of ["a:b", "x/y:z", "inst/s:key", "https://x.example/a:b"]) {
    const ladder = buildRecordContentLadder({ id, instance_id: "A", stream: "orders", body: "hello" });
    assert.equal(ladder?.id, id, id);
    assert.equal(ladder?.instance_id, "A", id);
    assert.equal(ladder?.stream, "orders", id);
  }
  const viaFallbackStream = buildRecordContentLadder(
    { id: "a:b", instance_id: "A", data: { body: "x" } },
    { fallback: { stream: "orders" } }
  );
  assert.equal(viaFallbackStream?.id, "a:b");
});

test("N3: legacy composite ids are parsed only when no stream is otherwise known", () => {
  const legacy = buildRecordContentLadder({ id: "A/orders:k", data: { body: "x" } });
  assert.deepEqual(
    { id: legacy?.id, instance_id: legacy?.instance_id, stream: legacy?.stream },
    { id: "k", instance_id: "A", stream: "orders" }
  );
  const fetchHandle = buildRecordContentLadder({ data: { body: "x" } }, { fallback: { id: "orders:k", connectionId: "A" } });
  assert.deepEqual(
    { id: fetchHandle?.id, instance_id: fetchHandle?.instance_id, stream: fetchHandle?.stream },
    { id: "k", instance_id: "A", stream: "orders" }
  );
  // A legacy handle naming another instance is not this record's handle.
  assert.equal(buildRecordContentLadder({ id: "B/orders:k", instance_id: "A", data: { body: "x" } }), null);
});

test("N4: application data fields never select record identity", () => {
  for (const data of [{ id: "app-value", t: "x" }, { record_id: "app-value", t: "x" }]) {
    assert.equal(buildRecordContentLadder({ object: "record", instance_id: "A", stream: "orders", data }), null);
    assert.equal(
      buildRecordContentLadder({ data }, { fallback: { stream: "orders", connectionId: "A" } }),
      null
    );
  }
  const evidence = summarizeRecordEvidence(
    { records: [{ object: "record", instance_id: "A", stream: "orders", data: { id: "app-value" } }] },
    "orders"
  );
  assert.match(evidence, /"data":\{"id":"app-value"\}/);
});

test("N5: envelope camel-case instance aliases are read and conflict checked like the others", () => {
  for (const alias of ["instanceId", "connectionId"]) {
    const ladder = buildRecordContentLadder({ object: "record", id: "o1", [alias]: "A", stream: "s", data: { t: "x" } });
    assert.equal(ladder?.instance_id, "A", alias);
    assert.throws(
      () =>
        buildRecordContentLadder({ object: "record", id: "o1", instance_id: "A", [alias]: "B", stream: "s", data: {} }),
      { name: "RecordIdentityConflictError", code: "conflicting_instance_id" },
      alias
    );
  }
});

test("N5: every recognized record-key alias is conflict checked", () => {
  for (const [record, fallback] of [
    [{ object: "record", id: "a", record_id: "b" }, {}],
    [{ id: "a", record_key: "b" }, {}],
    [{ record_key: "a", recordId: "b" }, {}],
    [{ object: "record", id: "a" }, { recordId: "b" }],
    [{ object: "record", id: "a" }, { record_id: "b" }],
  ]) {
    assert.throws(
      () => buildRecordContentLadder({ ...record, instance_id: "A", stream: "s", data: { t: "x" } }, { fallback }),
      { name: "RecordIdentityConflictError", code: "conflicting_record_id" },
      JSON.stringify([record, fallback])
    );
  }
});

test("N5: record and fallback streams that disagree are refused", () => {
  assert.throws(
    () =>
      buildRecordContentLadder(
        { object: "record", id: "o1", instance_id: "A", stream: "orders", data: { t: "x" } },
        { fallback: { stream: "messages" } }
      ),
    { name: "RecordIdentityConflictError", code: "conflicting_stream" }
  );
});

test("N5: record sets drop unresolved rows but fail closed on a conflicting row", () => {
  const ok = { object: "record", id: "ok", instance_id: "A", stream: "s", data: { t: "x" } };
  const unresolved = { object: "record", id: "no-instance", stream: "s", data: { t: "y" } };
  const set = buildRecordSetContentLadder({ records: [ok, unresolved] });
  assert.deepEqual(
    set?.records.map((record) => record.id),
    ["ok"]
  );
  const conflicting = { object: "record", id: "bad", instance_id: "A", connection_id: "B", stream: "s", data: {} };
  assert.throws(() => buildRecordSetContentLadder({ records: [ok, conflicting] }), {
    name: "RecordIdentityConflictError",
    code: "conflicting_instance_id",
  });
});

test("N5: evidence previews render a non-string id verbatim and do not invent identity", () => {
  const text = summarizeRecordEvidence({ data: [{ id: 7, n: 1 }] }, "rows");
  assert.match(text, /record\[0\] \{"id":7,"n":1\}/);
});

test("tombstones publish no binary fetch capability for a leftover data blob", () => {
  const ladder = buildRecordContentLadder({
    object: "record",
    id: "k",
    instance_id: "A",
    stream: "s",
    deleted: true,
    data: { photo: { blob_id: "b1", fetch_url: "https://rs/blob/b1", mime_type: "image/png" } },
  });
  assert.equal(ladder?.id, "k");
  assert.equal(ladder?.binary_fields, undefined);
});

test("a canonical record envelope id wins over a SearchResult-only record_key field", () => {
  // Shape from the MCP hostile-client fetch fixture: record_key is not part of
  // the canonical record envelope, so it neither replaces nor contradicts `id`.
  const ladder = buildRecordContentLadder(
    {
      object: "record",
      id: "rec_big",
      stream: "orders",
      connection_id: "conn_orders",
      record_key: "o9",
      data: { id: "o9", text: "x" },
    },
    { fallback: { id: "orders:rec_big", connectionId: "conn_orders" } }
  );
  assert.deepEqual(
    { id: ladder?.id, instance_id: ladder?.instance_id, stream: ladder?.stream },
    { id: "rec_big", instance_id: "conn_orders", stream: "orders" }
  );
});

test("a fallback self-contained id matches known stream and instance prefixes exactly", () => {
  // MCP fetch passes `document.id` (`stream:key` or `instance/stream:key`) as fallback.id.
  for (const [id, expected] of [
    ["orders:o1", "o1"],
    ["A/orders:o1", "o1"],
    ["orders:x/y:z", "x/y:z"],
    ["plain-key", "plain-key"],
    ["B/orders:o1", "B/orders:o1"],
  ]) {
    const ladder = buildRecordContentLadder(
      { object: "record", stream: "orders", data: { body: "x" } },
      { fallback: { id, connectionId: "A" } }
    );
    assert.equal(ladder?.id, expected, id);
  }
});

test("R3-1: id and result_id agree when a known-stream row has no canonical key", () => {
  assert.throws(
    () =>
      buildRecordContentLadder({
        id: "one",
        result_id: "two",
        instance_id: "A",
        stream: "orders",
        body: "hello",
      }),
    { name: "RecordIdentityConflictError", code: "conflicting_record_id" }
  );
  const consistent = buildRecordContentLadder({
    id: "one",
    result_id: "orders:one",
    instance_id: "A",
    stream: "orders",
    body: "hello",
  });
  assert.equal(consistent?.id, "one");
});

test("R3-2: flat rows omit camel-case instance aliases and result_id from fields", () => {
  const ladder = buildRecordContentLadder({
    id: "k",
    instanceId: "A",
    connectionId: "A",
    result_id: "k",
    stream: "orders",
    body: "hello",
  });
  assert.deepEqual(ladder?.field_windows.map((field) => field.field_path), ["body"]);
});

test("R3-2: nested application aliases and result_id remain readable fields", () => {
  const ladder = buildRecordContentLadder({
    object: "record",
    id: "k",
    instance_id: "A",
    stream: "orders",
    data: { instanceId: "app", connectionId: "app", result_id: "app", body: "hello" },
  });
  assert.deepEqual(ladder?.field_windows.map((field) => field.field_path), ["instanceId", "connectionId", "result_id", "body"]);
});

test("R3-3: fallback stream_name conflicts with a different record stream", () => {
  assert.throws(
    () =>
      buildRecordContentLadder(
        { object: "record", id: "k", instance_id: "A", stream: "orders", data: {} },
        { fallback: { stream_name: "other" } }
      ),
    { name: "RecordIdentityConflictError", code: "conflicting_stream" }
  );
});

for (const [name, resultId] of [
  ["record key", "A/orders:two"],
  ["instance", "B/orders:one"],
  ["stream", "A/messages:one"],
]) {
  test(`legacy self-contained row handles reject conflicting ${name}`, () => {
    assert.throws(
      () => buildRecordContentLadder({ id: "A/orders:one", result_id: resultId, connectionId: "A", body: "hello" }),
      { name: "RecordIdentityConflictError", code: "conflicting_record_id" }
    );
  });
}

test("legacy self-contained row handles accept the same canonical identity", () => {
  for (const resultId of ["A/orders:one", "orders:one", "one"]) {
    const ladder = buildRecordContentLadder({ id: "A/orders:one", result_id: resultId, connectionId: "A", body: "hello" });
    assert.deepEqual(
      { id: ladder?.id, instance_id: ladder?.instance_id, stream: ladder?.stream },
      { id: "one", instance_id: "A", stream: "orders" }
    );
  }
});
