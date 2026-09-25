// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Pure parsers for the Claude Code connector. Kept free of Node I/O so
// they can be unit-tested in isolation (see parsers.test.ts). The file
// walker and JSONL iterator live in index.ts.

import { safeTextPreview } from "@pdpp/connector-protocol/safe-text-preview";
import type {
	ContentPart,
	ParsedFrontmatter,
	SessionAccumulator,
} from "./types.ts";

// ─── Constants ──────────────────────────────────────────────────────────

export const SHORT_PREVIEW_CHARS = 300;
export const ATTACHMENT_PREVIEW_CHARS = 500;
export const TOOL_RESULT_PREVIEW_CHARS = 500;
export const MESSAGE_CONTENT_PREVIEW_CHARS = 5000;
export const SKILL_BODY_MAX_CHARS = 20_000;
// Emit a PROGRESS every N lines to surface per-file progress on large transcripts.
export const LINE_PROGRESS_INTERVAL = 2000;
// Bytes per MB for size formatting.
export const BYTES_PER_MB = 1024 * 1024;
// Session dir names encode UUIDs; a plain regex matches the first two groups
// to avoid confusing projects dir contents with per-session subdirs.
export const SESSION_DIR_PREFIX_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-/;

// ─── Module-scoped regexes (Biome useTopLevelRegex) ─────────────────────

const CLAUDE_FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
const CLAUDE_FM_LINE_RE = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/;
const CLAUDE_FM_COMMENT_RE = /^\s*#/;
const CLAUDE_FM_INDENT_RE = /^\s+\S/;
const CLAUDE_FM_LEADING_WS_RE = /^\s+/;
const CLAUDE_FM_QUOTED_DOUBLE_RE = /^"([\s\S]*)"$/;
const CLAUDE_FM_QUOTED_SINGLE_RE = /^'([\s\S]*)'$/;
const CLAUDE_FM_COLLAPSE_WS_RE = /\s+/g;
const CLAUDE_FM_LINE_SPLIT_RE = /\r?\n/;
const CLAUDE_MD_SUFFIX_RE = /\.md$/i;

// ─── Previews ───────────────────────────────────────────────────────────

export function textPreview(
	s: unknown,
	max = SHORT_PREVIEW_CHARS,
): string | null {
	return safeTextPreview(s, max).preview;
}

export function truncateBody(
	body: string,
	max: number = SKILL_BODY_MAX_CHARS,
): string {
	return body.length > max ? body.slice(0, max) : body;
}

// ─── Content extraction (messages + attachments) ────────────────────────

function extractFromArrayPart(p: unknown): string {
	if (typeof p === "string") {
		return p;
	}
	const part = p as ContentPart | null;
	if (part?.type === "text" && part.text) {
		return part.text;
	}
	if (part?.type === "tool_use") {
		return `[tool_use: ${part.name || "unknown"}]`;
	}
	if (part?.type === "tool_result") {
		return "[tool_result]";
	}
	return "";
}

function extractFromArray(arr: unknown[]): string | null {
	const parts = arr.map(extractFromArrayPart).filter(Boolean);
	return parts.join("\n") || null;
}

function extractFromObject(obj: {
	content?: unknown;
	text?: unknown;
}): string | null {
	if (obj.content) {
		return extractContent(obj.content);
	}
	if (typeof obj.text === "string") {
		return obj.text;
	}
	return null;
}

export function extractContent(obj: unknown): string | null {
	if (!obj) {
		return null;
	}
	if (typeof obj === "string") {
		return obj;
	}
	if (Array.isArray(obj)) {
		return extractFromArray(obj);
	}
	if (typeof obj === "object") {
		return extractFromObject(obj as { content?: unknown; text?: unknown });
	}
	return null;
}

// ─── Frontmatter parsing ────────────────────────────────────────────────

function stripQuotes(value: string): string {
	return value
		.replace(CLAUDE_FM_QUOTED_DOUBLE_RE, "$1")
		.replace(CLAUDE_FM_QUOTED_SINGLE_RE, "$1")
		.trim();
}

function isBlockScalar(value: string): boolean {
	return value === ">" || value === "|" || value === ">-" || value === "|-";
}

interface BlockScalarResult {
	nextIndex: number;
	value: string;
}

