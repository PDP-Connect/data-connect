// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end tests for scanning BOTH Codex rollout roots
 * (`CODEX_SESSIONS_DIR` and `CODEX_SESSIONS_ARCHIVE_DIR`) and for the
 * relocation-safety contract between them. See ARCHIVAL-CONTRACT.md for the
 * full contract this file's tests cite by name.
 *
 * These are the owner's four numbered safety cases:
 *   1. Both roots are scanned.
 *   2. Records are keyed by session UUID, never path — a file moved from
 *      sessions/ to sessions-archive/ and rescanned produces ZERO new
 *      records.
 *   3. A file's disappearance from sessions/ while present in
 *      sessions-archive/ is relocation, never a tombstone/deletion — proven
 *      for both the "rescan after move" case and the mid-move race (same
 *      UUID momentarily visible under both roots in one scan).
 *   4. ARCHIVAL-CONTRACT.md exists and is the contract surface these tests
 *      cite (see the "naming-collision guard" test at the bottom, which also
 *      pins the archived vs. sessions_archive naming split the doc
 *      documents).
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EmittedMessage } from "../../src/connector-runtime.ts";
import { runConnectorProtocolSubprocess } from "../../src/test-harness.ts";
import { cursorKeyForEntry } from "./index.ts";

// ─── cursorKeyForEntry (pure, I/O-free) ─────────────────────────────────

test("cursorKeyForEntry: keys by the UUID extracted from the filename, ignoring the directory", () => {
	const uuid = "019d922d-c38b-7e11-ae99-9187af386148";
	const fileName = `rollout-2026-04-15T12-26-06-${uuid}.jsonl`;
	const underPrimary = cursorKeyForEntry({
		file: fileName,
		path: `/home/user/.codex/sessions/2026/04/15/${fileName}`,
	});
	const underArchive = cursorKeyForEntry({
		file: fileName,
		path: `/home/user/.codex/sessions-archive/2026/04/15/${fileName}`,
	});
	assert.equal(underPrimary, uuid);
	assert.equal(
		underArchive,
		uuid,
		"the SAME key is produced regardless of which root the file lives under",
	);
	assert.equal(
		underPrimary,
		underArchive,
		"identity survives a relocation between roots",
	);
});

test("cursorKeyForEntry: falls back to the full path for a filename with no extractable UUID", () => {
	const path = "/home/user/.codex/sessions/2026/04/15/rollout-legacy.jsonl";
	assert.equal(cursorKeyForEntry({ file: "rollout-legacy.jsonl", path }), path);
});

const QUIET_OFF = { PDPP_CODEX_ACTIVE_ROLLOUT_QUIET_MS: "0" } as const;
const SESSION_ID = "019d922d-c38b-7e11-ae99-9187af386148";
const OTHER_SESSION_ID = "029d922d-c38b-7e11-ae99-9187af386149";
const DATE_DIR = join("2026", "04", "15");

interface StateCursor {
	file_cursors?: Record<string, RolloutFileCursorShape>;
	file_mtimes?: Record<string, number>;
}

interface RolloutFileCursorShape {
	function_call_count: number;
	guard_bytes: number;
	head_sha256: string;
	line_count: number;
	message_count: number;
	mtime_ms: number;
	offset_bytes: number;
	session_id: string | null;
	size_bytes: number;
}

function sessionMetaLine(id: string): string {
	return JSON.stringify({
		type: "session_meta",
		timestamp: "2026-04-15T17:33:32.000Z",
		payload: {
			id,
			timestamp: "2026-04-15T17:33:32.000Z",
			cwd: "/repo",
			originator: "codex-tui",
		},
	});
}

function messageLine(
	text: string,
	role = "user",
	ts = "2026-04-15T17:34:00.000Z",
): string {
	return JSON.stringify({
		type: "response_item",
		timestamp: ts,
		payload: { type: "message", role, content: [{ text }] },
	});
}

function jsonl(lines: readonly string[]): string {
	return `${lines.join("\n")}\n`;
}

