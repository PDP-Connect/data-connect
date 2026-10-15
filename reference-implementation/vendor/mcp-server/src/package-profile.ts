// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";
import type { RsClient } from "./rs-client.ts";
import { buildTools } from "./tools.ts";

export interface PackageProfileChild {
	access_mode: string;
	active: boolean;
	connection_id?: string | null;
	grant_id: string;
	purpose: string;
	rs: RsClient;
	source: PackageSource | null;
	streams: PackageStream[];
}

interface PackageSource {
	connection_id?: string;
	connector_display_name?: string;
	display_name?: string;
	id: string;
	kind: "connector" | "provider_native";
}

interface PackageStream {
	instance_ids: string[];
	name: string;
}

export interface PackageProfile {
	children: PackageProfileChild[];
}

const GRANT_ID_PATTERN = /^[A-Za-z0-9._~-]+$/;
const SELECTOR_RECOVERY =
	"Pass exactly one valid child grant_id. Use list_package_children to discover package children, then retry.";
const PACKAGE_TOOL_DESCRIPTIONS: Record<string, string> = {
	aggregate: "Prefer for counts, sums, min/max, distinct counts, or grouped/time rollups when record bodies are not needed. `field` is required for sum, min/max, and distinct count. Use one grouping (`group_by` XOR `group_by_time`; the latter needs `granularity`). `other_count` reveals top-N truncation. Find groupable fields in `schema`. Read-only.",
	fetch: "Fetch a search result as an OpenAI-compatible document (`id`, `title`, `text`, `url`, `metadata`); use `query_records` for canonical PDPP record envelopes. Pass self-contained `connection_id/stream:record_id` ids unchanged, or legacy `stream:record_id` with `connection_id`. `fields` projects the source; if no `text`, `content`, `body`, or `summary` field remains, `text` is compact JSON of the projection. On `ambiguous_connection` (409), choose a `connection_id` from `available_connections`. Read-only.",
	query_records: "Read records from the selected child's stream. Returns at most 25 by default (limit max 100); REST requests over 100 get `limit_clamped` in `meta.warnings[]`. `content` previews the first 5. Page with `cursor`, narrow with `fields`; projections retain operational handles (`id`, stream, `connection_id`, `connector_key`). `structuredContent.data` is the machine envelope. Read-only.",
	read_record_field: "Read bounded text from a record field using its self-contained `connection_id/stream:record_id` id or `pdpp://record/...` URI, or explicit `connection_id` + `stream` + `record_id`, and `field_path`. Navigate with `offset_chars` or the returned `cursor`; use `q` to search within the field. Read-only.",
	schema: "Read the selected child's schema: streams, canonical `connector_key`, field filter/sort/count, expansions, aggregates, projections, search, pagination, and `connection_id` identities. Refine with `schema`, `schema(stream)`, then `schema(stream, connection_id)` when names repeat. Use compact detail by default; full detail needs a stream. Read-only.",
	search: "Use lexical for exact terms, semantic for conceptual matches, or hybrid to combine. Results include self-contained fetch ids and source handles (`connection_id`, `connector_key`); `structuredContent.data` holds compact metadata. Find modes and query capabilities in `schema`. Lexical/semantic page with `cursor`; hybrid does not page. Pages default to 25 (max 100). Read-only.",
};

export function isPackageDataTool(
	name: unknown,
): name is
	| "schema"
	| "query_records"
	| "aggregate"
	| "search"
	| "fetch"
	| "read_record_field" {
	return (
		name === "schema" ||
		name === "query_records" ||
		name === "aggregate" ||
		name === "search" ||
		name === "fetch" ||
		name === "read_record_field"
	);
}

export function resolvePackageChild(
	profile: PackageProfile,
	grantId: unknown,
):
	| { child: PackageProfileChild }
	| { error: ReturnType<typeof inactiveChildError> }
	| { error: ReturnType<typeof selectorError> } {
	if (typeof grantId !== "string" || !GRANT_ID_PATTERN.test(grantId)) {
		return {
			error: selectorError("invalid_grant_selector", SELECTOR_RECOVERY),
		};
	}
	const child = profile.children.find((entry) => entry.grant_id === grantId);
	if (!child) {
		return {
				error: selectorError(
					"unknown_grant_selector",
					`Unknown grant_id. ${SELECTOR_RECOVERY}`,
				),
			};
	}
	return child.active ? { child } : { error: inactiveChildError(child.grant_id) };
}

function inactiveChildError(grantId: string) {
	return {
		isError: true as const,
		content: [
			{
				type: "text" as const,
				text: `Access to grant ${grantId} has ended. Do not retry this call. Ask the owner if this access is needed again.`,
			},
		],
		structuredContent: {
			error: { code: "package_child_inactive", grant_id: grantId },
		},
	};
}

function selectedChildError(result: ToolResult, grantId: string): ToolResult {
	const error = result.structuredContent?.error as { code?: unknown } | undefined;
	if (
		result.structuredContent?.http_status === 403 &&
		error &&
		["package_child_inactive", "grant_revoked", "grant_expired"].includes(
			String(error.code),
		)
	) {
		return inactiveChildError(grantId);
	}
	return result;
}

