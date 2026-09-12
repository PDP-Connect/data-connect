// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Zod schemas for Claude Code stream records. Used for shape-check-before-emit
 * per docs/reference/connector-authoring-guide.md §3: records that don't match the
 * schema become SKIP_RESULT events instead of RECORD events.
 *
 * Claude Code's JSON is generally well-shaped (it's from the official CLI),
 * so most assertions are bounds and format discipline rather than cruft
 * detection.
 *
 * Text-field classification (docs/reference/binary-content-invariant-design-brief.md §4.4):
 *   - Free-form text → pdppSafeText (via stringMaxSchema, pathSchema, and direct uses)
 *   - Regex-validated structural strings (UUIDs, timestamps) → z.string().regex(...)
 *   - content_preview uses a bespoke safeTextPreview() refine for the
 *     +1-for-ellipsis bound (equivalent invariant to pdppSafeText).
 */

import { pdppSafeText } from "@pdpp/connector-protocol/pdpp-safe-text";
import {
	PDPP_PREVIEW_MAX_CHARS,
	safeTextPreview,
} from "@pdpp/connector-protocol/safe-text-preview";
import { z } from "zod";
import { makeValidateRecord } from "../../src/schema-registry.ts";

// Module-scoped regexes (Biome useTopLevelRegex).
const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_Z_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// Shared field schemas.
const uuidSchema = z.string().regex(UUID_RE, "must be valid UUID");
const isoDateTimeSchema = z
	.string()
	.regex(ISO_Z_RE, "must be ISO-8601 with millis and Z suffix")
	.nullable();
const stringMaxSchema = (max: number) => pdppSafeText.max(max).nullable();
const pathSchema = pdppSafeText.max(2048).nullable();

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

/**
 * Server-issued reference to a complete artifact body in blob storage.
 *
 * Typed rather than `z.any()` (the shape gmail's schema uses) because these
 * four fields are the whole basis for claiming an artifact was durably
 * captured: without a verifiable digest and size, `blob_ref` would be an
 * unfalsifiable assertion that the bytes exist somewhere.
 */
const blobRefSchema = z.object({
	blob_id: pdppSafeText.min(1).max(256),
	mime_type: pdppSafeText.max(256),
	sha256: z.string().regex(SHA256_HEX_RE, "must be lowercase hex sha256"),
	size_bytes: z.number().int().min(0),
});

export const sessionsSchema = z.object({
	id: uuidSchema,
	project_path: pdppSafeText,
	cwd: pathSchema,
	git_branch: stringMaxSchema(256),
	version: stringMaxSchema(64),
	started_at: isoDateTimeSchema,
	last_event_at: isoDateTimeSchema,
	message_count: z.number().int().min(0).nullable(),
	user_type: stringMaxSchema(40),
	entrypoint: stringMaxSchema(256),
});

export const messagesSchema = z.object({
	id: uuidSchema,
	session_id: uuidSchema,
	parent_uuid: uuidSchema.nullable(),
	role: stringMaxSchema(64),
	type: stringMaxSchema(64),
	content: pdppSafeText.max(10_000_000).nullable(),
	timestamp: isoDateTimeSchema,
	is_sidechain: z.boolean(),
	user_type: stringMaxSchema(40),
	agent_id: stringMaxSchema(256).nullable(),
});