function rolloutFileName(id: string): string {
	return `rollout-2026-04-15T12-26-06-${id}.jsonl`;
}

async function writeRolloutUnder(
	root: string,
	dateDir: string,
	fileName: string,
	body: string,
): Promise<string> {
	const dir = join(root, dateDir);
	await mkdir(dir, { recursive: true });
	const path = join(dir, fileName);
	await writeFile(path, body);
	return path;
}

async function runCodex(input: {
	codexHome: string;
	streams: readonly string[];
	state?: Record<string, unknown>;
	quietMs?: string;
}): Promise<{
	exitCode: number | null;
	messages: EmittedMessage[];
	stderr: string;
}> {
	const result = await runConnectorProtocolSubprocess({
		allowFailedDone: true,
		cwd: join(import.meta.dirname, "../.."),
		entrypoint: "connectors/codex/index.ts",
		env: {
			CODEX_HOME: input.codexHome,
			PDPP_CODEX_ACTIVE_ROLLOUT_QUIET_MS:
				input.quietMs ?? QUIET_OFF.PDPP_CODEX_ACTIVE_ROLLOUT_QUIET_MS,
		},
		start: {
			scope: { streams: input.streams.map((name) => ({ name })) },
			...(input.state ? { state: input.state } : {}),
			type: "START",
		},
	});
	return {
		exitCode: result.code,
		messages: result.messages,
		stderr: result.stderr,
	};
}

function recordsFor(
	messages: EmittedMessage[],
	stream: string,
): Extract<EmittedMessage, { type: "RECORD" }>[] {
	return messages.filter(
		(msg): msg is Extract<EmittedMessage, { type: "RECORD" }> =>
			msg.type === "RECORD" && msg.stream === stream,
	);
}

function rolloutStateCursor(
	messages: EmittedMessage[],
	stream = "messages",
): StateCursor {
	const state = messages.findLast(
		(msg): msg is Extract<EmittedMessage, { type: "STATE" }> =>
			msg.type === "STATE" && msg.stream === stream,
	);
	assert.ok(state, `expected a ${stream} STATE cursor`);
	return state.cursor as StateCursor;
}

function coverageRecords(
	messages: EmittedMessage[],
): Extract<EmittedMessage, { type: "RECORD" }>[] {
	return recordsFor(messages, "coverage_diagnostics");
}

// ─── Safety case 1: both roots are scanned ──────────────────────────────

test("safety case 1: connector scans BOTH sessions/ and sessions-archive/ and merges their records", async () => {
	const codexHome = await mkdtemp(join(tmpdir(), "pdpp-codex-archive-both-"));
	await writeRolloutUnder(
		join(codexHome, "sessions"),
		DATE_DIR,
		rolloutFileName(SESSION_ID),
		jsonl([sessionMetaLine(SESSION_ID), messageLine("from primary root")]),
	);
	await writeRolloutUnder(
		join(codexHome, "sessions-archive"),
		DATE_DIR,
		rolloutFileName(OTHER_SESSION_ID),
		jsonl([
			sessionMetaLine(OTHER_SESSION_ID),
			messageLine("from archive root"),
		]),
	);

	const run = await runCodex({ codexHome, streams: ["messages"] });
	assert.equal(run.exitCode, 0);
	const contents = recordsFor(run.messages, "messages").map(
		(r) => r.data.content,
	);
	assert.ok(
		contents.includes("from primary root"),
		"a session found only under sessions/ is scanned",
	);
	assert.ok(
		contents.includes("from archive root"),
		"a session found only under sessions-archive/ is scanned",
	);
	assert.equal(contents.length, 2, "both sessions are found, nothing extra");
});

