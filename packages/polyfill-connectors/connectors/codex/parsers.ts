// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Pure parsers for the Codex connector. Kept free of Node I/O so they can
// be unit-tested in isolation (see parsers.test.ts). The filesystem
// walker, sqlite reader, and JSONL iterator live in index.ts.

import {
	PDPP_PREVIEW_MAX_CHARS,
	safeTextPreview,
} from "@pdpp/connector-protocol/safe-text-preview";
import type {
	ParsedFrontmatter,
	RolloutAggregate,
	RolloutPayload,
	ThreadFingerprint,
	ThreadRow,
} from "./types.ts";

// ─── Constants & regexes (module-scope per Biome useTopLevelRegex) ──────

const FRONTMATTER_RE = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?([\s\S]*)$/;
export const YEAR_DIR_RE = /^\d{4}$/;
export const TWO_DIGIT_DIR_RE = /^\d{2}$/;
const LINE_SPLIT_RE = /\r?\n/;
const FRONTMATTER_KV_RE = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/;
export const RULES_SUFFIX_RE = /\.rules$/;
export const MD_SUFFIX_RE = /\.md$/;

// ─── Text preview ───────────────────────────────────────────────────────

export function textPreview(
	s: unknown,
	max = PDPP_PREVIEW_MAX_CHARS,
): string | null {
	const r = safeTextPreview(s, max);
	return r.preview;
}

// ─── Rollout payload text extraction ────────────────────────────────────

export function extractMessageText(payload: RolloutPayload): string | null {
	if (!(payload.content && Array.isArray(payload.content))) {
		return null;
	}
	const parts = payload.content.map((p) => p?.text).filter(Boolean);
	return parts.join("\n") || null;
}

export function payloadOutputPreview(
	output: unknown,
	max = PDPP_PREVIEW_MAX_CHARS,
): { preview: string | null; binaryReason: string | null } {
	let toPreview: unknown = output;
	if (typeof output !== "string" && output !== null && output !== undefined) {
		toPreview = JSON.stringify(output);
	}
	const r = safeTextPreview(toPreview, max);
	return {
		preview: r.preview,
		binaryReason: r.kind === "binary" ? r.reason : null,
	};
}

// ─── Epoch / ISO conversion ─────────────────────────────────────────────

export function epochToIso(sec: number | null | undefined): string | null {
	return Number.isFinite(sec) && typeof sec === "number" && sec > 0
		? new Date(sec * 1000).toISOString()
		: null;
}

// ─── Frontmatter parsing ────────────────────────────────────────────────

function stripSurroundingQuotes(value: string): string {
	if (
		(value.startsWith('"') && value.endsWith('"')) ||
		(value.startsWith("'") && value.endsWith("'"))
	) {
		return value.slice(1, -1);
	}
	return value;
}

function parseFrontmatterLine(
	line: string,
	meta: Record<string, string>,
): void {
	const kv = line.match(FRONTMATTER_KV_RE);
	if (!kv) {
		return;
	}
	const [, key] = kv;
	if (!key) {
		return;
	}
	meta[key] = stripSurroundingQuotes((kv[2] ?? "").trim());
}

export function parseFrontmatter(text: string): ParsedFrontmatter {
	const m = text.match(FRONTMATTER_RE);
	if (!m) {
		return { meta: {}, body: text };
	}
	const meta: Record<string, string> = {};
	for (const line of (m[1] ?? "").split(LINE_SPLIT_RE)) {
		parseFrontmatterLine(line, meta);
	}
	return { meta, body: m[2] ?? "" };
}

// ─── Rollout directory filtering ────────────────────────────────────────

export function isRolloutFile(name: string): boolean {
	return name.startsWith("rollout-") && name.endsWith(".jsonl");
}

// A real on-disk rollout filename looks like
// `rollout-2026-07-31T14-01-26-019fb98d-807f-7f62-9cbf-5950178318cc.jsonl`.
// The trailing UUID is byte-identical to the `session_id`/`id` field inside
// the file's first `session_meta` JSON line (confirmed empirically). This
// regex pulls it straight off the filename — no file I/O — so the rollout
// scan can identify a file by session UUID before ever opening it.
const ROLLOUT_FILENAME_UUID_RE =
	/-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

/**
 * Extract the trailing session UUID from a rollout filename, or `null` when
 * the name doesn't carry the expected suffix (e.g. a legacy/malformed file
 * name). This is a pure, I/O-free identity hint used to key the per-file
 * parse cursor by session UUID instead of by path, so a rollout file that is
 * later relocated (e.g. archived to a second root; see
 * ARCHIVAL-CONTRACT.md) is still recognized as the SAME file and is not
 * fully reparsed — the file's content-derived identity never changes even
 * when its location does.
 */
export function extractRolloutUuidFromFilename(name: string): string | null {
	const match = name.match(ROLLOUT_FILENAME_UUID_RE);
	return match?.[1]?.toLowerCase() ?? null;
}