function readBlockScalar(
	lines: string[],
	startIdx: number,
	marker: string,
): BlockScalarResult {
	const folded = marker.startsWith(">");
	const collected: string[] = [];
	let i = startIdx;
	while (i < lines.length) {
		const next = lines[i] ?? "";
		if (CLAUDE_FM_INDENT_RE.test(next) || next === "") {
			collected.push(next.replace(CLAUDE_FM_LEADING_WS_RE, ""));
			i += 1;
		} else {
			break;
		}
	}
	const value = folded
		? collected.join(" ").replace(CLAUDE_FM_COLLAPSE_WS_RE, " ").trim()
		: collected.join("\n").trim();
	return { nextIndex: i, value };
}

/**
 * Minimal YAML-ish frontmatter parser — no external deps.
 * Supports flat `key: value` pairs and folded multi-line values introduced
 * with `>` or `|`. Returns { frontmatter, body }.
 */
export function parseFrontmatter(text: string): ParsedFrontmatter {
	if (typeof text !== "string") {
		return { frontmatter: {}, body: text || "" };
	}
	const m = CLAUDE_FRONTMATTER_RE.exec(text);
	if (!m) {
		return { frontmatter: {}, body: text };
	}
	const rawFm = m[1] ?? "";
	const body = m[2] ?? "";
	const frontmatter: Record<string, string> = {};
	const lines = rawFm.split(CLAUDE_FM_LINE_SPLIT_RE);
	let i = 0;
	while (i < lines.length) {
		const line = lines[i] ?? "";
		if (!line.trim() || CLAUDE_FM_COMMENT_RE.test(line)) {
			i += 1;
			continue;
		}
		const kv = CLAUDE_FM_LINE_RE.exec(line);
		if (!kv) {
			i += 1;
			continue;
		}
		const key = kv[1] ?? "";
		const rawValue = kv[2] ?? "";
		if (isBlockScalar(rawValue)) {
			const { nextIndex, value } = readBlockScalar(lines, i + 1, rawValue);
			frontmatter[key] = value;
			i = nextIndex;
		} else {
			frontmatter[key] = stripQuotes(rawValue);
			i += 1;
		}
	}
	return { frontmatter, body };
}

// ─── Session accumulator construction ───────────────────────────────────

export function makeEmptySessionAccumulator(
	id: string,
	projectPath: string,
): SessionAccumulator {
	return {
		id,
		project_path: projectPath,
		cwd: null,
		git_branch: null,
		version: null,
		started_at: null,
		last_event_at: null,
		message_count: 0,
		title: null,
		user_type: null,
		entrypoint: null,
	};
}

interface ObservedFields {
	cwd: string | null;
	entrypoint: string | null;
	gitBranch: string | null;
	title: string | null;
	userType: string | null;
	version: string | null;
}

export function mergeSessionObservations(
	acc: SessionAccumulator,
	obs: ObservedFields,
): void {
	if (obs.cwd) {
		acc.cwd = obs.cwd;
	}
	if (obs.gitBranch) {
		acc.git_branch = obs.gitBranch;
	}
	if (obs.version) {
		acc.version = obs.version;
	}
	if (obs.userType) {
		acc.user_type = obs.userType;
	}
	if (obs.entrypoint) {
		acc.entrypoint = obs.entrypoint;
	}
	// First-non-null: Claude Code writes at most one `ai-title` row per
	// session (mirrors legacy `summarizeTranscript`'s `title = title || ...`).
	if (obs.title && !acc.title) {
		acc.title = obs.title;
	}
}

export function widenSessionTimeRange(
	acc: SessionAccumulator,
	firstTimestamp: string | null,
	lastTimestamp: string | null,
): void {
	if (firstTimestamp && (!acc.started_at || firstTimestamp < acc.started_at)) {
		acc.started_at = firstTimestamp;
	}
	if (
		lastTimestamp &&
		(!acc.last_event_at || lastTimestamp > acc.last_event_at)
	) {
		acc.last_event_at = lastTimestamp;
	}
}

// ─── Skill / slash-command record builders ──────────────────────────────

export function buildSkillRecord(args: {
	name: string;
	frontmatter: Record<string, string>;
	body: string;
	path: string;
	mtimeMs: number;
}): Record<string, unknown> {
	return {
		id: `skills:${args.name}`,
		name: args.frontmatter.name || args.name,
		description: args.frontmatter.description || null,
		source: "user",
		path: args.path,
		content: truncateBody(args.body),
		frontmatter: args.frontmatter,
		mtime_epoch: Math.floor(args.mtimeMs / 1000),
	};
}

