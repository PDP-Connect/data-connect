// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { withTokenKindRecordShape } from "../server/record-wire-shape.ts";

const live = {
  data: { id: "repo-1", name: "one" },
  emitted_at: "2026-01-01T00:00:00Z",
  id: "repo-1",
  key: "repo-1",
  object: "record",
  stream: "repositories",
};

const tombstone = {
  deleted: true,
  deleted_at: "2026-02-01T00:00:00Z",
  emitted_at: "2026-02-01T00:00:00Z",
  id: "repo-1",
  instance_id: "instance-a",
  object: "record",
  stream: "repositories",
};

test("owner-token bodies pass through unchanged", () => {
  const body = { data: [live, tombstone], has_more: false, object: "list" };
  assert.equal(withTokenKindRecordShape(body, { pdpp_token_kind: "owner" }), body);
});

test("client-token record loses emitted_at and keeps the rest", () => {
  assert.deepEqual(withTokenKindRecordShape(live, { pdpp_token_kind: "client" }), {
    data: { id: "repo-1", name: "one" },
    id: "repo-1",
    key: "repo-1",
    object: "record",
    stream: "repositories",
  });
});

test("client tombstone is exactly the client shape and keeps instance_id", () => {
  assert.deepEqual(withTokenKindRecordShape(tombstone, { pdpp_token_kind: "client" }), {
    deleted: true,
    id: "repo-1",
    instance_id: "instance-a",
    object: "record",
    stream: "repositories",
  });
});

test("tombstone connection_id and display_name are stripped for client and kept for owner", () => {
  const withBinding = { ...tombstone, connection_id: "conn-1", connector_instance_id: "ci-1", display_name: "GitHub" };
  assert.deepEqual(withTokenKindRecordShape(withBinding, { pdpp_token_kind: "client" }), {
    deleted: true,
    id: "repo-1",
    instance_id: "instance-a",
    object: "record",
    stream: "repositories",
  });
  assert.equal(withTokenKindRecordShape(withBinding, { pdpp_token_kind: "owner" }), withBinding);
});

test("mcp_package tokens get the same non-owner shape as client tokens", () => {
  assert.deepEqual(withTokenKindRecordShape(tombstone, { pdpp_token_kind: "mcp_package" }), {
    deleted: true,
    id: "repo-1",
    instance_id: "instance-a",
    object: "record",
    stream: "repositories",
  });
});

test("list envelopes keep their own fields and map each record", () => {
  const shaped = withTokenKindRecordShape(
    { data: [live, tombstone], has_more: false, next_changes_since: "cursor-1", object: "list" },
    { pdpp_token_kind: "client" }
  ) as { data: Record<string, unknown>[]; has_more: boolean; next_changes_since: string; object: string };
  assert.equal(shaped.object, "list");
  assert.equal(shaped.has_more, false);
  assert.equal(shaped.next_changes_since, "cursor-1");
  assert.equal("emitted_at" in (shaped.data[0] ?? {}), false);
  assert.deepEqual(shaped.data[1], {
    deleted: true,
    id: "repo-1",
    instance_id: "instance-a",
    object: "record",
    stream: "repositories",
  });
});

test("client record whose application data is an array loses only emitted_at", () => {
  const nested = { emitted_at: "x", object: "record" };
  assert.deepEqual(withTokenKindRecordShape({ ...live, data: [nested] }, { pdpp_token_kind: "client" }), {
    data: [{ emitted_at: "x", object: "record" }],
    id: "repo-1",
    key: "repo-1",
    object: "record",
    stream: "repositories",
  });
});

test("client tombstone with array data keeps the exact tombstone shape", () => {
  assert.deepEqual(
    withTokenKindRecordShape(
      { ...tombstone, data: [{ emitted_at: "x", object: "record" }] },
      { pdpp_token_kind: "client" }
    ),
    {
      deleted: true,
      id: "repo-1",
      instance_id: "instance-a",
      object: "record",
      stream: "repositories",
    }
  );
});

test("owner-token record with array data passes through unchanged", () => {
  const body = { ...live, data: [{ emitted_at: "x", object: "record" }] };
  assert.equal(withTokenKindRecordShape(body, { pdpp_token_kind: "owner" }), body);
});

test("non-record objects and non-object bodies pass through", () => {
  const error = { emitted_at: "2026-02-01T00:00:00Z", error: "not_found", object: "error" };
  assert.deepEqual(withTokenKindRecordShape(error, { pdpp_token_kind: "client" }), error);
  assert.equal(withTokenKindRecordShape(null, { pdpp_token_kind: "client" }), null);
  assert.equal(withTokenKindRecordShape("text", { pdpp_token_kind: "client" }), "text");
});
