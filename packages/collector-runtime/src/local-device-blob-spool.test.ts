// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { captureBlobArtifact } from "./local-device-blob-capture.ts";
import { LocalDeviceBlobSpool, LocalDeviceBlobSpoolMissingError } from "./local-device-blob-spool.ts";
import { LocalDeviceOutbox } from "./local-device-outbox.ts";

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "pdpp-blob-spool-"));
  roots.push(root);
  return root;
}

after(() => {
  for (const root of roots) {
    rmSync(root, { force: true, recursive: true });
  }
});

function sha256Of(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

describe("LocalDeviceBlobSpool", () => {
  it("computes the digest during spooling, with no upload involved", async () => {
    const root = makeRoot();
    const spool = new LocalDeviceBlobSpool({ root });
    const body = randomBytes(3 * 1024 * 1024);

    const entry = await spool.put([body]);

    // The identity is known offline: no network call participated.
    assert.equal(entry.sha256, sha256Of(body));
    assert.equal(entry.sizeBytes, body.byteLength);
    assert.ok(spool.has(entry.sha256));
    assert.deepEqual(await readFile(spool.pathFor(entry.sha256)), body);
  });

  it("preserves bytes exactly across a large chunked stream", async () => {
    const root = makeRoot();
    const spool = new LocalDeviceBlobSpool({ root });
    const chunks = Array.from({ length: 64 }, () => randomBytes(128 * 1024));
    const whole = Buffer.concat(chunks);

    const entry = await spool.put(chunks);

    assert.equal(entry.sha256, sha256Of(whole));
    assert.equal(entry.sizeBytes, whole.byteLength);
    assert.deepEqual(await readFile(spool.pathFor(entry.sha256)), whole);
  });

  it("is idempotent: identical content spools once and shares one body", async () => {
    const root = makeRoot();
    const spool = new LocalDeviceBlobSpool({ root });
    const body = randomBytes(4096);

    const first = await spool.put([body]);
    const second = await spool.put([body]);

    assert.equal(first.sha256, second.sha256);
    const shard = readdirSync(join(root, "objects", first.sha256.slice(0, 2)));
    assert.equal(shard.length, 1);
  });

  it("leaves no addressable entry when the source fails mid-write", async () => {
    const root = makeRoot();
    const spool = new LocalDeviceBlobSpool({ root });
    const partial = randomBytes(8192);
    const boom = new Error("source read failed");

    await assert.rejects(
      spool.put(
        (async function* () {
          yield await Promise.resolve(partial);
          throw boom;
        })()
      ),
      /source read failed/
    );

    // A short read must never be addressable as a complete artifact, and the
    // failed temp file must not linger as garbage.
    assert.equal(spool.has(sha256Of(partial)), false);
    assert.deepEqual(readdirSync(join(root, "tmp")), []);
  });

  it("reports a missing body distinctly so the drain can stop retrying", () => {
    const root = makeRoot();
    const spool = new LocalDeviceBlobSpool({ root });
    const absent = sha256Of(Buffer.from("never spooled"));

    assert.throws(() => spool.openRead(absent), LocalDeviceBlobSpoolMissingError);
  });

  it("sweeps crash-orphaned temp files without touching committed bodies", async () => {
    const root = makeRoot();
    const spool = new LocalDeviceBlobSpool({ root });
    const kept = await spool.put([randomBytes(1024)]);

    const orphan = join(root, "tmp", "spool-crashed");
    writeFileSync(orphan, randomBytes(512));

    assert.equal(await spool.sweepTemp(0), 1);
    assert.ok(spool.has(kept.sha256), "committed bodies survive a temp sweep");
  });

  it("surfaces a disk-full write failure instead of reporting a capture", async () => {
    const root = makeRoot();
    const spool = new LocalDeviceBlobSpool({ root });
    const enospc = Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });

    await assert.rejects(
      spool.put(
        (async function* () {
          yield await Promise.resolve(randomBytes(256));
          throw enospc;
        })()
      ),
      /ENOSPC/
    );
    assert.deepEqual(readdirSync(join(root, "tmp")), [], "no partial file is left behind");
  });
});