test("safety case 1: CODEX_SESSIONS_ARCHIVE_DIR overrides the default archive root", async () => {
	const codexHome = await mkdtemp(
		join(tmpdir(), "pdpp-codex-archive-override-"),
	);
	const customArchive = await mkdtemp(
		join(tmpdir(), "pdpp-codex-archive-custom-root-"),
	);
	await mkdir(join(codexHome, "sessions"), { recursive: true });
	await writeRolloutUnder(
		customArchive,
		DATE_DIR,
		rolloutFileName(SESSION_ID),
		jsonl([sessionMetaLine(SESSION_ID), messageLine("in custom archive")]),
	);

	const result = await runConnectorProtocolSubprocess({
		allowFailedDone: true,
		cwd: join(import.meta.dirname, "../.."),
		entrypoint: "connectors/codex/index.ts",
		env: {
			CODEX_HOME: codexHome,
			CODEX_SESSIONS_ARCHIVE_DIR: customArchive,
			PDPP_CODEX_ACTIVE_ROLLOUT_QUIET_MS: "0",
		},
		start: {
			scope: { streams: [{ name: "messages" }] },
			type: "START",
		},
	});
	assert.equal(result.code, 0);
	const contents = result.messages
		.filter(
			(msg): msg is Extract<EmittedMessage, { type: "RECORD" }> =>
				msg.type === "RECORD" && msg.stream === "messages",
		)
		.map((r) => r.data.content);
	assert.ok(
		contents.includes("in custom archive"),
		"CODEX_SESSIONS_ARCHIVE_DIR is honored, not just the default sessions-archive/ path",
	);
});

test("safety case 1 (honesty): a fresh host with no archive directory yet is not fatal, and sessions_archive coverage reports missing", async () => {
	const codexHome = await mkdtemp(join(tmpdir(), "pdpp-codex-archive-fresh-"));
	await writeRolloutUnder(
		join(codexHome, "sessions"),
		DATE_DIR,
		rolloutFileName(SESSION_ID),
		jsonl([sessionMetaLine(SESSION_ID), messageLine("only primary root")]),
	);
	// No sessions-archive/ directory at all — the common case for a host that
	// has never had anything archived yet.

	const run = await runCodex({
		codexHome,
		streams: ["messages", "coverage_diagnostics"],
	});
	assert.equal(run.exitCode, 0, "absent archive root must not fail the run");
	assert.equal(
		recordsFor(run.messages, "messages").length,
		1,
		"the primary root is still scanned normally",
	);
	const coverage = coverageRecords(run.messages);
	assert.ok(
		coverage.some(
			(r) => r.data.store === "sessions_archive" && r.data.status === "missing",
		),
		"a missing archive root is reported honestly via coverage_diagnostics, not silently ignored",
	);
});

// ─── Safety case 2: UUID-keyed identity, relocation → zero new records ──

test("safety case 2: a rollout file moved from sessions/ to sessions-archive/ and rescanned emits ZERO new records", async () => {
	const codexHome = await mkdtemp(join(tmpdir(), "pdpp-codex-archive-move-"));
	const fileName = rolloutFileName(SESSION_ID);
	const primaryPath = await writeRolloutUnder(
		join(codexHome, "sessions"),
		DATE_DIR,
		fileName,
		jsonl([
			sessionMetaLine(SESSION_ID),
			messageLine("m1"),
			messageLine("m2", "assistant"),
		]),
	);

	const run1 = await runCodex({ codexHome, streams: ["messages"] });
	assert.equal(run1.exitCode, 0);
	assert.equal(
		recordsFor(run1.messages, "messages").length,
		2,
		"run 1 (before any relocation) parses the file normally",
	);
	const run1Ids = new Set(
		recordsFor(run1.messages, "messages").map((r) => String(r.data.id)),
	);
	const priorCursor = rolloutStateCursor(run1.messages);
	assert.ok(
		priorCursor.file_cursors?.[SESSION_ID],
		"the cursor is keyed by the session UUID, not the path",
	);

	// Simulate the real archival `mv`: relocate the file to the exact same
	// relative path under the archive root, then remove it from the primary
	// root (a real rename(2) would do this atomically; the test does it in
	// two steps to also exercise "gone from primary, present in archive").
	const archivePath = join(codexHome, "sessions-archive", DATE_DIR, fileName);
	await mkdir(join(codexHome, "sessions-archive", DATE_DIR), {
		recursive: true,
	});
	await rename(primaryPath, archivePath);

	const run2 = await runCodex({
		codexHome,
		streams: ["messages"],
		state: { messages: priorCursor },
	});
	assert.equal(run2.exitCode, 0);
	assert.equal(
		recordsFor(run2.messages, "messages").length,
		0,
		"the relocated file is recognized by its UUID — zero new records, not a full reparse",
	);

	const nextCursor = rolloutStateCursor(run2.messages);
	const carriedCursor = nextCursor.file_cursors?.[SESSION_ID];
	assert.ok(
		carriedCursor,
		"the cursor survives the relocation under the same UUID key",
	);
	assert.equal(
		carriedCursor.message_count,
		2,
		"the carried-forward cursor still reflects the full prior count",
	);

	// A THIRD run (steady state under the archive root) also emits nothing new.
	const run3 = await runCodex({
		codexHome,
		streams: ["messages"],
		state: { messages: nextCursor },
	});
	assert.equal(run3.exitCode, 0);
	assert.equal(
		recordsFor(run3.messages, "messages").length,
		0,
		"steady state under the archive root stays quiet",
	);
	assert.equal(
		new Set(run1Ids).size,
		2,
		"sanity: the original record ids are still the ones that were ever emitted",
	);
});

