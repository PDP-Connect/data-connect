// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Full-fidelity artifact capture for Claude Code.
 *
 * Session transcripts and tool-result sidecars are stored lossily today: an
 * attachment preview is 500 characters, a tool result is a bounded head
 * prefix, and the bytes past that window exist nowhere else. Claude Code
 * sessions have no native retention policy that would hold a second copy, so
 * a truncated projection is all that survives — the durable record cannot
 * reconstruct the session.
 *
 * This module routes artifact BODIES to blob storage while leaving every
 * existing inline field exactly as it was.
 *
 * **The inline fields are a search projection, not the body.** They are
 * deliberately preserved at their current sizes and coverage rather than
 * collapsed to a uniform preview — `MESSAGE_CONTENT_PREVIEW_CHARS` is 5000 and
 * shrinking it to 500 to match the others would be a regression in searchable
 * coverage, especially for file reads. The blob is the authoritative content;
 * the preview is what makes a record findable without fetching it.
 *
 * **Capture is durable or it is not claimed.** A capture returns only once the
 * complete bytes are committed to the local content-addressed spool. A record
 * therefore carries a `blob_ref` only when those bytes are already safe; it is
 * never written on the strength of an upload that might yet fail.
 *
 * Delivery upstream is a SEPARATE obligation, and while no transport exists it
 * is deliberately not enqueued — see `hasUploadTransport`. It is reported
 * instead, so a spooled-but-undelivered body is visible rather than implied.
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
	captureBlobArtifact,
	LocalDeviceBlobSpool,
	LocalDeviceOutbox,
} from "@pdpp/collector-runtime";
import { resolveArtifactCaptureEnv } from "../../src/artifact-capture-env.ts";

/**
 * Whether this run can actually deliver a spooled body upstream.
 *
 * WHY this gate exists: `captureBlobArtifact` does two things at once — it
 * commits bytes to the spool AND enqueues a `blob_upload` outbox row. The
 * second is an obligation against a transport. No transport is wired today
 * (`runCollectorConnector` accepts an optional `blobUpload`, and
 * `bin/collector-runner.ts` never supplies one), so the drain reaches
 * `sendBlobUploadItem`, throws `OutboxPayloadShapeError`, and that class is
 * classified TERMINAL — the row is dead-lettered on its first attempt with no
 * retry, and dead letters are never revisited or auto-pruned.
 *
 * That dead letter then halts the connector. The runtime's scan-admission
 * predicate treats any non-succeeded row outside `gap` / `terminal_run_commit`
 * as backlog, so every later run returns `skippedScanForBacklog` and scans
 * nothing: unchanged files, modified files and brand-new sessions alike. One
 * captured body was enough to stop collection permanently.
 *
 * Enqueuing an obligation against a transport that does not exist is what
 * manufactures that dead letter, so the repair is to not enqueue it. The bytes
 * are still committed to the spool exactly as before — durability is unchanged
 * — and the obligation is reported rather than discarded (see
 * `ArtifactCaptureLedger.pendingUpload`). When a transport is wired, this
 * predicate becomes true and the outbox row is enqueued as it is today.
 */
function hasUploadTransport(): boolean {
	return false;
}

/** Blob reference recorded alongside the preserved inline preview. */
export interface ArtifactBlobRef {
	blob_id: string;
	mime_type: string;
	sha256: string;
	size_bytes: number;
}

/**
 * Why an artifact body was not captured.
 *
 * Recorded on the record so an uncaptured body is visible rather than silently
 * absent. `unavailable` means no spool/outbox was wired into this run (for
 * example a fixture or dry-run context), which is a capability statement, not
 * a failure to hide.
 */
export type ArtifactCaptureStatus = "captured" | "failed" | "unavailable";

export interface ArtifactCaptureResult {
	/** sha256 of the complete body, known at spool time. Null when uncaptured. */
	sha256: string | null;
	status: ArtifactCaptureStatus;
}