function discoveryChild(child: PackageProfileChild) {
	return {
		grant_id: child.grant_id,
		connection_id: child.connection_id ?? child.source?.connection_id ?? null,
		source: child.source
			? {
					id: child.source.id,
					kind: child.source.kind,
					...(child.source.connection_id
						? { connection_id: child.source.connection_id }
						: {}),
					...(child.source.display_name
						? { display_name: child.source.display_name }
						: {}),
					...(child.source.connector_display_name
						? { connector_display_name: child.source.connector_display_name }
						: {}),
				}
			: null,
		purpose: child.purpose,
		streams: child.streams.map(({ name, instance_ids }) => ({
			name,
			instance_ids: [...instance_ids],
		})),
		access_mode: child.access_mode,
		active: child.active,
	};
}

function selectorError(code: string, message: string) {
	return {
		isError: true as const,
		content: [{ type: "text" as const, text: message }],
		structuredContent: { error: { code, message } },
	};
}

function scopeFollowups(value: unknown, grantId: string): unknown {
	if (Array.isArray(value)) {
		return value.map((entry) => scopeFollowups(entry, grantId));
	}
	if (!value || typeof value !== "object") {
		return value;
	}
	const object = value as Record<string, unknown>;
	const scoped = Object.fromEntries(
		Object.entries(object).map(([key, entry]) => [
			key,
			scopeFollowups(entry, grantId),
		]),
	);
	if (
		typeof object.tool === "string" &&
		object.args &&
		typeof object.args === "object"
	) {
		scoped.args = {
			...(object.args as Record<string, unknown>),
			grant_id: grantId,
		};
	}
	return scoped;
}

type ToolResult = Awaited<
	ReturnType<ReturnType<typeof buildTools>[number]["handler"]>
>;

function scopePackageResult(
	result: ToolResult,
	name: string,
	grantId: string,
): ToolResult {
	const structured = result.structuredContent;
	const contentLadder = structured?.content_ladder
		? scopeFollowups(structured.content_ladder, grantId)
		: undefined;
	const searchResults =
		name === "search" && Array.isArray(structured?.results)
			? structured.results.map((entry) => {
					const hit = entry as Record<string, unknown>;
					return {
						...hit,
						...(hit.match_windows
							? { match_windows: scopeFollowups(hit.match_windows, grantId) }
							: {}),
					};
				})
			: undefined;
	return {
		...result,
		content: [
			...result.content,
			{
				type: "text" as const,
				text: `Selected grant_id: ${grantId}. Include it in every follow-up tool call.`,
			},
		],
		...(structured
			? {
					structuredContent: {
						...structured,
						...(contentLadder ? { content_ladder: contentLadder } : {}),
						...(searchResults ? { results: searchResults } : {}),
					},
				}
			: {}),
	};
}

export function buildPackageProfileTools(
	profile: PackageProfile,
	providerUrl: string,
): ReturnType<typeof buildTools> {
	if (profile.children.length === 0) {
		throw new TypeError("Package profile requires a covered child");
	}
	const listChildren = {
		name: "list_package_children",
		title: "List package children",
		description:
			"List this package token's covered grants, source metadata, streams, access modes, and active status. The deprecated compatibility alias `connection_id` maps legacy stored IDs and URIs to a child; use `grant_id` for package tool and resource calls. Read-only.",
		annotations: {
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
			readOnlyHint: true,
		},
		inputSchema: z.object({}).strict(),
		outputSchema: z.object({
			children: z.array(
				z.object({
					grant_id: z.string(),
					connection_id: z.string().nullable().describe(
						"Deprecated public compatibility alias for legacy stored IDs and URIs. Use grant_id for package tool and resource calls.",
					),
					source: z
						.union([
							z.object({
								id: z.string(),
								kind: z.enum(["connector", "provider_native"]),
								connection_id: z.string().optional(),
								display_name: z.string().optional(),
								connector_display_name: z.string().optional(),
							}),
							z.null(),
						])
						.describe("Public source metadata covered by this child."),
					purpose: z.string(),
					streams: z.array(
						z.object({
							name: z.string(),
							instance_ids: z.array(z.string()),
						}),
					),
					access_mode: z.string(),
					active: z.boolean(),
				}),
			),
		}),
		handler: async () => ({
			content: [
				{
					type: "text" as const,
					text: `Package children: ${profile.children
						.map((child) => `${child.grant_id} (${child.active ? "active" : "inactive"})`)
						.join(", ")}`,
				},
			],
			structuredContent: {
				children: profile.children.map(discoveryChild),
			},
		}),
	};
	const schemaTools = buildTools({ rs: profile.children[0]!.rs, providerUrl });
	return [listChildren, ...schemaTools.map((tool) => ({
		...tool,
		description: `${PACKAGE_TOOL_DESCRIPTIONS[tool.name]} Select one child with grant_id; discover children with list_package_children.`,
		inputSchema: (tool.inputSchema as z.ZodObject).extend({
			grant_id: z
				.string()
				.describe("Required package child grant_id."),
		}),
		handler: async (args: Record<string, unknown>) => {
			const selection = resolvePackageChild(profile, args.grant_id);
			if ("error" in selection) {
				return selection.error;
			}
			const { child } = selection;
			const grantId = child.grant_id;
			const readArgs = { ...args };
			delete readArgs.grant_id;
			const childTool = buildTools({ rs: child.rs, providerUrl }).find(
				(entry) => entry.name === tool.name,
			);
			if (!childTool) {
				throw new Error(`Missing package tool: ${tool.name}`);
			}
			const childResult = selectedChildError(
				await childTool.handler(readArgs),
				grantId,
			);
			if (
				(childResult.structuredContent?.error as { code?: unknown } | undefined)
					?.code === "package_child_inactive"
			) {
				return childResult;
			}
			return scopePackageResult(
				childResult,
				tool.name,
				grantId,
			);
		},
	}))];
}
