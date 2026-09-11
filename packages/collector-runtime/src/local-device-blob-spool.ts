// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";

/**
 * Content-addressed local spool for artifact BYTES.
 *
 * The outbox (`local-device-outbox.ts`) is byte-blind by construction: its
 * only payload column is `payload_json TEXT`, so it can durably retain record
 * envelopes and blob REFERENCES but never the bodies those references point
 * at. Blob uploads historically bypassed it entirely — streamed inline to
 * `POST /v1/blobs` during the run, never written to local disk, with no retry.
 * That is safe only when the ORIGINAL SOURCE is durable and re-readable, which
 * is true for an IMAP server and false for a Claude Code / Codex session
 * transcript: those are short-lived local files subject to the user's own
 * cleanup, `/clear`, tmpdir eviction, and log rotation, and nothing else holds
 * a second copy.
 *
 * This spool is the missing half. It writes bytes to local disk FIRST, keyed
 * by their own sha256, and hands the outbox a `blob_upload` row that names the
 * spool entry. Upload becomes a retryable drain over durable local state
 * instead of a one-shot network call over in-flight bytes.
 *
 * Two properties carry the durability guarantee:
 *
 *  1. **The digest is computed during SPOOLING, not during upload.** Offline
 *     capture cannot depend on completing an upload to learn its own content
 *     identity. `put` hashes as it writes to a temp file and only then renames
 *     into the content-addressed path, so a spooled entry knows its sha256
 *     with no network involved.
 *
 *  2. **The rename is the commit point.** A crash mid-write leaves a `tmp/`
 *     file that no entry references and that `sweepTemp` reclaims; it never
 *     leaves a short read addressable as a complete artifact. Because the
 *     final name IS the digest, a partial file can never occupy the path of
 *     the whole one.
 *
 * Retention is deliberately NOT tied to outbox row lifetime. A dead-lettered
 * `blob_upload` keeps its bytes on disk so the artifact stays recoverable and
 * visibly unresolved rather than silently deleted — reporting a failure is not
 * durability. `release` is therefore called only on acknowledged success.
 */
export interface LocalDeviceBlobSpoolOptions {
  /** Root directory for the spool. Created on demand. */
  root: string;
}

export interface LocalDeviceBlobSpoolEntry {
  /** sha256 of the complete content, lowercase hex. Computed while spooling. */
  sha256: string;
  /** Byte length of the complete content. */
  sizeBytes: number;
}

export type LocalDeviceBlobSpoolContent =
  | AsyncIterable<Buffer | Uint8Array | string>
  | Iterable<Buffer | Uint8Array | string>;

/**
 * Raised when a spool entry a `blob_upload` row names is not on disk.
 *
 * This is a hard integrity failure, not a transient one: the bytes the queue
 * promised to deliver are gone, so no number of retries can produce them. The
 * drain maps it to a dead-letter so the loss is visible and attributable
 * rather than retried forever against an empty path.
 */
export class LocalDeviceBlobSpoolMissingError extends Error {
  readonly sha256: string;

  constructor(sha256: string) {
    super(`blob spool entry missing: ${sha256}`);
    this.name = "LocalDeviceBlobSpoolMissingError";
    this.sha256 = sha256;
  }
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

function assertSha256(sha256: string): void {
  if (!SHA256_HEX.test(sha256)) {
    throw new Error(`invalid blob spool digest: ${sha256}`);
  }
}

async function* toByteChunks(content: LocalDeviceBlobSpoolContent): AsyncIterable<Buffer> {
  if (Symbol.asyncIterator in content) {
    for await (const chunk of content) {
      yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    }
    return;
  }
  for (const chunk of content) {
    yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  }
}

export class LocalDeviceBlobSpool {
  readonly #root: string;