// attachments.id is one of two shapes:
//   - a session-event UUID (from buildAttachmentRecord), or
//   - "tool_result_file:<projectDir>/<sessionId>/<rel>" composite
//     (from the tool-results blob path).
// Single string assertion with generous bounds; structural variants
// validate via session_id (always UUID) and event_type fields.
export const attachmentsSchema = z.object({
	id: pdppSafeText.min(1).max(2048),
	session_id: uuidSchema,
	parent_uuid: uuidSchema.nullable(),
	event_type: stringMaxSchema(64),
	hook_name: stringMaxSchema(256),
	tool_use_id: stringMaxSchema(256),
	// content_preview keeps its bespoke refine for the +1-for-ellipsis bound;
	// semantically equivalent to pdppSafeText (same safeTextPreview check).
	content_preview: z
		.string()
		.max(PDPP_PREVIEW_MAX_CHARS + 1) // +1 for ellipsis if truncated
		.refine((val) => {
			const result = safeTextPreview(val, PDPP_PREVIEW_MAX_CHARS);
			return result.kind === "text" || result.kind === "empty";
		}, "content_preview contains forbidden control characters")
		.nullable(),
	// .optional() so legacy fixtures and records emitted before the parser
	// started writing this companion field still validate.
	content_binary_reason: pdppSafeText.max(200).nullable().optional(),
	content_bytes: z.number().int().min(0).nullable(),
	timestamp: isoDateTimeSchema,
	// Reference to the complete artifact body in blob storage. `content_preview`
	// above stays exactly as it was — a bounded SEARCH PROJECTION, not the
	// authoritative content. This field is what makes the record reconstructable:
	// the preview is what makes it searchable. `.optional()` so records emitted
	// before artifact capture existed still validate.
	blob_ref: blobRefSchema.nullable().optional(),
	// Whether the complete body was durably captured. `failed`/`unavailable`
	// make an uncaptured body VISIBLE on the record rather than leaving its
	// absence indistinguishable from an artifact that had no body at all.
	artifact_capture: z
		.enum(["captured", "failed", "unavailable"])
		.nullable()
		.optional(),
	// Content digest computed during local spooling, so it is known even before
	// the upload completes — and is what a later delivery is verified against.
	artifact_sha256: z
		.string()
		.regex(SHA256_HEX_RE, "must be lowercase hex sha256")
		.nullable()
		.optional(),
});

export const skillsSchema = z.object({
	id: pdppSafeText,
	name: stringMaxSchema(256),
	description: stringMaxSchema(2048),
	source: stringMaxSchema(64),
	path: pathSchema,
	content: pdppSafeText.max(10_000_000).nullable(),
	frontmatter: z.record(z.string(), z.unknown()).nullable(),
	mtime_epoch: z.number().nullable(),
});

export const memoryNotesSchema = z.object({
	id: pdppSafeText,
	project_path: pdppSafeText,
	note_path: pdppSafeText,
	name: stringMaxSchema(256),
	description: stringMaxSchema(2048),
	path: pathSchema,
	content: pdppSafeText.max(10_000_000).nullable(),
	frontmatter: z.record(z.string(), z.unknown()).nullable(),
	mtime_epoch: z.number().nullable(),
});

export const slashCommandsSchema = z.object({
	id: pdppSafeText,
	name: stringMaxSchema(256),
	description: stringMaxSchema(2048),
	path: pathSchema,
	content: pdppSafeText.max(10_000_000).nullable(),
	frontmatter: z.record(z.string(), z.unknown()).nullable(),
	mtime_epoch: z.number().nullable(),
});

const inventoryClassificationSchema = z.enum(["inventory_only", "defer"]);
const inventoryTypeSchema = z.enum(["directory", "file", "missing", "other"]);
const coverageStatusSchema = z.enum([
	"collected",
	"inventory_only",
	"excluded",
	"deferred",
	"missing",
	"unsupported",
]);

export const inventorySchema = z.object({
	id: pdppSafeText,
	store: pdppSafeText,
	relative_path: pdppSafeText.max(2048),
	path_hash: z.string().regex(/^[a-f0-9]{64}$/),
	type: inventoryTypeSchema,
	size_bytes: z.number().int().min(0).nullable(),
	mtime_epoch: z.number().int().min(0).nullable(),
	classification: inventoryClassificationSchema,
	reason: pdppSafeText.max(512),
});

export const coverageDiagnosticsSchema = z.object({
	id: pdppSafeText,
	store: pdppSafeText,
	stream: pdppSafeText.nullable(),
	status: coverageStatusSchema,
	reason: pdppSafeText.max(512),
});

/** Map stream name → schema. Single source of truth for what streams this
 *  connector produces at shape-check time. */
export const SCHEMAS: Record<string, z.ZodTypeAny> = {
	sessions: sessionsSchema,
	messages: messagesSchema,
	attachments: attachmentsSchema,
	skills: skillsSchema,
	memory_notes: memoryNotesSchema,
	slash_commands: slashCommandsSchema,
	file_history: inventorySchema,
	cache_inventory: inventorySchema,
	backup_inventory: inventorySchema,
	config_inventory: inventorySchema,
	coverage_diagnostics: coverageDiagnosticsSchema,
};

export const validateRecord = makeValidateRecord(SCHEMAS);
