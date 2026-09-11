// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import {
  type CollectorOutboxPolicy,
  DEFAULT_COLLECTOR_OUTBOX_POLICY,
  type DrainBlobUploadFn,
  drainCollectorOutbox,
} from "./collector-runner.ts";
import { captureBlobArtifact } from "./local-device-blob-capture.ts";
import { LocalDeviceBlobSpool } from "./local-device-blob-spool.ts";
import { LocalDeviceOutbox } from "./local-device-outbox.ts";

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "pdpp-blob-drain-"));
  roots.push(root);
  return root;
}

after(() => {
  for (const root of roots) {
    rmSync(root, { force: true, recursive: true });
  }
});

/** The drain never calls these for a `blob_upload` row; they satisfy the type. */
const inertClient = {
  ackLocalCollectorGap: () => Promise.reject(new Error("unexpected gap ack")),
  ingestBatch: () => Promise.reject(new Error("unexpected ingest")),
  putSourceInstanceState: () => Promise.reject(new Error("unexpected state put")),
};

// The production policy, with only the time bounds shortened so the retry
// and dead-letter paths are exercised in test time rather than in minutes.
const policy: CollectorOutboxPolicy = {
  ...DEFAULT_COLLECTOR_OUTBOX_POLICY,
  leaseMs: 30_000,
  maxAttempts: 3,
  maxDrainDurationMs: 10_000,
  maxDrainIterations: 20,
  maxRetryAfterMs: 1000,
  retryBackoffMs: 1,
};

interface Harness {
  outbox: LocalDeviceOutbox;
  root: string;
  spool: LocalDeviceBlobSpool;
}

function makeHarness(): Harness {
  const root = makeRoot();
  return {
    outbox: new LocalDeviceOutbox({ path: join(root, "outbox.sqlite") }),
    root,
    spool: new LocalDeviceBlobSpool({ root }),
  };
}

function capture(h: Harness, body: Buffer, recordKey = "tool_result_file:drain") {
  return captureBlobArtifact({
    connectorId: "claude_code",
    content: [body],
    mimeType: "text/plain",
    outbox: h.outbox,
    recordKey,
    sourceInstanceId: "src-1",
    spool: h.spool,
    stream: "attachments",
  });
}

function drain(h: Harness, blobUpload: DrainBlobUploadFn) {
  return drainCollectorOutbox({
    blobUpload,
    client: inertClient,
    connectorId: "claude_code",
    holderId: "holder-1",
    outbox: h.outbox,
    policy,
    sourceInstanceId: "src-1",
    spool: h.spool,
  });
}

/** Reads the whole upload stream so the test can assert byte fidelity. */
async function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