export interface ArtifactCaptureContext {
	connectorId: string;
	connectorInstanceId?: string | null;
	outbox: OutboxLike;
	sourceInstanceId: string;
	spool: LocalDeviceBlobSpool;
}

/** The slice of `LocalDeviceOutbox` artifact capture needs. */
type OutboxLike = Parameters<typeof captureBlobArtifact>[0]["outbox"];

export interface CaptureFileArtifactInput {
	context: ArtifactCaptureContext | null;
	mimeType: string;
	/** Absolute path of the source file whose complete bytes are captured. */
	path: string;
	recordKey: string;
	stream: string;
}

/**
 * Capture one file's complete bytes, streaming from disk.
 *
 * The file is never materialised in memory: `createReadStream` feeds the spool
 * chunk by chunk, so a 64 MB tool-result costs a buffer per chunk rather than
 * 64 MB of heap. That matters at the observed scale — 3,541 tool-result files,
 * 1.0 GB total, mean 304 KB, largest 64 MB.
 *
 * Failures are reported, never thrown: one unreadable artifact must not abort
 * a whole session's collection. The caller records the returned status so the
 * gap is visible on the record itself.
 */
export async function captureFileArtifact(
	input: CaptureFileArtifactInput,
): Promise<ArtifactCaptureResult> {
	if (!input.context) {
		return { sha256: null, status: "unavailable" };
	}
	return await spoolArtifact({
		content: () => createReadStream(input.path),
		context: input.context,
		mimeType: input.mimeType,
		recordKey: input.recordKey,
		stream: input.stream,
	});
}

/**
 * Commit one artifact's bytes to the spool, enqueuing the upload obligation
 * only when a transport exists to discharge it.
 *
 * Shared by the file and inline paths because the durability rule is the same
 * for both: the caller may claim a capture only once the complete bytes are in
 * the content-addressed spool. `spool.put` is the operation that makes that
 * true, and it is the same call `captureBlobArtifact` makes first.
 *
 * Failures are reported, never thrown: one unreadable or unspoolable artifact
 * must not abort a whole session's collection.
 */
async function spoolArtifact(input: {
	content: () => Parameters<LocalDeviceBlobSpool["put"]>[0];
	context: ArtifactCaptureContext;
	mimeType: string;
	recordKey: string;
	stream: string;
}): Promise<ArtifactCaptureResult> {
	try {
		if (hasUploadTransport()) {
			const captured = await captureBlobArtifact({
				connectorId: input.context.connectorId,
				connectorInstanceId: input.context.connectorInstanceId ?? null,
				content: input.content(),
				mimeType: input.mimeType,
				outbox: input.context.outbox,
				recordKey: input.recordKey,
				sourceInstanceId: input.context.sourceInstanceId,
				spool: input.context.spool,
				stream: input.stream,
			});
			return { sha256: captured.sha256, status: "captured" };
		}
		const entry = await input.context.spool.put(input.content());
		return { sha256: entry.sha256, status: "captured" };
	} catch {
		// The body is not durably held, so the record must not claim it is.
		return { sha256: null, status: "failed" };
	}
}

/**
 * Capture an in-memory artifact body (an attachment extracted from a JSONL
 * line, which is already parsed and resident).
 */
export async function captureInlineArtifact(input: {
	content: string;
	context: ArtifactCaptureContext | null;
	mimeType: string;
	recordKey: string;
	stream: string;
}): Promise<ArtifactCaptureResult> {
	if (!input.context) {
		return { sha256: null, status: "unavailable" };
	}
	return await spoolArtifact({
		content: () => [Buffer.from(input.content, "utf8")],
		context: input.context,
		mimeType: input.mimeType,
		recordKey: input.recordKey,
		stream: input.stream,
	});
}

/** A capture context plus the handles that must be closed after the run. */
export interface OpenedArtifactCapture {
	close: () => void;
	context: ArtifactCaptureContext;
}