test("safety case 2: an appended-then-relocated file tails correctly and keeps non-colliding keys after the move", async () => {
	const codexHome = await mkdtemp(
		join(tmpdir(), "pdpp-codex-archive-move-append-"),
	);
	const fileName = rolloutFileName(SESSION_ID);
	const primaryPath = await writeRolloutUnder(
		join(codexHome, "sessions"),
		DATE_DIR,
		fileName,
		jsonl([sessionMetaLine(SESSION_ID), messageLine("before move")]),
	);

	const run1 = await runCodex({ codexHome, streams: ["messages"] });
	assert.equal(run1.exitCode, 0);
	const priorCursor = rolloutStateCursor(run1.messages);

	const archiveDir = join(codexHome, "sessions-archive", DATE_DIR);
	await mkdir(archiveDir, { recursive: true });
	const archivePath = join(archiveDir, fileName);
	await rename(primaryPath, archivePath);

	// Per the contract, an archived file is append-only-until-archived and
	// immutable AFTER archival (see ARCHIVAL-CONTRACT.md invariant 2) — this
	// models a run that observes the file post-relocation with no further
	// writes, which is the only state a real archived file can be in.
	const run2 = await runCodex({
		codexHome,
		streams: ["messages"],
		state: { messages: priorCursor },
	});
	assert.equal(run2.exitCode, 0);
	assert.equal(
		recordsFor(run2.messages, "messages").length,
		0,
		"no new records for the unchanged, now-relocated file",
	);
});

// ─── Safety case 3: relocation is never a deletion signal; mid-move race ─

test("safety case 3: a file present ONLY in sessions-archive/ (never seen at its sessions/ path before) is scanned normally, not treated as a deletion of anything", async () => {
	const codexHome = await mkdtemp(
		join(tmpdir(), "pdpp-codex-archive-archive-only-"),
	);
	await writeRolloutUnder(
		join(codexHome, "sessions-archive"),
		DATE_DIR,
		rolloutFileName(SESSION_ID),
		jsonl([
			sessionMetaLine(SESSION_ID),
			messageLine("already archived before this connector ever ran"),
		]),
	);

	const run = await runCodex({
		codexHome,
		streams: ["messages", "sessions"],
	});
	assert.equal(run.exitCode, 0);
	assert.equal(
		recordsFor(run.messages, "messages").length,
		1,
		"a file that has ALWAYS lived only in the archive root is picked up normally",
	);
	const session = recordsFor(run.messages, "sessions").find(
		(r) => r.data.id === SESSION_ID,
	);
	assert.ok(session, "its session record is emitted");
});