export function buildMemoryNoteRecord(args: {
	projectDir: string;
	relPath: string;
	frontmatter: Record<string, string>;
	body: string;
	path: string;
	mtimeMs: number;
}): Record<string, unknown> {
	const fallbackName = args.relPath.replace(CLAUDE_MD_SUFFIX_RE, "");
	return {
		id: `memory_notes:${args.projectDir}/${args.relPath}`,
		project_path: args.projectDir,
		note_path: args.relPath,
		name: args.frontmatter.name || args.frontmatter.title || fallbackName,
		description: args.frontmatter.description || null,
		path: args.path,
		content: truncateBody(args.body),
		frontmatter: args.frontmatter,
		mtime_epoch: Math.floor(args.mtimeMs / 1000),
	};
}

export function buildSlashCommandRecord(args: {
	idPath: string;
	base: string;
	frontmatter: Record<string, string>;
	body: string;
	path: string;
	mtimeMs: number;
}): Record<string, unknown> {
	return {
		id: `commands:${args.idPath}`,
		name: args.frontmatter.name || args.base,
		description: args.frontmatter.description || null,
		path: args.path,
		content: truncateBody(args.body),
		frontmatter: args.frontmatter,
		mtime_epoch: Math.floor(args.mtimeMs / 1000),
	};
}

// ─── Project-dir scoping ────────────────────────────────────────────────

export function applyProjectDirScope(
	dirs: string[],
	include: readonly string[],
	exclude: readonly string[],
): string[] {
	let out = dirs;
	if (include.length) {
		out = out.filter((d) => include.some((s) => d.includes(s)));
	}
	if (exclude.length) {
		out = out.filter((d) => !exclude.some((s) => d.includes(s)));
	}
	return out;
}

