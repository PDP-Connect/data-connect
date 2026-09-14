// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The reclaim sweep has no ownership contract with capture, so it can delete a
 * body a live obligation names. These tests pin that, and pin the decision made
 * because of it: reclamation is OFF, so a drain destroys nothing.
 *
 * The race is only observable if the concurrent capture commits inside the
 * window between the sweep observing a body's metadata and the sweep unlinking
 * that body's pathname. That window is a real `await` in
 * `reclaimUnreferencedUnsafe`, but it is short, so leaving the interleaving to
 * the scheduler would make this test pass for the wrong reason most runs. A
 * loader hook (`reclaim-race-stat-hook.mjs`) therefore holds the sweep inside
 * that await while the capture completes. It changes only WHEN the capture
 * lands, never what either side does: the capture is the real
 * `captureBlobArtifact`, the sweep is the real sweep, the reference snapshot is
 * the real `outstandingBlobDigests()`, and the grace period is the production
 * default with no override.
 *
 * Without the hook the test cannot distinguish a safe sweep from an unsafe one
 * that got lucky, so it asserts the window was entered and fails if it was not.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
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
import { assertSpoolReferenceAuthorityIsComplete, LocalDeviceBlobSpool } from "./local-device-blob-spool.ts";
import { LocalDeviceOutbox } from "./local-device-outbox.ts";

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "pdpp-reclaim-race-"));
  roots.push(root);
  return root;
}

after(() => {
  for (const root of roots) {
    rmSync(root, { force: true, recursive: true });
  }
});

/** Set by the loader hook when it is installed; absent under a plain run. */
interface RaceHookGlobal {
  __PDPP_RECLAIM_RACE_HOOK?: ((path: string) => Promise<void>) | undefined;
  __PDPP_RECLAIM_RACE_HOOK_INSTALLED?: boolean;
}

const hookGlobal = globalThis as unknown as RaceHookGlobal;

const inertClient = {
  ackLocalCollectorGap: () => Promise.reject(new Error("unexpected gap ack")),
  ingestBatch: () => Promise.reject(new Error("unexpected ingest")),
  putSourceInstanceState: () => Promise.reject(new Error("unexpected state put")),
};

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

