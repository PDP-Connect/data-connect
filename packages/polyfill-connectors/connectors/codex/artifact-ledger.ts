// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The rollout bodies this run still owes, tracked SEPARATELY from the byte
 * offsets that gate parsing.
 *
 * This is the Codex half of the same rule `ArtifactCaptureLedger` states for
 * Claude Code (`src/artifact-capture.ts`), and the reasoning is identical: a
 * parse cursor records "these lines were turned into records", while a capture
 * records "these bytes are recoverable". Capture failure is reported rather
 * than thrown, so without separating the two a run could commit the offset,
 * skip the unchanged file on the next run, and never retry the body — a
 * visible gap that repaired itself only if Codex happened to append more.
 *
 * WHY the persisted encoding differs from Claude Code's: Claude checkpoints a
 * bare `file_mtimes[path]` NUMBER, so recording the capture fact there required
 * folding it into the number itself (`capturedBodyCheckpoint`'s 52-bit digest).
 * Codex already persists a rich `RolloutFileCursor` OBJECT per file, so the
 * same fact is carried by an explicit `captured_sha256` field. That is a
 * mechanical difference in where the fact is written, not a different rule:
 * both make "body is durably held" a distinct, persisted fact from "content was
 * enumerated", and both treat a value written before capture existed as "body
 * state unknown" so enabling capture backfills exactly once.
 *
 * Within a run the outstanding set withholds a file's captured marker so the
 * next run re-examines it. Across runs the set is empty again; the persisted
 * `captured_sha256` carries the obligation forward. Both are needed — the set
 * handles a failure seen this run, the field handles every run after.
 */

import type { ArtifactCaptureStatus } from "../../src/artifact-capture.ts";

export class CodexArtifactLedger {
	readonly #enabled: boolean;
	readonly #outstanding = new Set<string>();
	readonly #captured = new Map<string, string>();
	readonly #backfilled = new Set<string>();
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
	 * Counted at capture time only — see `hasUploadTransport` in
	 * `src/artifact-capture.ts` for why the obligation is reported rather than
	 * enqueued as a `blob_upload` outbox row. Reporting keeps a
	 * spooled-but-undelivered body VISIBLE instead of implying completion.
	 */
	get pendingUpload(): number {
		return this.#pendingUpload;
	}

	/** Note the outcome for one rollout file, keyed by its cursor key (UUID). */
	record(
		cursorKey: string,
		status: ArtifactCaptureStatus,
		sha256: string | null,
	): void {
		if (!this.#enabled) {
			return;
		}
		if (status === "captured" && sha256) {
			this.#outstanding.delete(cursorKey);
			this.#captured.set(cursorKey, sha256);
			this.#pendingUpload += 1;
			return;
		}
		this.#outstanding.add(cursorKey);
	}

	/** True when this file's body is still owed. */
	isOutstanding(cursorKey: string): boolean {
		return this.#outstanding.has(cursorKey);
	}

	/**
	 * Note that a body was captured WITHOUT reparsing its file — the skip path's
	 * backfill.
	 *
	 * Such a run builds no aggregate, so nothing in the ordinary emission path
	 * knows the session's stored row just became stale. Recording it here is what
	 * lets the run decide it owes a targeted session update, rather than leaving
	 * the digest visible only to the cursor.
	 */
	noteBackfilled(cursorKey: string): void {
		this.#backfilled.add(cursorKey);
	}

	/** Cursor keys whose bodies were backfilled by a skip-path capture this run. */
	get backfilled(): ReadonlySet<string> {
		return this.#backfilled;
	}

	/**
	 * The `captured_sha256` to persist for this file, or undefined to withhold
	 * it.
	 *
	 * Withholding for an outstanding artifact is what makes the next run retry
	 * this file. A run that cannot capture at all persists nothing, so it
	 * neither claims a capture it did not make nor erases one an earlier run
	 * legitimately recorded (`priorCaptured` carries that forward).
	 */
	capturedMarker(
		cursorKey: string,
		priorCaptured: string | undefined,
	): string | undefined {
		if (!this.#enabled) {
			return priorCaptured;
		}
		if (this.isOutstanding(cursorKey)) {
			return undefined;
		}
		return this.#captured.get(cursorKey) ?? priorCaptured;
	}

	/**
	 * Whether an unchanged file's body is already held, given what the last run
	 * persisted.
	 *
	 * When capture is enabled, only a recorded `captured_sha256` settles a file.
	 * Its absence means the body state is unknown — a pre-capture cursor, or a
	 * run that had no stores — so the file is revisited once to backfill. When
	 * capture is not enabled this is vacuously true, so a run that cannot
	 * capture does not re-read files it cannot help.
	 */
	isSettled(cursorKey: string, priorCaptured: string | undefined): boolean {
		if (this.isOutstanding(cursorKey)) {
			return false;
		}
		if (!this.#enabled) {
			return true;
		}
		return priorCaptured !== undefined;
	}

	get size(): number {
		return this.#outstanding.size;
	}
}
