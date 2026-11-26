// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  type CaptureBlobArtifactInput,
  captureBlobArtifact,
  isBlobUploadPayload,
} from "./local-device-blob-capture.ts";
import { hashCanonicalJson } from "./local-device-envelope.ts";
import { LocalDeviceOutbox } from "./local-device-outbox.ts";

const body = Buffer.from("synthetic artifact");
const content = [body];
const sha256 = createHash("sha256").update(body).digest("hex");
const sourceInstanceId = "  test-source  ";
const originalPayload = {
  connectorId: "test-connector",
  connectorInstanceId: null,
  jsonPath: "/attachment/~0/~1",
  mimeType: "application/octet-stream",
  recordKey: "test-record",
  sha256,
  sizeBytes: body.byteLength,
  sourceInstanceId,
  stream: "test-stream",
};

type CaptureSpool = CaptureBlobArtifactInput["spool"];

function fixture(outbox: LocalDeviceOutbox): CaptureBlobArtifactInput {
  const spool = {
    put(received) {
      assert.equal(received, content);
      return Promise.resolve({ sha256, sizeBytes: body.byteLength } as Awaited<ReturnType<CaptureSpool["put"]>>);
    },
  } satisfies Pick<CaptureSpool, "put">;
  return { ...originalPayload, content, outbox, spool: spool as unknown as CaptureSpool };
}

test("capture replays exact source bytes as one unchanged durable upload row", async (t) => {
  const outbox = new LocalDeviceOutbox({ path: ":memory:" });
  t.after(() => outbox.close());
  const input = fixture(outbox);

  const first = await captureBlobArtifact(input);
  const original = outbox.list();
  const again = await captureBlobArtifact(input);

  assert.deepEqual(again, first);
  assert.equal(first.sha256, sha256);
  assert.equal(first.sizeBytes, body.byteLength);
  assert.equal(original.length, 1);
  const row = outbox.get(first.outboxId);
  assert.ok(row);
  assert.equal(row.id, first.outboxId);
  assert.equal(row.kind, "blob_upload");
  assert.equal(row.source_instance_id, sourceInstanceId);
  assert.equal(row.status, "ready");
  assert.deepEqual(row.payload, originalPayload);
  assert.equal(row.body_hash, hashCanonicalJson(originalPayload));
  assert.notEqual(row.body_hash, sha256);
  assert.deepEqual(outbox.list(), original);
});

test("same digest with contradictory size or MIME cannot mutate the existing row", async (t) => {
  const outbox = new LocalDeviceOutbox({ path: ":memory:" });
  t.after(() => outbox.close());
  const input = fixture(outbox);
  const first = await captureBlobArtifact(input);
  const original = outbox.list();
  assert.equal(original.length, 1);
  assert.equal(original[0]?.id, first.outboxId);

  const contradictorySpool = {
    put() {
      return Promise.resolve({ sha256, sizeBytes: body.byteLength + 1 } as Awaited<ReturnType<CaptureSpool["put"]>>);
    },
  } satisfies Pick<CaptureSpool, "put">;
  for (const contradictory of [
    { ...input, spool: contradictorySpool as unknown as CaptureSpool },
    { ...input, mimeType: "text/plain" },
  ]) {
    // biome-ignore lint/performance/noAwaitInLoops: each case inspects the shared outbox after its own rejection.
    await assert.rejects(captureBlobArtifact(contradictory), /local outbox id collision with different payload/);
    assert.deepEqual(outbox.list(), original);
  }
});

test("a rejected spool write never queues an upload", async (t) => {
  const outbox = new LocalDeviceOutbox({ path: ":memory:" });
  t.after(() => outbox.close());
  const spool = {
    put() {
      return Promise.reject(new Error("synthetic spool failure"));
    },
  } satisfies Pick<CaptureSpool, "put">;
  await assert.rejects(
    captureBlobArtifact({ ...fixture(outbox), spool: spool as unknown as CaptureSpool }),
    /synthetic spool failure/
  );
  assert.deepEqual(outbox.list(), []);
});

test("blob upload guard accepts nullable instance, optional pointer and zero bytes", () => {
  const { jsonPath: _jsonPath, ...withoutPointer } = originalPayload;
  assert.ok(isBlobUploadPayload(withoutPointer));
  assert.ok(isBlobUploadPayload(originalPayload));
  assert.ok(isBlobUploadPayload({ ...originalPayload, connectorInstanceId: "instance-1", jsonPath: "", sizeBytes: 0 }));
});

test("capture rejects a legacy field path before spooling or queue admission", async (t) => {
  const outbox = new LocalDeviceOutbox({ path: ":memory:" });
  t.after(() => outbox.close());
  const input = fixture(outbox);
  const spoolWrites = t.mock.method(input.spool, "put");

  await assert.rejects(captureBlobArtifact({ ...input, jsonPath: "legacy.field" }), /RFC 6901 JSON pointer/);
  assert.equal(spoolWrites.mock.callCount(), 0);
  assert.deepEqual(outbox.list(), []);
});

test("blob upload guard rejects malformed digest, byte count, instance or pointer", () => {
  for (const invalid of [
    { sha256: sha256.slice(1) },
    { sha256: "g".repeat(64) },
    { sha256: `${sha256.slice(1)}\n` },
    { sizeBytes: -1 },
    { sizeBytes: 1.5 },
    { sizeBytes: Number.POSITIVE_INFINITY },
    { sizeBytes: Number.MAX_SAFE_INTEGER + 1 },
    { connectorInstanceId: undefined },
    { connectorInstanceId: 7 },
    { jsonPath: null },
    { jsonPath: "attachment" },
    { jsonPath: "/invalid/~2" },
  ]) {
    assert.equal(isBlobUploadPayload({ ...originalPayload, ...invalid }), false);
  }
});