/**
 * Open the run's artifact stores from the environment the collector runner
 * supplied, or return null when this run has none.
 *
 * Null is the honest capability answer for a fixture or a caller that has not
 * opted in — capture then records `unavailable` rather than failing the run.
 * A store that is configured but unopenable is a different thing: that throws,
 * because silently downgrading to `unavailable` would hide a broken device.
 */
export function openArtifactCapture(input: {
	connectorId: string;
	env?: NodeJS.ProcessEnv;
}): OpenedArtifactCapture | null {
	const resolved = resolveArtifactCaptureEnv(input.env);
	if (!resolved) {
		return null;
	}
	const outbox = new LocalDeviceOutbox({ path: resolved.outboxPath });
	try {
		const spool = new LocalDeviceBlobSpool({ root: resolved.spoolRoot });
		return {
			close: () => outbox.close(),
			context: {
				connectorId: input.connectorId,
				connectorInstanceId: null,
				outbox,
				sourceInstanceId: resolved.sourceInstanceId,
				spool,
			},
		};
	} catch (error) {
		outbox.close();
		throw error;
	}
}

/**
 * Marker mixed into a checkpoint value to mean "the body behind this mtime is
 * durably held".
 *
 * The string is opaque and carries no provider or status vocabulary: it exists
 * only to make the captured encoding of an mtime differ from the raw mtime.
 */
const CAPTURED_BODY_MARKER = "pdpp.artifact.body.v1";

/**
 * Encode "this file was enumerated at `mtimeMs` AND its body is durably held".
 *
 * WHY the stored value is not the bare mtime: a bare mtime answers only "were
 * the previews enumerated", which is a strictly weaker fact than "are the bytes
 * safe". A run that captured nothing wrote the same value as a run that
 * captured everything, so the two were indistinguishable on the next run — the
 * reason enabling capture never backfilled. Folding the capture fact into the
 * value makes the checkpoint answer the question the skip gate actually asks.
 *
 * A 52-bit SHA-256 prefix is used rather than arithmetic tagging because
 * `mtimeMs` is FRACTIONAL on ext4 (measured: 1789331218360.598), so parity or
 * multiply-by-two tags are not total over the real input domain. 52 bits is the
 * widest integer a JS double holds exactly, and the value stays a `number`, so
 * the persisted `file_mtimes` cursor shape is untouched — this is the same
 * technique and the same reasoning as `contentGateValue` for the markdown
 * streams.
 *
 * A cursor written before this encoding existed holds the raw mtime. A 52-bit
 * digest colliding with that raw mtime is negligible, not impossible: nothing
 * in the construction forbids it, and a collision would simply skip that one
 * file's backfill. Such a file therefore mismatches ONCE in practice, is
 * revisited, captures, and is then checkpointed in the new encoding — a
 * one-time re-read per file, never a repeated one. That is the migration: it
 * needs no version flag, no new user setting and no status enum in shared
 * state.
 */
export function capturedBodyCheckpoint(mtimeMs: number): number {
	const digest = createHash("sha256")
		.update(`${CAPTURED_BODY_MARKER}:${mtimeMs}`, "utf8")
		.digest();
	// Divide rather than shift to drop the low 12 bits (Biome bans bitwise here).
	return Number(digest.readBigUInt64BE(0) / 4096n);
}

