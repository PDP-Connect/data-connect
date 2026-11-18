// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Per-run host blob spool for connectors that declare the BLOB capability.
 *
 * The runtime creates one private directory per run and passes it to the
 * connector as PDPP_BLOB_SPOOL_DIR. The connector writes a regular file there,
 * closes it, and emits a BLOB descriptor (see `HostBlobMessage`). The runtime
 * reads the named file once, checks it against the descriptor, deletes it, and
 * holds the bytes in memory until the matching RECORD. Nothing in the spool is
 * trusted: the connector can write any file in the directory at any time, so
 * every read re-checks the file instead of relying on an earlier check.
 */

import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdtempSync, openSync, readSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HOST_BLOB_MAX_BYTES,
  type HostBlobMessage,
} from "@pdpp/connector-protocol/connector-runtime-protocol";

/** Env var that names the spool directory, the connector's side of the contract. */
export const HOST_BLOB_SPOOL_ENV = "PDPP_BLOB_SPOOL_DIR";

export interface HostBlobSpool {
  readonly dir: string;
  /** Device and inode of `dir` when it was created. */
  readonly identity: { readonly dev: number; readonly ino: number };
  /** Remove the directory and every file left in it. Safe to call twice. */
  dispose(): void;
}

/** A connector's `capabilities.host_blob_write` declaration, once validated. */
export interface HostBlobWriteDeclaration {
  readonly maxBlobBytes: number;
  readonly streams: ReadonlySet<string>;
}

/**
 * Read `capabilities.host_blob_write` from a manifest. Returns null for an
 * absent or malformed declaration: a connector without a usable declaration
 * gets no spool directory and its BLOB messages fail closed.
 */
export function readHostBlobWriteDeclaration(manifest: { capabilities?: unknown }): HostBlobWriteDeclaration | null {
  const capabilities = manifest.capabilities;
  if (typeof capabilities !== "object" || capabilities === null || Array.isArray(capabilities)) {
    return null;
  }
  const declared = (capabilities as Record<string, unknown>).host_blob_write;
  if (typeof declared !== "object" || declared === null || Array.isArray(declared)) {
    return null;
  }
  const { max_blob_bytes: maxBlobBytes, streams, version } = declared as Record<string, unknown>;
  if (
    version !== 1 ||
    !Number.isSafeInteger(maxBlobBytes) ||
    (maxBlobBytes as number) <= 0 ||
    (maxBlobBytes as number) > HOST_BLOB_MAX_BYTES ||
    !Array.isArray(streams) ||
    streams.length === 0 ||
    !streams.every((stream) => typeof stream === "string" && stream.length > 0)
  ) {
    return null;
  }
  return { maxBlobBytes: maxBlobBytes as number, streams: new Set(streams as string[]) };
}

/** Create the run's private spool directory (mode 0700, owner only). */
export function createHostBlobSpool(): HostBlobSpool {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-blob-spool-"));
  const created = lstatSync(dir);
  let disposed = false;
  return {
    dir,
    identity: { dev: created.dev, ino: created.ino },
    dispose() {
      if (disposed) {
        return;
      }
      try {
        rmSync(dir, { force: true, recursive: true });
        disposed = true;
      } catch {
        // A failed cleanup must not change the run outcome, and must stay
        // retryable: `disposed` is set only once the directory is gone. The
        // directory is private to this process and sits under the OS temp root.
      }
    },
  };
}

const READ_CHUNK_BYTES = 1_048_576;

/**
 * Throw unless `spool.dir` is still the directory the runtime created. The
 * connector owns the directory's contents and can also rename it and leave a
 * symlink at the old name, which would point a later open or unlink outside the
 * spool. O_NOFOLLOW guards only the last path component, so the directory is
 * checked before the open, after it and before the unlink.
 *
 * These checks catch a directory replaced before or during a read. They do not
 * close the race: a connector that swaps the directory between a check and the
 * next call, and swaps it back, can still point that call outside. That is not
 * a privilege boundary today, because connectors run as child processes of the
 * runtime under the same user and can read or delete those files themselves.
 * If connectors are ever sandboxed, open and unlink must be bound to a retained
 * directory descriptor instead.
 */
function assertSpoolDirectoryUnchanged(spool: HostBlobSpool, stream: string): void {
  let current: ReturnType<typeof lstatSync>;
  try {
    current = lstatSync(spool.dir);
  } catch {
    throw new Error(`BLOB for stream '${stream}' found its spool directory missing`);
  }
  if (!current.isDirectory() || current.dev !== spool.identity.dev || current.ino !== spool.identity.ino) {
    throw new Error(`BLOB for stream '${stream}' found its spool directory replaced`);
  }
}

/**
 * Read the spool file a BLOB descriptor names and return its bytes after they
 * pass every check, or throw. Checks, in order: the path stays inside the
 * spool; the entry is a regular file reached without following a symlink; its
 * size equals `size_bytes` and is within the declared cap; the bytes read equal
 * that size and hash to `sha256`; the bytes are valid UTF-8 JSON. The file is
 * deleted on success so a second BLOB cannot name it again.
 */
export function readVerifiedSpoolBlob(
  spool: HostBlobSpool,
  message: HostBlobMessage,
  declaration: HostBlobWriteDeclaration
): Buffer {
  if (message.size_bytes > declaration.maxBlobBytes) {
    throw new Error(`BLOB for stream '${message.stream}' exceeds the declared max_blob_bytes`);
  }
  const path = join(spool.dir, message.file);
  assertSpoolDirectoryUnchanged(spool, message.stream);
  let fd: number;
  try {
    // O_NOFOLLOW makes a symlink fail here rather than read its target.
    // O_NONBLOCK makes a FIFO open return at once instead of blocking the
    // event loop until a writer appears; fstat below then refuses it.
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    throw new Error(`BLOB for stream '${message.stream}' names a spool file that cannot be read`);
  }
  let bytes: Buffer;
  try {
    const stat = fstatSync(fd);
    // Re-check after the open: a directory swapped before the open and left in
    // place is refused here.
    assertSpoolDirectoryUnchanged(spool, message.stream);
    if (!stat.isFile() || stat.size !== message.size_bytes) {
      throw new Error(`BLOB for stream '${message.stream}' does not match its spool file size`);
    }
    bytes = Buffer.allocUnsafe(message.size_bytes);
    let offset = 0;
    while (offset < bytes.length) {
      const read = readSync(fd, bytes, offset, Math.min(READ_CHUNK_BYTES, bytes.length - offset), null);
      if (read === 0) {
        throw new Error(`BLOB for stream '${message.stream}' spool file ended before size_bytes`);
      }
      offset += read;
    }
  } finally {
    closeSync(fd);
  }
  if (createHash("sha256").update(bytes).digest("hex") !== message.sha256) {
    throw new Error(`BLOB for stream '${message.stream}' does not match its sha256`);
  }
  try {
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error(`BLOB for stream '${message.stream}' is not valid UTF-8 JSON`);
  }
  assertSpoolDirectoryUnchanged(spool, message.stream);
  try {
    unlinkSync(path);
  } catch {
    // The spool directory is removed with the run.
  }
  return bytes;
}
