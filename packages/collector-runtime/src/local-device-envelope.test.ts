// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildLocalDeviceIngestBatchRequest,
  buildLocalDeviceRecordEnvelope,
  canonicalJson,
  canonicalTerminalRunCommitEnvelope,
  hashCanonicalJson,
} from "./local-device-envelope.ts";

test("canonicalJson sorts object keys recursively and drops undefined fields", () => {
  assert.equal(
    canonicalJson({
      a: { a: 1, b: 2 },
      list: [{ x: false, y: true }],
      skip: undefined,
      z: 1,
    }),
    '{"a":{"a":1,"b":2},"list":[{"x":false,"y":true}],"z":1}'
  );
});

test("hashCanonicalJson is stable for equivalent object key ordering", () => {
  assert.equal(hashCanonicalJson({ a: 1, b: 2 }), hashCanonicalJson({ a: 1, b: 2 }));
});

test("buildLocalDeviceRecordEnvelope creates deterministic connector RECORD body hash", () => {
  const first = buildLocalDeviceRecordEnvelope({
    batchId: "batch-1",
    batchSeq: 7,
    connectorId: "codex",
    deviceId: "device-1",
    record: {
      data: { a: "first", z: "last" },
      emitted_at: "2026-04-30T12:00:00.000Z",
      key: "42",
      stream: "messages",
      type: "RECORD",
    },
    sourceInstanceId: "source-1",
  });
  const retry = buildLocalDeviceRecordEnvelope({
    batchId: "batch-1",
    batchSeq: 7,
    connectorId: "codex",
    deviceId: "device-1",
    record: {
      data: { a: "first", z: "last" },
      emitted_at: "2026-04-30T12:00:00.000Z",
      key: "42",
      stream: "messages",
      type: "RECORD",
    },
    sourceInstanceId: "source-1",
  });

  assert.equal(first.body_hash, retry.body_hash);
  assert.equal(first.record_key, "42");
  assert.deepEqual(Object.keys(first.data), ["a", "z"]);
});

test("buildLocalDeviceRecordEnvelope encodes a compound key as canonical minified JSON array", () => {
  const envelope = buildLocalDeviceRecordEnvelope({
    batchId: "batch-1",
    batchSeq: 7,
    connectorId: "codex",
    deviceId: "device-1",
    record: {
      data: { date: "2026-04-01", user_id: "user_123" },
      emitted_at: "2026-04-30T12:00:00.000Z",
      key: ["user_123", "2026-04-01"],
      stream: "daily_summaries",
      type: "RECORD",
    },
    sourceInstanceId: "source-1",
  });

  assert.equal(envelope.record_key, '["user_123","2026-04-01"]');
});

test("buildLocalDeviceIngestBatchRequest owns full-envelope hashing and wire projection", () => {
  const envelope = buildLocalDeviceRecordEnvelope({
    batchId: "batch-1",
    batchSeq: 7,
    connectorId: "codex",
    deviceId: "device-1",
    record: {
      data: { id: "message-1", text: "hello" },
      emitted_at: "2026-04-30T12:00:00.000Z",
      key: "message-1",
      stream: "messages",
      type: "RECORD",
    },
    sourceInstanceId: "source-1",
  });
  const request = buildLocalDeviceIngestBatchRequest({
    batchId: envelope.batch_id,
    batchSeq: envelope.batch_seq,
    connectorId: envelope.connector_id,
    deviceId: envelope.device_id,
    records: [envelope],
    sourceInstanceId: envelope.source_instance_id,
  });

  assert.equal(request.body_hash, hashCanonicalJson([envelope]));
  assert.notEqual(request.body_hash, hashCanonicalJson(request.records));
  assert.deepEqual(request.records, [
    {
      data: { id: "message-1", text: "hello" },
      emitted_at: "2026-04-30T12:00:00.000Z",
      record_key: "message-1",
      stream: "messages",
    },
  ]);
});

test("canonicalTerminalRunCommitEnvelope has a stable cross-runtime golden hash matching pdpp's @pdpp/reference-contract oracle", () => {
  const canonical = canonicalTerminalRunCommitEnvelope({
    collection_boundary: "unscoped",
    commit_id: "commit-1",
    connector_id: "codex",
    connector_instance_id: "cin-1",
    device_id: "dev-1",
    run_id: "run-1",
    source_instance_id: "src-1",
    state_delta: { z: { cursor: 2 }, a: { cursor: 1 } },
    terminal_facts: [
      { coverage_statuses: ["missing", "collected", "missing"], stream: "z" },
      { coverage_statuses: ["collected"], scoped: false, stream: "a" },
    ],
    version: 1,
  });
  const json = JSON.stringify(canonical);
  assert.equal(
    json,
    '{"collection_boundary":"unscoped","commit_id":"commit-1","connector_id":"codex","connector_instance_id":"cin-1","device_id":"dev-1","run_id":"run-1","source_instance_id":"src-1","state_delta":{"a":{"cursor":1},"z":{"cursor":2}},"terminal_facts":[{"coverage_statuses":["collected"],"scoped":false,"stream":"a"},{"coverage_statuses":["collected","missing"],"stream":"z"}],"version":1}'
  );
  assert.equal(hashCanonicalJson(canonical), "147b0baeb81e66a5dfb3f0862596d50aeb87fe8a6723306740e9446dddb72648");
});