describe("captureBlobArtifact", () => {
  function makeOutbox(root: string): LocalDeviceOutbox {
    return new LocalDeviceOutbox({ path: join(root, "outbox.sqlite") });
  }

  it("admits to the queue only after the bytes are durable", async () => {
    const root = makeRoot();
    const spool = new LocalDeviceBlobSpool({ root });
    const outbox = makeOutbox(root);
    const body = randomBytes(64 * 1024);

    const captured = await captureBlobArtifact({
      connectorId: "claude_code",
      content: [body],
      mimeType: "text/plain",
      outbox,
      recordKey: "tool_result_file:demo",
      sourceInstanceId: "src-1",
      spool,
      stream: "attachments",
    });

    // Both halves of the guarantee: bytes on disk AND a durable queue row.
    assert.equal(captured.sha256, sha256Of(body));
    assert.ok(spool.has(captured.sha256));
    const item = outbox.get(captured.outboxId);
    assert.ok(item);
    assert.equal(item.kind, "blob_upload");
    assert.equal(item.status, "ready");
    outbox.close();
  });

  it("recovers an interruption between spool creation and queue admission", async () => {
    const root = makeRoot();
    const spool = new LocalDeviceBlobSpool({ root });
    const body = randomBytes(32 * 1024);

    // Simulate the crash window: the bytes landed, the process died before the
    // outbox row existed.
    const orphan = await spool.put([body]);
    assert.ok(spool.has(orphan.sha256));

    // A later run re-reads the same source and re-captures. Content addressing
    // makes the re-spool a no-op and the queue id deterministic.
    const outbox = makeOutbox(root);
    const first = await captureBlobArtifact({
      connectorId: "claude_code",
      content: [body],
      mimeType: "text/plain",
      outbox,
      recordKey: "tool_result_file:demo",
      sourceInstanceId: "src-1",
      spool,
      stream: "attachments",
    });
    const second = await captureBlobArtifact({
      connectorId: "claude_code",
      content: [body],
      mimeType: "text/plain",
      outbox,
      recordKey: "tool_result_file:demo",
      sourceInstanceId: "src-1",
      spool,
      stream: "attachments",
    });

    assert.equal(first.sha256, orphan.sha256, "the orphan body is reused, not duplicated");
    assert.equal(second.outboxId, first.outboxId, "re-admission is idempotent");
    assert.equal(readdirSync(join(root, "objects", orphan.sha256.slice(0, 2))).length, 1);
    outbox.close();
  });

  it("survives process restart: a reopened outbox still holds the work and its bytes", async () => {
    const root = makeRoot();
    const spool = new LocalDeviceBlobSpool({ root });
    const body = randomBytes(16 * 1024);

    const outbox = makeOutbox(root);
    const captured = await captureBlobArtifact({
      connectorId: "claude_code",
      content: [body],
      mimeType: "text/plain",
      outbox,
      recordKey: "tool_result_file:restart",
      sourceInstanceId: "src-1",
      spool,
      stream: "attachments",
    });
    outbox.close();

    // New process: fresh handles over the same on-disk state.
    const reopened = makeOutbox(root);
    const reopenedSpool = new LocalDeviceBlobSpool({ root });
    const item = reopened.get(captured.outboxId);

    assert.ok(item, "the queue row survived the restart");
    assert.equal(item.status, "ready");
    assert.deepEqual(await readFile(reopenedSpool.pathFor(captured.sha256)), body);
    reopened.close();
  });

  it("delivers byte-exact content after the source file is deleted", async () => {
    const root = makeRoot();
    const spool = new LocalDeviceBlobSpool({ root });
    const outbox = makeOutbox(root);

    // A real source file, captured offline, then deleted — the Claude Code
    // scenario where nothing else holds a second copy.
    const sourcePath = join(root, "tool-result.txt");
    const body = randomBytes(512 * 1024);
    writeFileSync(sourcePath, body);

    const captured = await captureBlobArtifact({
      connectorId: "claude_code",
      content: createReadStream(sourcePath),
      mimeType: "text/plain",
      outbox,
      recordKey: "tool_result_file:deleted-source",
      sourceInstanceId: "src-1",
      spool,
      stream: "attachments",
    });

    rmSync(sourcePath);
    assert.throws(() => statSync(sourcePath), "the source is genuinely gone");

    // The artifact is still deliverable, byte for byte.
    assert.deepEqual(await readFile(spool.pathFor(captured.sha256)), body);
    assert.equal(captured.sha256, sha256Of(body));
    outbox.close();
  });
});
