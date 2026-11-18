// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Profile: real filesystem under the OS temp root, no network, no RS.
 *
 * Pins `host-blob-spool.ts`: the manifest declaration check, the spool
 * directory's lifetime, and the checks applied to every spool file.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HOST_BLOB_MAX_BYTES, type HostBlobMessage } from "@pdpp/connector-protocol/connector-runtime-protocol";
import {
  createHostBlobSpool,
  type HostBlobWriteDeclaration,
  readHostBlobWriteDeclaration,
  readVerifiedSpoolBlob,
} from "./host-blob-spool.ts";

const DECLARATION: HostBlobWriteDeclaration = { maxBlobBytes: 64, streams: new Set(["attachments"]) };

function messageFor(file: string, text: string, overrides: Partial<HostBlobMessage> = {}): HostBlobMessage {
  return {
    file,
    key: "k",
    mime_type: "application/json",
    sha256: createHash("sha256").update(text).digest("hex"),
    size_bytes: Buffer.byteLength(text),
    stream: "attachments",
    type: "BLOB",
    ...overrides,
  } as HostBlobMessage;
}

test("the declaration is read only when version, cap and streams are all valid", () => {
  const good = { host_blob_write: { max_blob_bytes: 10, streams: ["a", "b"], version: 1 } };
  const declared = readHostBlobWriteDeclaration({ capabilities: good });
  assert.equal(declared?.maxBlobBytes, 10);
  assert.deepEqual([...(declared?.streams ?? [])], ["a", "b"]);

  const bad: unknown[] = [
    undefined,
    null,
    [],
    {},
    { host_blob_write: null },
    { host_blob_write: { max_blob_bytes: 10, streams: ["a"], version: 2 } },
    { host_blob_write: { max_blob_bytes: 0, streams: ["a"], version: 1 } },
    { host_blob_write: { max_blob_bytes: 1.5, streams: ["a"], version: 1 } },
    { host_blob_write: { max_blob_bytes: HOST_BLOB_MAX_BYTES + 1, streams: ["a"], version: 1 } },
    { host_blob_write: { max_blob_bytes: 10, streams: [], version: 1 } },
    { host_blob_write: { max_blob_bytes: 10, streams: [""], version: 1 } },
    { host_blob_write: { max_blob_bytes: 10, streams: [1], version: 1 } },
    { host_blob_write: { max_blob_bytes: 10, version: 1 } },
  ];
  for (const capabilities of bad) {
    assert.equal(readHostBlobWriteDeclaration({ capabilities }), null, JSON.stringify(capabilities));
  }
});

test("the spool directory is private, and dispose removes it and its files, twice without error", () => {
  const spool = createHostBlobSpool();
  assert.equal(statSync(spool.dir).mode & 0o777, 0o700);
  writeFileSync(join(spool.dir, "left-behind.json"), "{}");
  spool.dispose();
  assert.equal(existsSync(spool.dir), false);
  spool.dispose();
});

test("dispose retries after a transient removal failure", (t) => {
  const spool = createHostBlobSpool();
  // A read-only subdirectory makes the first removal fail for real: its file cannot be unlinked.
  const locked = join(spool.dir, "locked");
  mkdirSync(locked);
  writeFileSync(join(locked, "left-behind.json"), "{}");
  chmodSync(locked, 0o500);
  t.after(() => {
    if (existsSync(locked)) {
      chmodSync(locked, 0o700);
    }
    rmSync(spool.dir, { force: true, recursive: true });
  });
  spool.dispose();
  assert.equal(existsSync(spool.dir), true, "precondition: the first removal failed");
  chmodSync(locked, 0o700);
  spool.dispose();
  assert.equal(existsSync(spool.dir), false);
});

test("a good file returns its bytes and is deleted so a second BLOB cannot name it again", (t) => {
  const spool = createHostBlobSpool();
  t.after(() => spool.dispose());
  const text = JSON.stringify({ ok: true });
  writeFileSync(join(spool.dir, "a.json"), text);
  const bytes = readVerifiedSpoolBlob(spool, messageFor("a.json", text), DECLARATION);
  assert.equal(bytes.toString("utf-8"), text);
  assert.equal(existsSync(join(spool.dir, "a.json")), false);
  assert.throws(() => readVerifiedSpoolBlob(spool, messageFor("a.json", text), DECLARATION), /cannot be read/);
});

