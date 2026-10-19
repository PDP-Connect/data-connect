// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import {
  closeSync,
  createReadStream,
  createWriteStream,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
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
 * durability.
 *
 * Reclamation is therefore a sweep, never a per-upload delete: one body can be
 * owed to several `blob_upload` rows at once (same content, different record
 * coordinates), and the delete must follow the DURABLE record that every such
 * obligation is met — neither of which a delete inside one upload's send path
 * can honour.
 *
 * **That sweep is currently DISABLED, and nothing reclaims spooled bodies.**
 * See {@link LocalDeviceBlobSpool.reclaimUnreferencedUnsafe}: it has no correct
 * ownership contract with capture, so it can delete a body a live obligation
 * names. Until capture admission and reclamation share one, the spool grows
 * without bound and an operator reclaims by hand. Retaining surplus bytes is
 * the deliberate choice — surplus disk is recoverable, a destroyed artifact is
 * not, and a `blob_upload` row whose body is missing is classified TERMINAL,
 * so the loss is permanent rather than retried.
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

export interface LocalDeviceBlobSpoolReclaimResult {
  /** Bytes returned to the filesystem. */
  bytesReclaimed: number;
  /** Bodies deleted because nothing owes their delivery any more. */
  reclaimed: number;
  /** Bodies kept because a non-`succeeded` `blob_upload` row still claims them. */
  retainedReferenced: number;
  /** Bodies kept because they are younger than the capture-race grace period. */
  retainedTooRecent: number;
}

/**
 * Age gate applied by {@link LocalDeviceBlobSpool.reclaimUnreferencedUnsafe}.
 *
 * This was intended to close the capture race: `captureBlobArtifact` commits
 * bytes, then enqueues the row naming them, so a body in that gap is
 * unreferenced but live. **It does not close it, at any length.** The sweep
 * reads a file's metadata and then deletes its PATHNAME; a capture that
 * commits in between replaces the object at that pathname, so the age the
 * sweep tested belongs to a file that no longer exists. Lengthening this
 * value widens the window it is evaluated in, not the safety of the delete.
 *
 * Kept only because the disabled sweep still takes it — see that method.
 */
export const DEFAULT_SPOOL_RECLAIM_MIN_AGE_MS = 60 * 60_000;

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

/**
 * Whether a file's mtime is at least `ageMs` old, compared at whole-millisecond
 * resolution.
 *
 * Two clock mismatches make a naive `mtimeMs < now - ageMs` wrong:
 *
 *  - `stat().mtimeMs` carries sub-millisecond precision (e.g. `…537.2615`)
 *    while `Date.now()` truncates to whole milliseconds (`…537`), so the two
 *    are not directly comparable.
 *  - With `ageMs = 0` the question is "has this file's timestamp arrived yet",
 *    and a file written during the SAME millisecond as the comparison is not
 *    strictly less than it. A strict `<` therefore answers "no" for any file
 *    created in the sweep's own millisecond — which for `sweepTemp(0)` is most
 *    of them, making an explicit sweep-everything call silently reclaim nothing.
 *
 * Flooring the mtime puts both sides on whole milliseconds, and `<=` makes an
 * age of zero mean "including this millisecond" rather than "strictly before
 * it". A non-zero `ageMs` is unaffected in practice: the extra millisecond of
 * tolerance is immaterial against a grace period measured in minutes or hours.
 */
function isOlderThan(mtimeMs: number, ageMs: number, now: number): boolean {
  return Math.floor(mtimeMs) <= now - ageMs;
}

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

/**
 * Hard precondition for enabling spool reclamation: every queue that can name
 * a body in this spool must be represented in the reference set.
 *
 * The spool is content-addressed, so one body serves every capture of that
 * content regardless of which connection captured it. Reclamation asks "does
 * anything still owe this body", and an answer drawn from a subset of the
 * queues is not that question — it is "does THIS queue still owe it", which
 * reads a body another connection owes as unreferenced.
 *
 * The shapes are not hypothetical. `resolveCollectorQueuePath` puts each
 * connection's queue in ONE directory as `<connectorId>.<sourceInstanceId>.sqlite`,
 * so a spool sited in that directory is shared by all of them while
 * `drainCollectorOutbox` holds exactly one. Two ownership models are sound:
 *
 *  - **Per-queue spool.** Site the spool under a path derived from the queue,
 *    so the queue holding it is the only one that can name its bodies. Costs
 *    cross-connection deduplication of identical content.
 *  - **Complete reference authority.** Keep one shared spool and build the
 *    reference set by unioning `outstandingBlobDigests()` over every queue
 *    sharing it, including queues no run has opened yet.
 *
 * This throws rather than warns: a silent partial answer here deletes
 * artifacts. Call it before any reclamation is enabled.
 */