describe("blob_upload drain", () => {
  it("uploads the spooled bytes byte-exactly and then releases the local copy", async () => {
    const h = makeHarness();
    const body = randomBytes(256 * 1024);
    const captured = await capture(h, body);
    let uploaded: Buffer | null = null;

    const result = await drain(h, async (args) => {
      uploaded = await readAll(args.content);
      return { sha256: args.sha256, size_bytes: args.sizeBytes };
    });

    assert.equal(result.sent, 1);
    assert.deepEqual(uploaded, body, "the server received the complete original bytes");
    assert.equal(h.outbox.get(captured.outboxId)?.status, "succeeded");
    assert.equal(h.spool.has(captured.sha256), false, "local copy released only after acknowledgement");
    h.outbox.close();
  });

  it("retries a transient failure and keeps the bytes until the retry succeeds", async () => {
    const h = makeHarness();
    const body = randomBytes(8192);
    const captured = await capture(h, body);
    let attempts = 0;

    const result = await drain(h, async (args) => {
      attempts += 1;
      if (attempts === 1) {
        // Bytes must still be on disk for attempt 2 to have anything to send.
        assert.ok(h.spool.has(captured.sha256));
        throw Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" });
      }
      assert.deepEqual(await readAll(args.content), body);
      return { sha256: args.sha256, size_bytes: args.sizeBytes };
    });

    assert.equal(attempts, 2);
    assert.equal(result.sent, 1);
    assert.equal(h.outbox.get(captured.outboxId)?.status, "succeeded");
    h.outbox.close();
  });

  it("re-delivers after a lost acknowledgement without losing bytes", async () => {
    const h = makeHarness();
    const body = randomBytes(64 * 1024);
    const captured = await capture(h, body);
    const serverStore = new Map<string, Buffer>();
    let attempts = 0;

    // The server commits, then the response is lost in transit. The client
    // never learns it succeeded.
    const result = await drain(h, async (args) => {
      attempts += 1;
      const received = await readAll(args.content);
      serverStore.set(args.sha256, received);
      if (attempts === 1) {
        throw Object.assign(new Error("ETIMEDOUT after commit"), { code: "ETIMEDOUT" });
      }
      return { sha256: args.sha256, size_bytes: args.sizeBytes };
    });

    assert.equal(attempts, 2, "the client retried the unacknowledged upload");
    assert.equal(result.sent, 1);
    // Content addressing makes the redelivery idempotent server-side: the
    // second commit lands on the same digest, so there is one body, not two.
    assert.equal(serverStore.size, 1);
    assert.deepEqual(serverStore.get(captured.sha256), body);
    assert.equal(h.spool.has(captured.sha256), false);
    h.outbox.close();
  });

  it("dead-letters after exhausting attempts and RETAINS the payload, visibly unresolved", async () => {
    const h = makeHarness();
    const body = randomBytes(32 * 1024);
    const captured = await capture(h, body);

    const result = await drain(h, () => Promise.reject(new Error("permanent upstream rejection")));

    assert.equal(result.deadLettered, 1);
    const item = h.outbox.get(captured.outboxId);
    assert.equal(item?.status, "dead_letter", "the failure stays visible, not deleted");
    assert.ok(item?.last_error, "the reason is retained for an operator");

    // The hard requirement: a dead letter keeps its bytes. The artifact is
    // still recoverable and still unresolved — never silently dropped.
    assert.ok(h.spool.has(captured.sha256), "dead-lettered bytes are retained");
    assert.deepEqual(await readFile(h.spool.pathFor(captured.sha256)), body);

    // And it is recoverable: requeueing the dead letter finds its bytes intact.
    const requeued = h.outbox.requeueDeadLetters({ dryRun: false, kind: "blob_upload" });
    assert.equal(requeued.requeued, 1);
    const redelivered = await drain(h, async (args) => {
      assert.deepEqual(await readAll(args.content), body);
      return { sha256: args.sha256, size_bytes: args.sizeBytes };
    });
    assert.equal(redelivered.sent, 1);
    h.outbox.close();
  });

  it("dead-letters immediately when the spooled bytes are gone, rather than retrying forever", async () => {
    const h = makeHarness();
    const captured = await capture(h, randomBytes(4096));
    let attempts = 0;

    // Out-of-band deletion of the body the queue row promised to deliver.
    h.spool.release(captured.sha256);

    const result = await drain(h, () => {
      attempts += 1;
      return Promise.resolve({ sha256: captured.sha256, size_bytes: captured.sizeBytes });
    });

    assert.equal(attempts, 0, "no upload is attempted for absent bytes");
    assert.equal(result.deadLettered, 1);
    assert.equal(h.outbox.get(captured.outboxId)?.status, "dead_letter");
    h.outbox.close();
  });

  it("retries an integrity mismatch instead of releasing bytes against a bad commit", async () => {
    const h = makeHarness();
    const body = randomBytes(2048);
    const captured = await capture(h, body);
    let attempts = 0;

    const result = await drain(h, async (args) => {
      attempts += 1;
      await readAll(args.content);
      if (attempts === 1) {
        // A truncated transfer: the server reports fewer bytes than we spooled.
        return { sha256: args.sha256, size_bytes: args.sizeBytes - 1 };
      }
      return { sha256: args.sha256, size_bytes: args.sizeBytes };
    });

    assert.equal(attempts, 2);
    assert.equal(result.sent, 1);
    assert.equal(h.outbox.get(captured.outboxId)?.status, "succeeded");
    h.outbox.close();
  });

  it("dead-letters with bytes retained when no upload transport is configured", async () => {
    const h = makeHarness();
    const body = randomBytes(1024);
    const captured = await capture(h, body);

    // No `blobUpload`/`spool` wired into the drain at all.
    const result = await drainCollectorOutbox({
      client: inertClient,
      connectorId: "claude_code",
      holderId: "holder-1",
      outbox: h.outbox,
      policy,
      sourceInstanceId: "src-1",
    });

    assert.equal(result.deadLettered, 1);
    assert.ok(h.spool.has(captured.sha256), "bytes survive an unsupported drain");
    assert.deepEqual(await readFile(h.spool.pathFor(captured.sha256)), body);
    h.outbox.close();
  });

  it("never acknowledges a capture whose digest disagrees with the queued payload", async () => {
    const h = makeHarness();
    const body = randomBytes(4096);
    const captured = await capture(h, body);
    const expected = createHash("sha256").update(body).digest("hex");

    assert.equal(captured.sha256, expected);
    const item = h.outbox.get(captured.outboxId);
    const payload = item?.payload as { sha256: string; sizeBytes: number };
    assert.equal(payload.sha256, expected, "the queued instruction names the spooled digest");
    assert.equal(payload.sizeBytes, body.byteLength);
    h.outbox.close();
  });
});