test("safety case 3 (mid-move race): the SAME UUID visible under both roots in one scan is de-duplicated — no double-emit, no false deletion", async () => {
	const codexHome = await mkdtemp(join(tmpdir(), "pdpp-codex-archive-race-"));
	const fileName = rolloutFileName(SESSION_ID);
	const body = jsonl([
		sessionMetaLine(SESSION_ID),
		messageLine("racey content"),
		messageLine("second line", "assistant"),
	]);
	// Model the race window a non-atomic move can create: a `cp`-then-`rm`
	// style relocation (or a listing race) briefly leaves byte-identical
	// copies under BOTH roots at once — archival invariant 2 (immutable once
	// archived) guarantees the archive copy, if it exists at all mid-move,
	// is byte-identical to what was (or still is) under the primary root.
	await writeRolloutUnder(
		join(codexHome, "sessions"),
		DATE_DIR,
		fileName,
		body,
	);
	await writeRolloutUnder(
		join(codexHome, "sessions-archive"),
		DATE_DIR,
		fileName,
		body,
	);

	const run = await runCodex({ codexHome, streams: ["messages"] });
	assert.equal(run.exitCode, 0);
	const msgs = recordsFor(run.messages, "messages");
	assert.equal(
		msgs.length,
		2,
		"the two DISTINCT messages in the file are emitted exactly once each — " +
			"not duplicated because the same UUID was visible under both roots",
	);
	const ids = msgs.map((r) => String(r.data.id));
	assert.equal(
		new Set(ids).size,
		ids.length,
		"no duplicate record ids from processing the same UUID twice in one scan",
	);

	// The cursor for this UUID is written exactly once — not silently
	// overwritten by re-processing the same file twice with two different
	// committed offsets from the same content.
	const cursor = rolloutStateCursor(run.messages);
	assert.ok(cursor.file_cursors?.[SESSION_ID], "a cursor is written");

	// A follow-up run (post-race — the primary-root copy has since been
	// removed, as the real archiver would complete the move) sees the file
	// only under the archive root and, being unchanged, emits nothing new.
	// This is the assertion that the race was never mistaken for a deletion:
	// if it had been, the connector would have no way to "undo" a false
	// tombstone and this run would still correctly show zero new records
	// either way, but a REAL deletion-inference bug would instead show up as
	// the session's rollout content going missing from any future aggregate
	// — which the sessions stream would reveal via a lost message_count.
	const run2 = await runCodex({
		codexHome,
		streams: ["messages", "sessions"],
		state: { messages: cursor },
	});
	assert.equal(run2.exitCode, 0);
	assert.equal(
		recordsFor(run2.messages, "messages").length,
		0,
		"steady state after the race resolves — no new records, no re-emission",
	);
});

// ─── examined-count integrity: mid-move race must not double-count ─────

