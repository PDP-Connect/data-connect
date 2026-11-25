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
    state_delta: { a: { cursor: 1 }, z: { cursor: 2 } },
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

test("terminal fixture requires a source identity before canonicalization", () => {
  const input = {
    collection_boundary: "unscoped",
    commit_id: "commit-fixture",
    connector_id: "connector-fixture",
    connector_instance_id: "instance-fixture",
    device_id: "device-fixture",
    run_id: "run-fixture",
    state_delta: {},
    terminal_facts: [],
    version: 1,
  } as const;
  for (const invalid of ["", 7]) {
    assert.throws(() => canonicalTerminalRunCommitEnvelope({
      ...input, source_instance_id: invalid as string,
    }), /sourceInstanceId must be a non-blank string/);
  }
});

const envelopeFixture = {
  batchId: "fixture-batch",
  batchSeq: 1,
  connectorId: "fixture-connector",
  deviceId: "fixture-device",
  record: {
    data: { id: "fixture-record" },
    emitted_at: "2026-04-30T12:00:00.000Z",
    key: "fixture-record",
    stream: "fixture-stream",
    type: "RECORD" as const,
  },
};
const fixtureSource = "fixture-source";

test("local-device builders require a nonblank source instance identity", () => {
  const envelope = buildLocalDeviceRecordEnvelope({ ...envelopeFixture, sourceInstanceId: fixtureSource });
  const batchFixture = { ...envelopeFixture, records: [envelope] };
  for (const candidate of [{}, { sourceInstanceId: "" }, { sourceInstanceId: " \t " }, { sourceInstanceId: 42 }]) {
    assert.throws(
      () =>
        buildLocalDeviceRecordEnvelope({ ...envelopeFixture, ...candidate } as Parameters<
          typeof buildLocalDeviceRecordEnvelope
        >[0]),
      /sourceInstanceId must be a non-blank string/
    );
    assert.throws(
      () =>
        buildLocalDeviceIngestBatchRequest({ ...batchFixture, ...candidate } as Parameters<
          typeof buildLocalDeviceIngestBatchRequest
        >[0]),
      /sourceInstanceId must be a non-blank string/
    );
  }
});

test("local-device batch identity agrees with every envelope", () => {
  const first = buildLocalDeviceRecordEnvelope({ ...envelopeFixture, sourceInstanceId: fixtureSource });
  const batch = { ...envelopeFixture, records: [first], sourceInstanceId: fixtureSource };
  const valid = buildLocalDeviceIngestBatchRequest(batch);
  assert.equal(valid.source_instance_id, fixtureSource);
  assert.equal(valid.batch_id, envelopeFixture.batchId);
  assert.equal(valid.batch_seq, envelopeFixture.batchSeq);
  assert.equal(valid.connector_id, envelopeFixture.connectorId);
  assert.equal(valid.device_id, envelopeFixture.deviceId);
  for (const mismatch of [{ batchId: "different-batch" }, { batchSeq: 2 }]) {
    assert.throws(() => buildLocalDeviceIngestBatchRequest({ ...batch, ...mismatch }),
      /batch (batchId|batchSeq) must match every record envelope/);
  }
  assert.equal(valid.body_hash, hashCanonicalJson([first]));
  assert.throws(
    () =>
      buildLocalDeviceIngestBatchRequest({
        ...batch,
        records: [first, { ...first, source_instance_id: "fixture-other-source" }],
      }),
    /batch sourceInstanceId must match every record envelope/
  );
});

test("local-device builders keep a valid source identity byte-for-byte, including surrounding spaces", () => {
  const spaced = " fixture-source ";
  const envelope = buildLocalDeviceRecordEnvelope({ ...envelopeFixture, sourceInstanceId: spaced });
  const plain = buildLocalDeviceRecordEnvelope({ ...envelopeFixture, sourceInstanceId: fixtureSource });
  assert.deepEqual(envelope, { ...plain, source_instance_id: spaced });
  const batch = buildLocalDeviceIngestBatchRequest({
    ...envelopeFixture,
    records: [envelope],
    sourceInstanceId: spaced,
  });
  assert.equal(batch.source_instance_id, spaced);
  assert.equal(batch.body_hash, hashCanonicalJson([{ ...plain, source_instance_id: spaced }]));
});