export function parseCsvEnv(value: string | undefined): string[] {
	return (value || "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

// ─── Usage (stats-cache.json) ────────────────────────────────────────────

function readNonNegInt(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? Math.trunc(value)
		: null;
}

function readNonNegIntOrZero(value: unknown): number {
	return readNonNegInt(value) ?? 0;
}

function readStr(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

/** USD dollars (possibly fractional, from the CLI's own cost model) → cents. */
function usdToCents(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? Math.round(value * 100)
		: 0;
}

interface RawModelUsage {
	inputTokens?: unknown;
	outputTokens?: unknown;
	cacheReadInputTokens?: unknown;
	cacheCreationInputTokens?: unknown;
	webSearchRequests?: unknown;
	costUSD?: unknown;
	contextWindow?: unknown;
	maxOutputTokens?: unknown;
}

function buildModelUsageRecords(
	modelUsage: unknown,
): Record<string, unknown>[] {
	if (!modelUsage || typeof modelUsage !== "object") {
		return [];
	}
	return Object.entries(modelUsage as Record<string, unknown>).map(
		([model, raw]) => {
			const m = (raw ?? {}) as RawModelUsage;
			return {
				model,
				input_tokens: readNonNegIntOrZero(m.inputTokens),
				output_tokens: readNonNegIntOrZero(m.outputTokens),
				cache_read_input_tokens: readNonNegIntOrZero(m.cacheReadInputTokens),
				cache_creation_input_tokens: readNonNegIntOrZero(
					m.cacheCreationInputTokens,
				),
				web_search_requests: readNonNegIntOrZero(m.webSearchRequests),
				cost_usd_cents: usdToCents(m.costUSD),
				context_window: readNonNegInt(m.contextWindow),
				max_output_tokens: readNonNegInt(m.maxOutputTokens),
			};
		},
	);
}

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

interface RawDailyActivity {
	date?: unknown;
	messageCount?: unknown;
	sessionCount?: unknown;
	toolCallCount?: unknown;
}

function buildDailyActivityRecords(
	dailyActivity: unknown,
): Record<string, unknown>[] {
	if (!Array.isArray(dailyActivity)) {
		return [];
	}
	const out: Record<string, unknown>[] = [];
	for (const raw of dailyActivity) {
		const d = (raw ?? {}) as RawDailyActivity;
		const date = readStr(d.date);
		if (!(date && YMD_RE.test(date))) {
			continue;
		}
		out.push({
			date,
			message_count: readNonNegIntOrZero(d.messageCount),
			session_count: readNonNegIntOrZero(d.sessionCount),
			tool_call_count: readNonNegIntOrZero(d.toolCallCount),
		});
	}
	return out;
}

interface RawDailyModelTokens {
	date?: unknown;
	tokensByModel?: unknown;
}

function buildDailyModelTokensRecords(
	dailyModelTokens: unknown,
): Record<string, unknown>[] {
	if (!Array.isArray(dailyModelTokens)) {
		return [];
	}
	const out: Record<string, unknown>[] = [];
	for (const raw of dailyModelTokens) {
		const d = (raw ?? {}) as RawDailyModelTokens;
		const date = readStr(d.date);
		if (!(date && YMD_RE.test(date))) {
			continue;
		}
		const tokensByModel: Record<string, number> = {};
		if (d.tokensByModel && typeof d.tokensByModel === "object") {
			for (const [model, tokens] of Object.entries(
				d.tokensByModel as Record<string, unknown>,
			)) {
				tokensByModel[model] = readNonNegIntOrZero(tokens);
			}
		}
		out.push({ date, tokens_by_model: tokensByModel });
	}
	return out;
}

function buildHourCounts(hourCounts: unknown): Record<string, number> {
	const out: Record<string, number> = {};
	if (!(hourCounts && typeof hourCounts === "object")) {
		return out;
	}
	for (const [hour, count] of Object.entries(
		hourCounts as Record<string, unknown>,
	)) {
		out[hour] = readNonNegIntOrZero(count);
	}
	return out;
}

interface RawLongestSession {
	sessionId?: unknown;
	duration?: unknown;
	messageCount?: unknown;
	timestamp?: unknown;
}

function buildLongestSession(
	longestSession: unknown,
): Record<string, unknown> | null {
	if (!longestSession || typeof longestSession !== "object") {
		return null;
	}
	const l = longestSession as RawLongestSession;
	const durationMs = readNonNegInt(l.duration);
	return {
		session_id: readStr(l.sessionId),
		duration_seconds:
			durationMs === null ? null : Math.round(durationMs / 1000),
		message_count: readNonNegInt(l.messageCount),
		timestamp: readStr(l.timestamp),
	};
}

interface RawStatsCache {
	dailyActivity?: unknown;
	dailyModelTokens?: unknown;
	firstSessionDate?: unknown;
	hourCounts?: unknown;
	lastComputedDate?: unknown;
	longestSession?: unknown;
	modelUsage?: unknown;
	totalMessages?: unknown;
	totalSessions?: unknown;
	totalSpeculationTimeSavedMs?: unknown;
}

/**
 * Build the `usage` record from a parsed `stats-cache.json`. `raw` is
 * `null` when the file is absent — an honest `source: "stats-cache-missing"`
 * record with zeroed/empty aggregates, mirroring legacy `buildUsage`'s
 * missing-file branch, rather than skipping the stream entirely.
 */
export function buildUsageRecord(raw: unknown): Record<string, unknown> {
	if (!raw || typeof raw !== "object") {
		return {
			id: "usage:aggregate",
			total_sessions: null,
			total_messages: null,
			first_session_date: null,
			last_computed_date: null,
			total_speculation_time_saved_ms: null,
			total_cost_usd_cents: 0,
			currency: "USD",
			models: [],
			daily_activity: [],
			daily_model_tokens: [],
			hour_counts: {},
			longest_session: null,
			source: "stats-cache-missing",
		};
	}
	const stats = raw as RawStatsCache;
	const models = buildModelUsageRecords(stats.modelUsage);
	const totalCostUsdCents = models.reduce(
		(sum, m) => sum + (m.cost_usd_cents as number),
		0,
	);
	return {
		id: "usage:aggregate",
		total_sessions: readNonNegInt(stats.totalSessions),
		total_messages: readNonNegInt(stats.totalMessages),
		first_session_date: readStr(stats.firstSessionDate),
		last_computed_date: readStr(stats.lastComputedDate),
		total_speculation_time_saved_ms: readNonNegInt(
			stats.totalSpeculationTimeSavedMs,
		),
		total_cost_usd_cents: totalCostUsdCents,
		currency: "USD",
		models,
		daily_activity: buildDailyActivityRecords(stats.dailyActivity),
		daily_model_tokens: buildDailyModelTokensRecords(stats.dailyModelTokens),
		hour_counts: buildHourCounts(stats.hourCounts),
		longest_session: buildLongestSession(stats.longestSession),
		source: "stats-cache",
	};
}