/**
 * The bodies this run still owes, tracked SEPARATELY from the file mtimes that
 * gate enumeration.
 *
 * The two obligations are genuinely different and were braided together
 * before: an mtime records "this file's previews were enumerated", while a
 * capture records "this file's bytes are durably held". Capture failure is
 * reported rather than thrown, so a run could checkpoint the mtime, skip the
 * unchanged file on the next run, and never retry the body — a visible gap
 * that repaired itself only if the source happened to be rewritten.
 *
 * Within a run, the outstanding set withholds exactly those files' checkpoints
 * so the next run re-examines them. ACROSS runs the ledger is empty again, so
 * the outstanding set alone cannot carry an obligation forward; the persisted
 * checkpoint value does that, via `capturedBodyCheckpoint`. Both are needed:
 * the set handles a failure seen this run, the encoding handles every run after.
 *
 * A run with no capture configured owes nothing it could act on: `enabled` is
 * false, the ledger stays empty, and enumeration checkpoints the plain mtime
 * exactly as it did before artifact capture existed. That plain value is also
 * what a later capture-enabled run recognises as "body state unknown", which is
 * what makes enabling capture backfill.
 */
export class ArtifactCaptureLedger {
	readonly #enabled: boolean;
	readonly #outstanding = new Set<string>();
	#pendingUpload = 0;

	constructor(options: { enabled: boolean }) {
		this.#enabled = options.enabled;
	}

	/** True when this run was asked to capture bodies at all. */
	get enabled(): boolean {
		return this.#enabled;
	}

	/**
	 * Bodies spooled this run whose upload is still owed.
	 *
	 * While no upload transport is wired, a captured body is durable locally but
	 * has not been delivered. That obligation used to be represented by a
	 * `blob_upload` outbox row, which halted the connector (see
	 * `hasUploadTransport`). Counting it here keeps the obligation VISIBLE in
	 * terminal reporting instead of making it disappear: a captured body without
	 * an upload is an honest partial state, and reporting it as complete would
	 * be the dishonest repair.
	 *
	 * SCOPE: this counts bodies spooled by THIS RUN only. It is not a queue
	 * length over all runs — a later run that skips an already-captured file
	 * reports zero while that retained body still sits in the spool. Wiring a
	 * transport therefore cannot use this number to find the work: bodies
	 * already settled by a captured checkpoint have to be reconciled from a
	 * durable record, not from this counter.
	 */
	get pendingUpload(): number {
		return this.#pendingUpload;
	}

	/** Note the outcome for one source file. */
	record(path: string, status: ArtifactCaptureStatus): void {
		if (!this.#enabled) {
			return;
		}
		if (status === "captured") {
			this.#outstanding.delete(path);
			if (!hasUploadTransport()) {
				this.#pendingUpload += 1;
			}
			return;
		}
		this.#outstanding.add(path);
	}

	/** True when this file's body is still owed. */
	isOutstanding(path: string): boolean {
		return this.#outstanding.has(path);
	}

	/**
	 * The value to checkpoint for a file enumerated at `mtimeMs`.
	 *
	 * Captured bodies get the stronger encoding; a run that cannot capture at all
	 * keeps writing the plain mtime, so it neither claims a capture it did not
	 * make nor churns the cursor of a run that was never asked to capture.
	 */
	checkpointValue(path: string, mtimeMs: number): number {
		if (!this.#enabled || this.isOutstanding(path)) {
			return mtimeMs;
		}
		return capturedBodyCheckpoint(mtimeMs);
	}

	/**
	 * Whether an unchanged file is settled, given what the last run checkpointed.
	 *
	 * When capture is enabled, only the captured encoding settles a file. A plain
	 * mtime means the body state is unknown — an old preview-only checkpoint, or
	 * a run that had no stores — so the file is revisited once to backfill.
	 * When capture is not enabled this collapses to the original mtime equality,
	 * so a run that cannot capture does not re-read files it cannot help.
	 */
	isSettled(
		path: string,
		stored: number | undefined,
		mtimeMs: number,
	): boolean {
		if (stored === undefined || this.isOutstanding(path)) {
			return false;
		}
		if (!this.#enabled) {
			return stored === mtimeMs || stored === capturedBodyCheckpoint(mtimeMs);
		}
		return stored === capturedBodyCheckpoint(mtimeMs);
	}

	get size(): number {
		return this.#outstanding.size;
	}
}

export { LocalDeviceBlobSpool, LocalDeviceOutbox };
