// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { buildRecordContentLadder } from "../src/index.ts";

test("buildRecordContentLadder preserves fallback identity for projected records", () => {
  const ladder = buildRecordContentLadder(
    {
      data: {
        body: "hello world",
      },
    },
    {
      fallback: {
        stream: "messages",
        recordId: "m1",
        connectionId: "cin_a",
      },
    }
  );

  assert.equal(ladder.id, "m1");
  assert.equal(ladder.instance_id, "cin_a");
  assert.equal(ladder.stream, "messages");
  assert.deepEqual(ladder.field_windows[0].read.args, {
    id: "m1",
    instance_id: "cin_a",
    stream: "messages",
    field_path: "body",
    offset_chars: 0,
    limit_chars: 2048,
  });
});

test("buildRecordContentLadder preserves the canonical key from an MCP SearchResult", () => {
  const ladder = buildRecordContentLadder(
    {
      id: "cin_a/messages:m1",
      title: "t",
      url: "pdpp://record/x",
      stream: "messages",
      record_key: "m1",
      connection_id: "cin_a",
      snippet: "hello",
    },
    { fallback: { stream: "messages", recordId: "m1", connectionId: "cin_a" } }
  );

  assert.equal(ladder.id, "m1");
  assert.equal(ladder.instance_id, "cin_a");
  assert.equal(ladder.stream, "messages");

  assert.throws(
    () =>
      buildRecordContentLadder(
        { id: "cin_a/messages:m1", stream: "messages", record_key: "m1", connection_id: "cin_a" },
        { fallback: { stream: "messages", recordId: "different", connectionId: "cin_a" } }
      ),
    { name: "RecordIdentityConflictError", code: "conflicting_record_id" }
  );
});

test("fallback instance_id remains accepted alongside the legacy connectionId alias", () => {
  const ladder = buildRecordContentLadder(
    { data: { body: "hello" } },
    { fallback: { stream: "messages", recordId: "m1", instance_id: "inst-new" } }
  );

  assert.equal(ladder.id, "m1");
  assert.equal(ladder.instance_id, "inst-new");
  assert.throws(
    () =>
      buildRecordContentLadder(
        { data: { body: "hello" } },
        { fallback: { stream: "messages", recordId: "m1", instance_id: "inst-new", connectionId: "old" } }
      ),
    { name: "RecordIdentityConflictError", code: "conflicting_instance_id" }
  );
});