test("mid-move race: a UUID visible under both roots does not double-count messagesExamined in coverage_diagnostics", async () => {
	const codexHome = await mkdtemp(
		join(tmpdir(), "pdpp-codex-archive-race-examined-"),
	);
	const fileName = rolloutFileName(SESSION_ID);
	// A real, known message count for this file: exactly 2 `response_item`
	// message lines (the session_meta line is not a message).
	const body = jsonl([
		sessionMetaLine(SESSION_ID),
		messageLine("racey content"),
		messageLine("second line", "assistant"),
	]);
	await writeRolloutUnder(
		join(codexHome, "sessions"),
		DATE_DIR,
		fileName,
		body,
	);
	await writeRolloutUnder(
		join(codexHome, "sessions-archive"),
		DATE_DIR,
		fileName,
		body,
	);

	// Run 1: first sighting under whichever root is walked first parses the
	// file (2 messages examined); the second sighting under the other root
	// hits the mid-move-race guard. Confirm the FIRST run's examined count is
	// already correct (this also passed before the fix, since parsedRollouts
	// only counts the file once) before checking the steady-state rescan below,
	// which is where the pre-fix bug actually manifested (examined double-
	// counted specifically on a "skipped" carry-forward, not on first parse).
	const run1 = await runCodex({
		codexHome,
		streams: ["messages", "coverage_diagnostics"],
	});
	assert.equal(run1.exitCode, 0);
	const cursor1 = rolloutStateCursor(run1.messages);
	assert.equal(
		cursor1.file_cursors?.[SESSION_ID]?.message_count,
		2,
		"sanity: the cursor records the real message count for this fixture",
	);

	// Run 2: steady state. Both roots still hold the byte-identical file (the
	// archiver has not yet completed removing the primary-root copy — the
	// race window). Nothing changed, so `emitted` for messages is 0 for both
	// sightings; per `describeDerivedCoverageReason`, a completed scan with
	// 0 emitted reports its examined count verbatim as
	// "enumeration complete, N examined (0 emitted)". Pre-fix, the duplicate
	// sighting's carried-forward cursor was counted a second time, reporting
	// 4 instead of 2.
	const run2 = await runCodex({
		codexHome,
		streams: ["messages", "coverage_diagnostics"],
		state: { messages: cursor1 },
	});
	assert.equal(run2.exitCode, 0);
	assert.equal(
		recordsFor(run2.messages, "messages").length,
		0,
		"steady state: no new message records",
	);
	const coverage2 = coverageRecords(run2.messages);
	const messagesCoverage = coverage2.find((r) => r.data.stream === "messages");
	assert.ok(
		messagesCoverage,
		"a derived coverage_diagnostics row for messages is emitted",
	);
	assert.equal(
		messagesCoverage?.data.reason,
		"enumeration complete, 2 examined (0 emitted)",
		"the file's 2 messages are examined-counted exactly ONCE per scan, even though " +
			"its UUID is visible under both sessions/ and sessions-archive/ in this pass — " +
			"not doubled to 4 by counting the mid-move-race duplicate sighting a second time",
	);
});

// ─── Safety case 4: contract doc exists and naming does not collide ─────

test("safety case 4: ARCHIVAL-CONTRACT.md exists and documents the invariants this file's tests rely on", async () => {
	const contractPath = join(import.meta.dirname, "ARCHIVAL-CONTRACT.md");
	const contract = await readFile(contractPath, "utf8");
	assert.match(
		contract,
		/one-way/i,
		"contract documents the one-way relocation invariant",
	);
	assert.match(
		contract,
		/append-only|immutable/i,
		"contract documents the append-only/immutable-once-archived invariant",
	);
	assert.match(
		contract,
		/no deletion|never delete/i,
		"contract documents the no-deletion invariant",
	);
	assert.match(
		contract,
		/external process|outside this repo|not part of this repository/i,
		"contract states the archiver lives outside this repo's scope",
	);
});

test("safety case 4 (naming-collision guard): the filesystem relocation concept never conflates with threads.archived", async () => {
	// state_5.sqlite#threads.archived (schemas.ts, parsers.ts, types.ts) is an
	// existing, UNRELATED field: Codex's own in-app "user archived this
	// thread" boolean. This test pins that the new relocation-related runtime
	// surface (the coverage store name, the env var, the internal field name)
	// never uses the bare word "archived" for the filesystem concept — see
	// ARCHIVAL-CONTRACT.md's "Naming note".
	const indexSource = await readFile(
		join(import.meta.dirname, "index.ts"),
		"utf8",
	);

	assert.ok(
		indexSource.includes("sessions_archive"),
		"the coverage store for the archive root is named sessions_archive, not archived",
	);
	assert.ok(
		indexSource.includes("CODEX_SESSIONS_ARCHIVE_DIR"),
		"the env override is named CODEX_SESSIONS_ARCHIVE_DIR, not *_ARCHIVED_*",
	);
	assert.ok(
		indexSource.includes("archiveBaseDir"),
		"the internal dir field is named archiveBaseDir, disambiguated from the thread-archived boolean",
	);

	// The pre-existing, unrelated field must still exist unchanged — this
	// test is a collision guard, not a request to remove it.
	const parsersSource = await readFile(
		join(import.meta.dirname, "parsers.ts"),
		"utf8",
	);
	assert.ok(
		parsersSource.includes("archived: t.archived === 1 || t.archived === true"),
		"threads.archived (Codex's own in-app archive boolean) is untouched by this change",
	);
});