export function assertSpoolReferenceAuthorityIsComplete(input: {
  /** Queue paths whose `blob_upload` rows contributed to the reference set. */
  consultedQueuePaths: readonly string[];
  /** Every queue path that can name a body in this spool. */
  sharingQueuePaths: readonly string[];
}): void {
  const consulted = new Set(input.consultedQueuePaths);
  const missing = input.sharingQueuePaths.filter((path) => !consulted.has(path));
  if (missing.length > 0) {
    throw new Error(
      `spool reference authority is incomplete: ${missing.length} queue(s) share this spool but were not consulted (${missing.join(", ")}); ` +
        "reclaiming against a subset can delete a body another connection still owes"
    );
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
   *
   * **Durability across power loss requires an explicit sync protocol**, which
   * a rename alone does not provide. `rename(2)` is atomic with respect to
   * other processes, so a concurrent reader sees the old name or the new one
   * and never a partial file — but atomicity is not persistence. Without an
   * explicit flush, the written bytes and the directory entry naming them may
   * both sit in the page cache, and a power cut can lose either or both,
   * including in the order that leaves a present name over absent content.
   * Node's `createWriteStream` does NOT close that gap: its `flush` option
   * defaults to false, so stream close returns without an `fsync`. So:
   *
   *  1. `flush: true` on the write stream fsyncs the temp file's CONTENT
   *     before close resolves.
   *  2. After the rename, {@link #syncDir} fsyncs the SHARD directory so the
   *     name that makes those bytes reachable is itself durable.
   *
   * **Scope of that guarantee.** It covers the content and the shard's own
   * entry. It does NOT cover the shard directory's entry in `objects/`, nor
   * `objects/`'s entry in the spool root, when `mkdirSync(…, {recursive: true})`
   * has just created them: an fsync of a directory persists the entries IN it,
   * not the entry naming IT in its parent. For the first body written to a
   * shard — and for the first body written to a brand-new spool — power loss
   * can therefore still leave a synced directory that its unsynced parent does
   * not list, which loses the body as surely as losing the bytes.
   *
   * So: a successful return means the bytes and their shard entry are durable
   * against power loss GIVEN the shard's ancestors already were, which holds
   * for every write after a shard's first. Closing the remaining case means
   * fsyncing each directory this call newly creates, in its own parent, from
   * the spool root down. Not done here: it costs an fsync per level on a path
   * that is hot, and the residual exposure is one body per new shard, which is
   * a smaller loss than the eager-delete defect this design replaced. Do not
   * restate this as an unqualified durability guarantee.
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
        // flush: true fsyncs the file content before close resolves. Without
        // it the rename can publish a name over bytes still only in cache.
        createWriteStream(tempPath, { flush: true })
      );
    } catch (error) {
      this.#discardTemp(tempPath);
      throw error;
    }
    const sha256 = hash.digest("hex");
    const finalPath = this.pathFor(sha256);
    const shardDir = join(this.#objectsDir(), sha256.slice(0, 2));
    try {
      mkdirSync(shardDir, { recursive: true });
      renameSync(tempPath, finalPath);
      // The content is already durable; make the shard's entry for it durable
      // too. This does NOT sync the shard's own entry in `objects/` when the
      // mkdir above just created it — see the qualification on `put`.
      this.#syncDir(shardDir);
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
   * Reclaim committed bodies that no longer have any delivery obligation.
   *
   * **NOT SAFE UNDER CONCURRENT CAPTURE. Disabled by default; no production
   * caller enables it.** Two defects are unresolved, and neither is closed by
   * tuning `minAgeMs`:
   *
   *  1. **The delete is not synchronised with capture.** The reference set is
   *     snapshotted by the caller, this loop then `await`s a file's metadata,
   *     and only then unlinks the PATHNAME. A capture that commits inside that
   *     window replaces the object and enqueues a new obligation, and the
   *     unlink destroys the FRESH body while judging it by the OLD one's age
   *     and the OLD snapshot. Reproduced with the default one-hour grace by
   *     `local-device-blob-spool-reclaim-race.test.ts`. Because a `blob_upload`
   *     row naming absent bytes is classified TERMINAL, the resulting loss is
   *     permanent rather than retried.
   *
   *     A correct repair needs an ownership contract, not a longer wait or a
   *     second stat: the check and the delete must apply to the same object.
   *     POSIX offers no "unlink if this is still that inode", so the contract
   *     has to come from capture and reclamation agreeing on exclusion (a lock
   *     over the spool root, or reclamation running only when no capture can
   *     be in flight), which does not exist today.
   *
   *  2. **The reference authority is incomplete.** `outstandingDigests` comes
   *     from ONE outbox, while the spool is content-addressed and therefore
   *     shared. Per-connection queues are separate files in one directory
   *     (`<connectorId>.<sourceInstanceId>.sqlite`, see
   *     `resolveCollectorQueuePath`), so a spool sited beside them is shared by
   *     every connection while the sweep sees only the caller's own rows. A
   *     digest another connection still owes reads as unreferenced. Before this
   *     can be enabled, either give each queue its own spool, or build the
   *     reference set from every queue sharing the spool — see
   *     {@link assertSpoolReferenceAuthorityIsComplete}.
   *
   * `minAgeMs` was intended as the answer to (1) and is not; see
   * {@link DEFAULT_SPOOL_RECLAIM_MIN_AGE_MS}.
   *
   * Retained here rather than deleted so the sweep's shape and its tests stay
   * available to whoever builds that contract. It is off by default and callers
   * must pass `acknowledgeUnsafe: true` to run it at all.
   *
   * The sweep's own logic — the part that a correct contract would preserve —
   * was unsafe for two further reasons that ARE resolved, and that a future
   * repair must not reintroduce:
   *
   *  1. **A body can be shared.** The spool is content-addressed, so identical
   *     content captured under different record coordinates yields several
   *     `blob_upload` rows over ONE on-disk body. Deleting it when the first
   *     upload succeeded destroyed the bytes the other rows still owed, and
   *     because missing spool bytes are classified TERMINAL, those rows
   *     dead-lettered permanently through the ordinary retry path.
   *  2. **Deletion must follow durable acknowledgement.** Deleting inside the
   *     send, before the outbox row is marked `succeeded`, leaves a window
   *     where a stop makes a still-pending row bodiless. Reclaiming from the
   *     committed queue state instead of from in-flight control flow removes
   *     the window rather than narrowing it: there is no interval in which the
   *     bytes are gone and the obligation is not yet recorded as met.
   *
   * `outstandingDigests` is the set of digests still claimed by a
   * non-`succeeded` `blob_upload` row — see
   * `LocalDeviceOutbox.outstandingBlobDigests`. Anything in it is kept.
   *
   * Using absence-of-reference (rather than presence-of-success) as the
   * reclaim signal is also what makes this safe against pruning: `pruneSent`
   * deletes acknowledged rows, so "delivered" evidence is not permanent, while
   * "still owed" evidence is. An unreferenced body is one that is either
   * delivered or pruned after delivery — reclaimable in both cases.
   *
   * `minAgeMs` only skips entries whose observed mtime is younger than it. It
   * is NOT a safety property: see defect (1) above and
   * {@link DEFAULT_SPOOL_RECLAIM_MIN_AGE_MS}.
   */
  async reclaimUnreferencedUnsafe(input: {
    /**
     * Must be `true`. Exists so no caller reaches this sweep without naming
     * the hazard at the call site; `reclaimDrainedBlobSpool` does not pass it
     * unless a test opts in explicitly.
     */
    acknowledgeUnsafe: true;
    minAgeMs?: number;
    outstandingDigests: ReadonlySet<string>;
  }): Promise<LocalDeviceBlobSpoolReclaimResult> {
    if (input.acknowledgeUnsafe !== true) {
      throw new Error(
        "reclaimUnreferencedUnsafe requires acknowledgeUnsafe: true — this sweep can delete a concurrently recaptured body"
      );
    }
    const minAgeMs = input.minAgeMs ?? DEFAULT_SPOOL_RECLAIM_MIN_AGE_MS;
    const now = Date.now();
    const result: LocalDeviceBlobSpoolReclaimResult = {
      bytesReclaimed: 0,
      reclaimed: 0,
      retainedReferenced: 0,
      retainedTooRecent: 0,
    };
    let shards: string[];
    try {
      shards = await readdir(this.#objectsDir());
    } catch {
      return result;
    }
    for (const shard of shards) {
      let names: string[];
      try {
        names = await readdir(join(this.#objectsDir(), shard));
      } catch {
        continue;
      }
      for (const name of names) {
        const sha256 = `${shard}${name}`;
        if (input.outstandingDigests.has(sha256)) {
          result.retainedReferenced += 1;
          continue;
        }
        const path = join(this.#objectsDir(), shard, name);
        try {
          const stats = await stat(path);
          if (!isOlderThan(stats.mtimeMs, minAgeMs, now)) {
            result.retainedTooRecent += 1;
            continue;
          }
          rmSync(path, { force: true });
          result.reclaimed += 1;
          result.bytesReclaimed += stats.size;
        } catch {
          // Gone already, or unreadable. Never treat that as reclaimed.
        }
      }
    }
    return result;
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
    const now = Date.now();
    let swept = 0;
    for (const name of names) {
      const path = join(this.#tempDir(), name);
      try {
        if (isOlderThan((await stat(path)).mtimeMs, olderThanMs, now)) {
          rmSync(path, { force: true });
          swept += 1;
        }
      } catch {
        // Already gone, or owned by a live writer. Leave it.
      }
    }
    return swept;
  }

  /**
   * Flush a directory entry so the name of a just-renamed file is durable.
   *
   * Content `fsync` makes the bytes survive; it does not make the link that
   * reaches them survive. Both are needed for power-loss durability. A failure
   * here is surfaced by the caller rather than swallowed: an unsyncable
   * directory means the commit cannot be claimed as durable.
   */
  #syncDir(path: string): void {
    const fd = openSync(path, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
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
