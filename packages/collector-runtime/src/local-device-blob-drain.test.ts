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

/**
 * Drains with reclamation's capture-race grace period disabled.
 *
 * Production keeps a long `minAgeMs` so a body written but not yet enqueued is
 * never eligible. A test that wants to observe reclamation at all must waive
 * that wait, so `spoolReclaimMinAgeMs: 0` is the harness default here; the
 * grace period itself is covered by its own test below.
 */
function drain(h: Harness, blobUpload: DrainBlobUploadFn, spoolReclaimMinAgeMs = 0) {
  return drainCollectorOutbox({
    blobUpload,
    client: inertClient,
    connectorId: "claude_code",
    holderId: "holder-1",
    outbox: h.outbox,
    policy,
    sourceInstanceId: "src-1",
    spool: h.spool,
    spoolReclaimMinAgeMs,
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
  it("uploads the spooled bytes byte-exactly and reclaims the local copy after acknowledgement", async () => {
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
    assert.equal(
      h.spool.has(captured.sha256),
      false,
      "reclaimed only once the row is durably succeeded and nothing else owes the body"
    );
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

    // Out-of-band deletion of the body the queue row promised to deliver — the
    // spool no longer deletes bodies itself, so this models external loss
    // (operator cleanup, disk repair) rather than anything the runtime does.
    rmSync(h.spool.pathFor(captured.sha256), { force: true });

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

/**
 * Reclamation must not destroy bytes another obligation still owes, and must
 * not run ahead of the durable record that an obligation was met.
 *
 * Both of these were live defects while the send path deleted the body itself:
 * a shared body was destroyed by the first successful upload, and the delete
 * ran before `acknowledge()` committed. They are separate failures with
 * separate triggers, so they get separate tests.
 */
describe("blob spool reclamation", () => {
  it("delivers BOTH records when two record coordinates share one body", async () => {
    const h = makeHarness();
    const body = randomBytes(16 * 1024);

    // Same bytes, different records: content addressing gives them ONE on-disk
    // body and the outbox TWO rows. The body is owed twice.
    const first = await capture(h, body, "tool_result_file:record-A");
    const second = await capture(h, body, "tool_result_file:record-B");
    assert.equal(first.sha256, second.sha256, "identical content shares one digest-addressed body");
    assert.notEqual(first.outboxId, second.outboxId, "different coordinates are distinct obligations");

    const deliveredKeys: string[] = [];
    const result = await drain(h, async (args) => {
      // Each delivery must see the complete original bytes, including the
      // second one — which is exactly what an early delete destroyed.
      assert.deepEqual(await readAll(args.content), body);
      deliveredKeys.push(args.recordKey);
      return { sha256: args.sha256, size_bytes: args.sizeBytes };
    });

    assert.deepEqual(
      [...deliveredKeys].sort((a, b) => a.localeCompare(b)),
      ["tool_result_file:record-A", "tool_result_file:record-B"]
    );
    assert.equal(result.sent, 2);
    assert.equal(result.deadLettered, 0, "no obligation is dead-lettered for missing bytes");
    assert.equal(h.outbox.get(first.outboxId)?.status, "succeeded");
    assert.equal(h.outbox.get(second.outboxId)?.status, "succeeded");
    h.outbox.close();
  });

  it("keeps the shared body while any co-referencing row is still undelivered", async () => {
    const h = makeHarness();
    const body = randomBytes(8192);
    const first = await capture(h, body, "tool_result_file:record-A");
    const second = await capture(h, body, "tool_result_file:record-B");

    // Deliver only the first obligation; the second stays permanently failing
    // so it remains a live claim on the shared body.
    let uploads = 0;
    await drain(h, (args) => {
      uploads += 1;
      return args.recordKey === "tool_result_file:record-A"
        ? Promise.resolve({ sha256: args.sha256, size_bytes: args.sizeBytes })
        : Promise.reject(Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" }));
    });

    assert.ok(uploads >= 2);
    assert.equal(h.outbox.get(first.outboxId)?.status, "succeeded");
    assert.notEqual(h.outbox.get(second.outboxId)?.status, "succeeded");
    // The whole point: one obligation being met does not release bytes the
    // other still needs, even with the grace period waived.
    assert.ok(h.spool.has(first.sha256), "shared body retained for the outstanding row");
    assert.deepEqual(await readFile(h.spool.pathFor(first.sha256)), body);

    // And once the straggler succeeds, the body becomes reclaimable. It has
    // exhausted its attempts by now, so return it to `ready` the way an
    // operator would before letting it complete.
    h.outbox.requeueDeadLetters({ dryRun: false, kind: "blob_upload" });
    const finish = await drain(h, async (args) => {
      assert.deepEqual(await readAll(args.content), body);
      return { sha256: args.sha256, size_bytes: args.sizeBytes };
    });
    assert.equal(finish.sent, 1);
    assert.equal(h.spool.has(first.sha256), false, "reclaimed once the last obligation is acknowledged");
    h.outbox.close();
  });

  it("leaves a pending row its body when execution stops before local acknowledgement", async () => {
    const h = makeHarness();
    const body = randomBytes(8192);
    const captured = await capture(h, body, "tool_result_file:record-A");

    // Stop the process exactly at the acknowledgement boundary: the upload has
    // succeeded and the send call has returned, but the durable row has not yet
    // been marked `succeeded`. A delete inside the send path made this state
    // bodiless; reclamation from committed queue state cannot.
    const realAcknowledge = h.outbox.acknowledge.bind(h.outbox);
    let reachedBoundary = false;
    h.outbox.acknowledge = () => {
      reachedBoundary = true;
      throw new Error("simulated stop at the acknowledgement boundary");
    };
    await drain(h, async (args) => {
      await readAll(args.content);
      return { sha256: args.sha256, size_bytes: args.sizeBytes };
    }).catch(() => {
      // The stop may surface as a drain failure; the durable state is asserted below.
    });
    h.outbox.acknowledge = realAcknowledge;

    assert.ok(reachedBoundary, "the probe actually reached the acknowledgement boundary");
    const row = h.outbox.get(captured.outboxId);
    assert.notEqual(row?.status, "succeeded", "the obligation was never durably acknowledged");
    assert.ok(h.spool.has(captured.sha256), "a row that is still owed keeps its body");
    assert.deepEqual(await readFile(h.spool.pathFor(captured.sha256)), body);

    // Recoverable through the ordinary path, not merely byte-preserved.
    h.outbox.requeueDeadLetters({ dryRun: false, kind: "blob_upload" });
    const replayed = await drain(h, async (args) => {
      assert.deepEqual(await readAll(args.content), body);
      return { sha256: args.sha256, size_bytes: args.sizeBytes };
    });
    assert.equal(replayed.sent, 1, "the interrupted upload completes on the next drain");
    h.outbox.close();
  });

  it("retains a body younger than the grace period even with no reference at all", async () => {
    const h = makeHarness();
    const body = randomBytes(4096);

    // A body committed by `put` before its row is enqueued is unreferenced but
    // live. Reclamation must not consider it, or concurrent capture loses bytes.
    const entry = await h.spool.put([body]);
    assert.equal(h.outbox.outstandingBlobDigests().size, 0, "nothing references it yet");

    await drainCollectorOutbox({
      blobUpload: () => Promise.reject(new Error("no work expected")),
      client: inertClient,
      connectorId: "claude_code",
      holderId: "holder-1",
      outbox: h.outbox,
      policy,
      sourceInstanceId: "src-1",
      spool: h.spool,
      // Production default: a body written moments ago is ineligible.
      spoolReclaimMinAgeMs: 60 * 60_000,
    });

    assert.ok(h.spool.has(entry.sha256), "mid-capture bytes survive the sweep");
    assert.deepEqual(await readFile(h.spool.pathFor(entry.sha256)), body);
    h.outbox.close();
  });

  it("retains a dead-lettered upload's bytes across repeated sweeps", async () => {
    const h = makeHarness();
    const body = randomBytes(4096);
    const captured = await capture(h, body, "tool_result_file:record-A");

    await drain(h, () => Promise.reject(new Error("permanent upstream rejection")));
    assert.equal(h.outbox.get(captured.outboxId)?.status, "dead_letter");

    // A dead letter is an UNMET obligation, so its bytes stay claimed. Sweeping
    // repeatedly must not erode that. Each sweep observes the state the previous
    // one left, so these run in sequence rather than concurrently.
    const stillRejecting = () => Promise.reject(new Error("still rejecting"));
    await drain(h, stillRejecting);
    assert.ok(h.spool.has(captured.sha256), "retained after sweep 1");
    await drain(h, stillRejecting);
    assert.ok(h.spool.has(captured.sha256), "retained after sweep 2");
    await drain(h, stillRejecting);
    assert.ok(h.spool.has(captured.sha256), "retained after sweep 3");
    assert.deepEqual(await readFile(h.spool.pathFor(captured.sha256)), body);
    h.outbox.close();
  });
});

/**
 * What the queue reports while blob bytes are still owed.
 *
 * This is a CHARACTERISATION test, not an aspiration: it pins today's honest
 * answer so the gap is documented and any change to it is deliberate. The
 * checkpoint predecessor gate considers only `record_batch` and `gap`
 * (`hasCheckpointPredecessorBlockingWork`), so an undelivered `blob_upload`
 * does not hold back a checkpoint or terminal commit. That separation is
 * defensible — local capture and remote delivery are different obligations, and
 * a checkpoint records how far the SOURCE was read, not what has been uploaded.
 *
 * What is NOT defensible is calling the result complete. Outstanding blob work
 * is visible only as an undifferentiated status count: nothing in the terminal
 * commit payload or in the completeness summary names artifact bytes, so
 * `deadLetter: 1` here does not say "artifact bytes are unresolved". Anyone
 * reading a successful terminal commit as proof that artifact retention
 * finished would be reading something the payload does not assert.
 */
describe("terminal reporting while blob uploads are unresolved", () => {
  it("reports a dead-lettered blob upload only as an untyped non-succeeded count", async () => {
    const h = makeHarness();
    const captured = await capture(h, randomBytes(4096), "tool_result_file:record-A");

    await drain(h, () => Promise.reject(new Error("permanent upstream rejection")));
    assert.equal(h.outbox.get(captured.outboxId)?.status, "dead_letter");

    // The obligation IS still counted as outstanding work...
    const summary = h.outbox.summary();
    assert.equal(summary.deadLetter, 1, "the unresolved upload is counted");
    assert.equal(h.outbox.countNonSucceeded(), 1, "and is not treated as done");
    // ...and the bytes it owes are still claimed, so nothing reclaims them.
    assert.deepEqual([...h.outbox.outstandingBlobDigests()], [captured.sha256]);
    assert.ok(h.spool.has(captured.sha256));

    // But the count carries no kind, so it cannot be attributed to artifact
    // bytes rather than to a record batch or a gap. This is the reporting gap:
    // recorded as unresolved, not reported as "artifact bytes unresolved".
    assert.equal(
      Object.hasOwn(summary, "deadLetterByKind"),
      false,
      "no per-kind breakdown exists, so a blob loss is not attributable from the summary"
    );
    h.outbox.close();
  });

  it("does not let an undelivered blob upload hold back a checkpoint", async () => {
    const h = makeHarness();
    const captured = await capture(h, randomBytes(4096), "tool_result_file:record-A");
    h.outbox.enqueue({
      id: "checkpoint-after-blob",
      kind: "checkpoint",
      payload: { connectorId: "claude_code", sourceInstanceId: "src-1", state: { cursor: "after-blob" } },
      sourceInstanceId: "src-1",
    });

    // The blob upload fails permanently; the checkpoint behind it still drains.
    const checkpointStates: unknown[] = [];
    const result = await drainCollectorOutbox({
      blobUpload: () => Promise.reject(new Error("permanent upstream rejection")),
      client: {
        ...inertClient,
        putSourceInstanceState: (args: { state: unknown }) => {
          checkpointStates.push(args.state);
          return Promise.resolve({}) as never;
        },
      },
      connectorId: "claude_code",
      holderId: "holder-1",
      outbox: h.outbox,
      policy,
      sourceInstanceId: "src-1",
      spool: h.spool,
      spoolReclaimMinAgeMs: 0,
    });

    assert.equal(result.deadLettered, 1, "the blob upload is dead-lettered");
    assert.equal(h.outbox.get("checkpoint-after-blob")?.status, "succeeded");
    assert.deepEqual(checkpointStates, [{ cursor: "after-blob" }], "the checkpoint advanced regardless");
    // The decisive pairing: a checkpoint says the source was read this far while
    // the artifact bytes for a record inside it are still undelivered on disk.
    assert.ok(h.spool.has(captured.sha256), "the unresolved bytes remain, visibly unreclaimed");
    assert.equal(h.outbox.countNonSucceeded(), 1, "the lane is not clean despite the succeeded checkpoint");
    h.outbox.close();
  });
});