// ─── Session record builders ────────────────────────────────────────────

export function buildThreadSessionRecord(
	id: string,
	t: ThreadRow,
	agg: RolloutAggregate | undefined,
	priorFingerprint?: ThreadFingerprint | null,
): Record<string, unknown> {
	// Counts source-of-truth precedence:
	//   1. Aggregate from THIS run's rollout parse (most accurate).
	//   2. Last-known count from the prior cursor — preserves real values
	//      across runs where state_5 mtime changed but the rollout file
	//      did not, so we don't overwrite a non-null count with null.
	//   3. null (genuinely unknown — session has no rollout history yet).
	const messageCount =
		agg?.messageCount ?? priorFingerprint?.message_count ?? null;
	const functionCallCount =
		agg?.functionCallCount ?? priorFingerprint?.function_call_count ?? null;
	return {
		id,
		cwd: t.cwd || null,
		originator: t.source || null,
		cli_version: t.cli_version || null,
		model_provider: t.model_provider || null,
		git_commit: t.git_sha || null,
		git_branch: t.git_branch || null,
		repository_url: t.git_origin_url || null,
		started_at:
			epochToIso(t.created_at) || agg?.meta?.timestamp || agg?.firstTs || null,
		last_event_at: epochToIso(t.updated_at) || agg?.lastTs || null,
		message_count: messageCount,
		function_call_count: functionCallCount,
		// Codex can stuff large assistant output into `title` and
		// `first_user_message`; cap to keep records reasonable.
		title: textPreview(t.title || null, 500),
		archived: t.archived === 1 || t.archived === true,
		tokens_used: t.tokens_used ?? null,
		first_user_message: textPreview(t.first_user_message || null, 2000),
		sandbox_policy: t.sandbox_policy || null,
		approval_mode: t.approval_mode || null,
		rollout_path: t.rollout_path || agg?.rolloutPath || null,
	};
}

export function buildRolloutOnlySessionRecord(
	id: string,
	agg: RolloutAggregate,
): Record<string, unknown> {
	const meta = agg.meta || {};
	return {
		id,
		cwd: meta.cwd || null,
		originator: meta.originator || null,
		cli_version: meta.cli_version || null,
		model_provider: meta.model_provider || null,
		git_commit: meta.git?.commit_hash || null,
		git_branch: meta.git?.branch || null,
		repository_url: meta.git?.repository_url || null,
		started_at: meta.timestamp || agg.firstTs,
		last_event_at: agg.lastTs,
		message_count: agg.messageCount,
		function_call_count: agg.functionCallCount,
		title: null,
		archived: null,
		tokens_used: null,
		first_user_message: null,
		sandbox_policy: null,
		approval_mode: null,
		rollout_path: agg.rolloutPath || null,
	};
}

// ─── Rules / prompts / skills line helpers ──────────────────────────────

export function splitRulesLines(text: string): string[] {
	return text.split(LINE_SPLIT_RE);
}

export function isSkippableRulesLine(line: string): boolean {
	return !line || line.startsWith("#");
}

export function buildRuleRecord(args: {
	ruleset: string;
	line: string;
	index: number;
	path: string;
	mtime: number;
}): Record<string, unknown> {
	return {
		id: `rules:${args.ruleset}:${args.index}`,
		ruleset: args.ruleset,
		rule_text: textPreview(args.line, 4000),
		rule_index: args.index,
		path: args.path,
		mtime_epoch: args.mtime,
	};
}

export function buildPromptRecord(args: {
	fileName: string;
	meta: Record<string, string>;
	body: string;
	path: string;
	mtimeMs: number;
}): Record<string, unknown> {
	const name = args.meta.name || args.fileName.replace(MD_SUFFIX_RE, "");
	return {
		id: `prompts:${args.fileName}`,
		name,
		description: args.meta.description || null,
		content: textPreview(args.body, 20_000),
		path: args.path,
		mtime_epoch: Math.floor(args.mtimeMs / 1000),
	};
}

export function buildSkillRecord(args: {
	dirName: string;
	meta: Record<string, string>;
	body: string;
	path: string;
	mtimeMs: number;
}): Record<string, unknown> {
	return {
		id: `skills:${args.dirName}`,
		name: args.meta.name || args.dirName,
		description: args.meta.description || null,
		content: textPreview(args.body, 20_000),
		path: args.path,
		mtime_epoch: Math.floor(args.mtimeMs / 1000),
	};
}

// ─── Rollout aggregate timestamp update ─────────────────────────────────

export interface TimestampRange {
	firstTs: string | null;
	lastTs: string | null;
}

export function extendTimestampRange(
	range: TimestampRange,
	ts: string | null,
): void {
	if (!ts) {
		return;
	}
	if (!range.firstTs || ts < range.firstTs) {
		range.firstTs = ts;
	}
	if (!range.lastTs || ts > range.lastTs) {
		range.lastTs = ts;
	}
}