test("each way a spool file can disagree with its descriptor is refused", (t) => {
  const spool = createHostBlobSpool();
  t.after(() => spool.dispose());
  const text = JSON.stringify({ ok: true });
  const cases: [string, () => HostBlobMessage, RegExp][] = [
    [
      "wrong sha256",
      () => {
        writeFileSync(join(spool.dir, "sha.json"), text);
        return messageFor("sha.json", text, { sha256: "0".repeat(64) });
      },
      /does not match its sha256/,
    ],
    [
      "size smaller than the file",
      () => {
        writeFileSync(join(spool.dir, "small.json"), text);
        return messageFor("small.json", text, { size_bytes: text.length - 1 });
      },
      /does not match its spool file size/,
    ],
    [
      "size larger than the file",
      () => {
        writeFileSync(join(spool.dir, "large.json"), text);
        return messageFor("large.json", text, { size_bytes: text.length + 1 });
      },
      /does not match its spool file size/,
    ],
    [
      "over the declared cap",
      () => {
        const big = JSON.stringify({ pad: "x".repeat(100) });
        writeFileSync(join(spool.dir, "big.json"), big);
        return messageFor("big.json", big);
      },
      /exceeds the declared max_blob_bytes/,
    ],
    [
      "not JSON",
      () => {
        writeFileSync(join(spool.dir, "text.json"), "plain text");
        return messageFor("text.json", "plain text");
      },
      /not valid UTF-8 JSON/,
    ],
    [
      "invalid UTF-8",
      () => {
        const raw = Buffer.from([0x22, 0xff, 0x22]);
        writeFileSync(join(spool.dir, "utf8.json"), raw);
        return {
          ...messageFor("utf8.json", ""),
          sha256: createHash("sha256").update(raw).digest("hex"),
          size_bytes: raw.length,
        } as HostBlobMessage;
      },
      /not valid UTF-8 JSON/,
    ],
    [
      "symlink",
      () => {
        writeFileSync(join(spool.dir, "target.json"), text);
        symlinkSync(join(spool.dir, "target.json"), join(spool.dir, "link.json"));
        return messageFor("link.json", text);
      },
      /cannot be read/,
    ],
    [
      "a directory",
      () => messageFor(".", text),
      /cannot be read|does not match its spool file size/,
    ],
    ["missing file", () => messageFor("missing.json", text), /cannot be read/],
  ];
  for (const [label, build, pattern] of cases) {
    assert.throws(() => readVerifiedSpoolBlob(spool, build(), DECLARATION), pattern, label);
  }
});

// Behavior: a FIFO named by a BLOB is refused without blocking. Defect: the
// blocking open waits for a writer that never comes and freezes the runtime's
// event loop, so cancel and timers never run. Oracle: a child process reads a
// writer-less FIFO and must exit within the watchdog; an in-process test would
// hang the runner itself if the defect came back.
test("a FIFO in the spool is refused at once instead of blocking the event loop", { skip: process.platform === "win32" }, () => {
  const script = [
    'import { execFileSync } from "node:child_process";',
    'import { join } from "node:path";',
    'import { createHostBlobSpool, readVerifiedSpoolBlob } from "./runtime/host-blob-spool.ts";',
    "const spool = createHostBlobSpool();",
    'execFileSync("mkfifo", [join(spool.dir, "pipe.json")]);',
    "try {",
    '  readVerifiedSpoolBlob(spool, { file: "pipe.json", key: "k", mime_type: "application/json", sha256: "0".repeat(64), size_bytes: 2, stream: "attachments", type: "BLOB" }, { maxBlobBytes: 64, streams: new Set(["attachments"]) });',
    '  console.log("read");',
    "} catch (error) {",
    "  console.log(String(error.message));",
    "} finally {",
    "  spool.dispose();",
    "}",
  ].join("\n");
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: join(import.meta.dirname, ".."),
    encoding: "utf-8",
    timeout: 20_000,
  });
  assert.equal(child.signal, null, "the read returned before the watchdog killed it");
  assert.match(child.stdout, /does not match its spool file size/, child.stderr);
});

// Behavior: the spool directory is re-checked, so swapping it for a symlink to
// another directory is refused and the outside file is neither read nor
// deleted. Defect: O_NOFOLLOW guards only the file name, so a swapped parent
// reads and unlinks a file outside the spool. Oracle: an outside sentinel with
// the descriptor's exact size and hash survives the read.
test("a spool directory swapped for a symlink is refused and the outside file survives", (t) => {
  const spool = createHostBlobSpool();
  const outside = mkdtempSync(join(tmpdir(), "pdpp-blob-outside-"));
  const moved = `${spool.dir}-moved`;
  t.after(() => {
    rmSync(outside, { force: true, recursive: true });
    rmSync(moved, { force: true, recursive: true });
    rmSync(spool.dir, { force: true, recursive: true });
  });
  const text = JSON.stringify({ secret: true });
  writeFileSync(join(outside, "a.json"), text);
  renameSync(spool.dir, moved);
  symlinkSync(outside, spool.dir);
  assert.throws(() => readVerifiedSpoolBlob(spool, messageFor("a.json", text), DECLARATION), /spool directory replaced/);
  assert.equal(readFileSync(join(outside, "a.json"), "utf-8"), text, "the outside file is untouched");
});
