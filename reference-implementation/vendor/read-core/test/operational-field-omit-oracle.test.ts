// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { buildRecordContentLadder } from "../src/index.ts";

test("buildRecordContentLadder preserves application fields named like legacy selectors", () => {
  const ladder = buildRecordContentLadder({
    id: "cin_a/messages:m1",
    data: {
      connection_id: "cin_a",
      stream: "messages",
      id: "m1",
      metadata: { x: 1 },
      body: "hello",
    },
  });

  assert.deepEqual(
    ladder.field_windows.map((field) => field.field_path),
    ["connection_id", "body"]
  );

  assert.ok(!(ladder.json_fields ?? []).some((field) => field.field_path === "metadata"));
});

test("flat envelopes do not expose operational identity fields as readable data", () => {
  const ladder = buildRecordContentLadder({
    object: "record",
    record_id: "k",
    instance_id: "A",
    stream: "messages",
    connection_id: "A",
    connector_instance_id: "A",
    object_type: "record",
    deleted: false,
    emitted_at: "2026-10-14T00:00:00Z",
    title: "hello",
  });

  assert.deepEqual(ladder.field_windows.map((field) => field.field_path), ["title"]);
});

test("tombstones carry identity but expose no field or JSON read capabilities", () => {
  const ladder = buildRecordContentLadder({
    object: "record",
    id: "k",
    instance_id: "A",
    stream: "messages",
    deleted: true,
    body: "removed",
    metadata: { reason: "removed" },
  });

  assert.deepEqual(ladder.field_windows, []);
  assert.equal(ladder.json_fields, undefined);
});

test("connector_instance_id envelope alias is identity-bearing and conflict checked", () => {
  const ladder = buildRecordContentLadder({
    object: "record",
    id: "k",
    connector_instance_id: "A",
    stream: "messages",
    data: { body: "x" },
  });
  assert.equal(ladder.instance_id, "A");

  assert.throws(
    () =>
      buildRecordContentLadder({
        object: "record",
        id: "k",
        instance_id: "A",
        connector_instance_id: "B",
        stream: "messages",
        data: { body: "x" },
      }),
    { name: "RecordIdentityConflictError", code: "conflicting_instance_id" }
  );
});