function capture(h: Harness, body: Buffer, recordKey: string) {
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
 * Accept an upload, draining its stream first. A real transport reads the body;
 * resolving without reading leaves a read stream open over a temp directory the
 * suite is about to remove.
 */
const acceptUpload: DrainBlobUploadFn = async (args) => {
  for await (const _chunk of args.content) {
    // Discard: this suite asserts on retention, not on byte fidelity.
  }
  return { sha256: args.sha256, size_bytes: args.sizeBytes };
};

/** Backdate a body well past the production grace period. */
function backdate(path: string): void {
  const old = new Date(Date.now() - 3 * 60 * 60_000);
  utimesSync(path, old, old);
}

/**
 * Run `sweep` with a complete concurrent capture landing inside the sweep's
 * metadata await for `path`. Returns whether that window was actually entered.
 */
async function withCaptureInsideStatWindow(
  path: string,
  onWindow: () => Promise<void>,
  sweep: () => Promise<unknown>
): Promise<boolean> {
  let entered = false;
  hookGlobal.__PDPP_RECLAIM_RACE_HOOK = async (observed: string) => {
    if (entered || observed !== path) {
      return;
    }
    entered = true;
    await onWindow();
  };
  try {
    await sweep();
  } finally {
    hookGlobal.__PDPP_RECLAIM_RACE_HOOK = undefined;
  }
  return entered;
}

describe("spool reclamation is disabled because it races capture", () => {
  it("MUST-FAIL GUARD: the sweep deletes a concurrently recaptured body", async (t) => {
    if (!hookGlobal.__PDPP_RECLAIM_RACE_HOOK_INSTALLED) {
      t.skip("requires the reclaim-race stat hook; see package.json test:reclaim-race");
      return;
    }
    const h = makeHarness();
    const body = Buffer.from("an artifact that is captured twice");

    // A body that has been delivered and is genuinely unreferenced and old.
    const first = await capture(h, body, "tool_result_file:first");
    const path = h.spool.pathFor(first.sha256);
    const delivered = await drainCollectorOutbox({
      blobUpload: acceptUpload,
      client: inertClient,
      connectorId: "claude_code",
      holderId: "holder-1",
      outbox: h.outbox,
      policy,
      sourceInstanceId: "src-1",
      spool: h.spool,
    });
    assert.equal(delivered.sent, 1);
    backdate(path);

    // The reference snapshot the drain would pass: empty, and honestly so.
    const snapshot = h.outbox.outstandingBlobDigests();
    assert.equal(snapshot.size, 0, "nothing owed this body when the sweep began");

    const entered = await withCaptureInsideStatWindow(
      path,
      async () => {
        // Concurrent capture: replaces the object, refreshes its mtime, and
        // records a NEW obligation over it.
        await capture(h, body, "tool_result_file:second");
      },
      () =>
        // Production grace period. No `minAgeMs` override.
        h.spool.reclaimUnreferencedUnsafe({
          acknowledgeUnsafe: true,
          outstandingDigests: snapshot,
        })
    );

    assert.ok(entered, "the race window must actually be entered for this test to discriminate");
    const owed = [...h.outbox.outstandingBlobDigests()];
    assert.deepEqual(owed, [first.sha256], "a live obligation now names this body");

    // THE DEFECT. The sweep judged an object that no longer existed and
    // unlinked the one that replaced it, stranding the obligation above.
    assert.equal(
      existsSync(path),
      false,
      "documents the unsafe sweep's behaviour: enabling reclamation destroys the fresh body"
    );
    h.outbox.close();
  });

  it("the fresh object survives the same race because the drain does not reclaim", async (t) => {
    if (!hookGlobal.__PDPP_RECLAIM_RACE_HOOK_INSTALLED) {
      t.skip("requires the reclaim-race stat hook; see package.json test:reclaim-race");
      return;
    }
    const h = makeHarness();
    const body = Buffer.from("an artifact that is captured twice");

    const first = await capture(h, body, "tool_result_file:first");
    const path = h.spool.pathFor(first.sha256);
    backdate(path);

    // Drain the first obligation to success, so the body is unreferenced and
    // old — exactly the state the sweep would consider reclaimable.
    const delivered = await drainCollectorOutbox({
      blobUpload: acceptUpload,
      client: inertClient,
      connectorId: "claude_code",
      holderId: "holder-1",
      outbox: h.outbox,
      policy,
      sourceInstanceId: "src-1",
      spool: h.spool,
    });
    assert.equal(delivered.sent, 1);
    assert.equal(h.outbox.outstandingBlobDigests().size, 0, "unreferenced after delivery");
    assert.ok(existsSync(path), "and retained, because the drain reclaims nothing");

    // Recapture, then drain again with the same race window armed. The window
    // is never entered: a drain that does not sweep never stats a body.
    await capture(h, body, "tool_result_file:second");
    backdate(path);
    const entered = await withCaptureInsideStatWindow(
      path,
      () => Promise.resolve(),
      () =>
        drainCollectorOutbox({
          blobUpload: () => Promise.reject(new Error("network down")),
          client: inertClient,
          connectorId: "claude_code",
          holderId: "holder-1",
          outbox: h.outbox,
          policy,
          sourceInstanceId: "src-1",
          spool: h.spool,
        })
    );

    assert.equal(entered, false, "the drain never reaches the sweep, so the race window does not exist");
    assert.ok(existsSync(path), "the fresh object survives");
    assert.equal(
      h.outbox.outstandingBlobDigests().size,
      1,
      "and its obligation still has bytes to deliver on the next attempt"
    );
    h.outbox.close();
  });

  it("a drain retains an old, unreferenced body rather than reclaiming it", async () => {
    const h = makeHarness();
    const body = Buffer.from("delivered and then left alone");
    const captured = await capture(h, body, "tool_result_file:only");
    const path = h.spool.pathFor(captured.sha256);

    const result = await drainCollectorOutbox({
      blobUpload: acceptUpload,
      client: inertClient,
      connectorId: "claude_code",
      holderId: "holder-1",
      outbox: h.outbox,
      policy,
      sourceInstanceId: "src-1",
      spool: h.spool,
      // Would waive the grace period IF reclamation ran. It does not.
      spoolReclaimMinAgeMs: 0,
    });

    assert.equal(result.sent, 1);
    assert.equal(h.outbox.get(captured.outboxId)?.status, "succeeded");
    assert.equal(h.outbox.outstandingBlobDigests().size, 0, "nothing owes these bytes");
    backdate(path);
    assert.ok(existsSync(path), "surplus bytes are retained; reclamation is disabled, not merely deferred");
    h.outbox.close();
  });

  it("refuses the sweep without an explicit unsafe acknowledgement", async () => {
    const h = makeHarness();
    await assert.rejects(
      () =>
        (
          h.spool as unknown as {
            reclaimUnreferencedUnsafe: (input: unknown) => Promise<unknown>;
          }
        ).reclaimUnreferencedUnsafe({ outstandingDigests: new Set<string>() }),
      /acknowledgeUnsafe/,
      "no caller reaches this sweep without naming the hazard"
    );
    h.outbox.close();
  });
});

describe("spool reference authority", () => {
  it("rejects a reference set drawn from a subset of the queues sharing a spool", () => {
    // The shape `resolveCollectorQueuePath` produces: one directory, one file
    // per connection, and a spool beside them serving all of them.
    const dir = "/state/pdpp/collectors";
    const sharing = [`${dir}/claude_code.src-1.sqlite`, `${dir}/claude_code.src-2.sqlite`];

    assert.throws(
      () =>
        assertSpoolReferenceAuthorityIsComplete({
          consultedQueuePaths: [sharing[0] as string],
          sharingQueuePaths: sharing,
        }),
      /incomplete/,
      "one drain's outbox is not the reference authority for a shared spool"
    );
  });

  it("accepts a reference set covering every queue that shares the spool", () => {
    const dir = "/state/pdpp/collectors";
    const sharing = [`${dir}/claude_code.src-1.sqlite`, `${dir}/claude_code.src-2.sqlite`];

    assert.doesNotThrow(() =>
      assertSpoolReferenceAuthorityIsComplete({
        consultedQueuePaths: sharing,
        sharingQueuePaths: sharing,
      })
    );
  });
});