  constructor(options: LocalDeviceBlobSpoolOptions) {
    this.#root = options.root;
    mkdirSync(this.#objectsDir(), { recursive: true });
    mkdirSync(this.#tempDir(), { recursive: true });
  }

  /**
   * Stream `content` to disk, hashing as it goes, and commit it under its own
   * sha256.
   *
   * Nothing is materialised in memory: chunks are hashed and written straight
   * through, so a 64 MB tool-result costs a buffer per chunk, not 64 MB of
   * heap. The write lands in `tmp/` under a unique name and is renamed into
   * `objects/` only after the source is fully consumed and flushed — the
   * rename is atomic within a filesystem, so an entry is either absent or
   * complete.
   *
   * Re-spooling identical content is a no-op that returns the existing entry:
   * the digest is the identity, so duplicate artifacts across sessions share
   * one on-disk body.
   */
  async put(content: LocalDeviceBlobSpoolContent): Promise<LocalDeviceBlobSpoolEntry> {
    const hash = createHash("sha256");
    let sizeBytes = 0;
    const tempPath = join(this.#tempDir(), `spool-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    try {
      await pipeline(
        (async function* (source: AsyncIterable<Buffer>) {
          for await (const chunk of source) {
            hash.update(chunk);
            sizeBytes += chunk.byteLength;
            yield chunk;
          }
        })(toByteChunks(content)),
        createWriteStream(tempPath)
      );
    } catch (error) {
      this.#discardTemp(tempPath);
      throw error;
    }
    const sha256 = hash.digest("hex");
    const finalPath = this.pathFor(sha256);
    try {
      mkdirSync(join(this.#objectsDir(), sha256.slice(0, 2)), { recursive: true });
      renameSync(tempPath, finalPath);
    } catch (error) {
      this.#discardTemp(tempPath);
      throw error;
    }
    return { sha256, sizeBytes };
  }

  /** Absolute path of the committed body for `sha256`. */
  pathFor(sha256: string): string {
    assertSha256(sha256);
    return join(this.#objectsDir(), sha256.slice(0, 2), sha256.slice(2));
  }

  /** Whether a committed body exists for `sha256`. */
  has(sha256: string): boolean {
    try {
      return statSync(this.pathFor(sha256)).isFile();
    } catch {
      return false;
    }
  }

  /**
   * Open a read stream over the committed body.
   *
   * Throws {@link LocalDeviceBlobSpoolMissingError} when the entry is absent,
   * so the drain can distinguish "bytes are gone" (dead-letter) from "the
   * network is down" (retry).
   */
  openRead(sha256: string): NodeJS.ReadableStream {
    if (!this.has(sha256)) {
      throw new LocalDeviceBlobSpoolMissingError(sha256);
    }
    return createReadStream(this.pathFor(sha256));
  }

  /** Byte length of the committed body, or null when absent. */
  sizeOf(sha256: string): number | null {
    try {
      return statSync(this.pathFor(sha256)).size;
    } catch {
      return null;
    }
  }

  /**
   * Delete the committed body for `sha256`.
   *
   * Called only after the upload is acknowledged by the server. A failed or
   * dead-lettered upload deliberately retains its bytes: the artifact must
   * stay recoverable and visibly unresolved, never silently dropped.
   */
  release(sha256: string): void {
    rmSync(this.pathFor(sha256), { force: true });
  }

  /** Total bytes currently held across all committed entries. */
  async totalBytes(): Promise<number> {
    let total = 0;
    let shards: string[];
    try {
      shards = await readdir(this.#objectsDir());
    } catch {
      return 0;
    }
    for (const shard of shards) {
      let names: string[];
      try {
        names = await readdir(join(this.#objectsDir(), shard));
      } catch {
        continue;
      }
      for (const name of names) {
        try {
          total += (await stat(join(this.#objectsDir(), shard, name))).size;
        } catch {
          // A concurrent release removed it between listing and stat.
        }
      }
    }
    return total;
  }

  /**
   * Delete temp files left behind by a crash mid-write.
   *
   * A temp file is never referenced by an entry — the rename into `objects/`
   * is what publishes content — so reclaiming one can never destroy a durable
   * artifact. `olderThanMs` keeps the sweep from racing a concurrent writer in
   * another process.
   */
  async sweepTemp(olderThanMs = 60 * 60_000): Promise<number> {
    let names: string[];
    try {
      names = await readdir(this.#tempDir());
    } catch {
      return 0;
    }
    const cutoff = Date.now() - olderThanMs;
    let swept = 0;
    for (const name of names) {
      const path = join(this.#tempDir(), name);
      try {
        if ((await stat(path)).mtimeMs < cutoff) {
          rmSync(path, { force: true });
          swept += 1;
        }
      } catch {
        // Already gone, or owned by a live writer. Leave it.
      }
    }
    return swept;
  }

  #discardTemp(path: string): void {
    try {
      rmSync(path, { force: true });
    } catch {
      // Preserve the original failure that triggered the discard.
    }
  }

  #objectsDir(): string {
    return join(this.#root, "objects");
  }

  #tempDir(): string {
    return join(this.#root, "tmp");
  }
}
