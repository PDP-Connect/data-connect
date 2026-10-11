// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";
import type { RsClient } from "./rs-client.ts";
import { buildTools } from "./tools.ts";

export interface PackageProfileChild {
	grant_id: string;
	status: string;
	source?: unknown;
	purpose?: unknown;
	streams?: unknown;
	mode?: unknown;
	rs: RsClient;
}

export interface PackageProfile {
	children: PackageProfileChild[];
}

const GRANT_ID_PATTERN = /^grt_[A-Za-z0-9_-]+$/;

export const PACKAGE_PROFILE_INSTRUCTIONS =
	"This package requires explicit child selection. Start with `list_package_children`; pass exactly one returned `grant_id` to every data-disclosing tool, including schema, search, fetch and read_record_field. Results apply only to that child. Keep grant_id with every follow-up call; connection_id and record handles never select a child. Resource reads are unavailable for packages. Treat isError as a failed tool call and read its text, even when there is no structured error. On package_child_inactive, access has ended: do not retry; ask the owner if access is needed again. A new consent creates a new grant_id, even for the same connection_id. After replacing authorization, inspect the complete new authorization result, rediscover children, and choose the intended child explicitly. Source and instance handles are discovery hints, not authority; several children can cover the same source. Restart grant-bound searches without the old cursor; replacing grant_id alone cannot renew a saved search cursor.";

function selectorError(code: string, message: string, grantId?: string) {
	const error = {
		code,
		message,
		...(grantId === undefined ? {} : { grant_id: grantId }),
	};
	return {
		isError: true as const,
		content: [{ type: "text" as const, text: message }],
		structuredContent: { error },
	};
}

// Follow-up instructions are data emitted by the shared read tools. Carry the
// authorization selector with every tool/args pair, without changing record data.
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

// Present adapter-owned continuation descriptors after child authorization.
// Source record payloads remain intact in structuredContent.data.
function scopePackageResult(
	result: ToolResult,
	name: string,
	grantId: string,
): ToolResult {
	const structured = result.structuredContent;
	const scopedLadder = structured?.content_ladder
		? scopeFollowups(structured.content_ladder, grantId)
		: undefined;
	const scopedResults =
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
				text: [
					`Selected grant_id: ${grantId}. Include this grant_id in every follow-up tool call. Resource URIs do not authorize package reads.`,
					scopedLadder ? JSON.stringify({ content_ladder: scopedLadder }) : "",
				]
					.filter(Boolean)
					.join("\n"),
			},
		],
		...(structured
			? {
					structuredContent: {
						...structured,
						...(scopedLadder ? { content_ladder: scopedLadder } : {}),
						...(scopedResults ? { results: scopedResults } : {}),
					},
				}
			: {}),
	};
}

export function buildPackageProfileTools(
	profile: PackageProfile,
	providerUrl: string,
): ReturnType<typeof buildTools> {
	const [firstChild] = profile.children;
	if (!firstChild) {
		throw new TypeError("Package profile requires a covered child");
	}
	const prototypeTools = buildTools({ rs: firstChild.rs, providerUrl });
	const tools: ReturnType<typeof buildTools> = prototypeTools.map((tool) => ({
		...tool,
		description: `${tool.description} Package access: grant_id is required and selects exactly one child.`,
		// The server SDK returns input-validation failures as MCP tool errors.
		// Declare a required string; the handler checks format and membership.
		inputSchema: (tool.inputSchema as z.ZodObject).extend({
			grant_id: z
				.string()
				.describe(
					"Required package child grant_id from list_package_children.",
				),
		}),
		handler: async (args: Record<string, unknown>) => {
			const grantId = args.grant_id;
			if (typeof grantId !== "string" || !GRANT_ID_PATTERN.test(grantId)) {
				return selectorError(
					"invalid_grant_selector",
					"Pass exactly one valid grant_id from list_package_children.",
				);
			}
			const child = profile.children.find(
				(entry) => entry.grant_id === grantId,
			);
			if (!child) {
				return selectorError(
					"unknown_grant_selector",
					"Unknown grant_id. Use list_package_children to choose a covered child.",
				);
			}
			if (child.status !== "active") {
				return selectorError(
					"package_child_inactive",
					`Access to grant ${grantId} has ended. Do not retry this call. Ask the owner if this access is needed again.`,
					grantId,
				);
			}
			const { grant_id: _selector, ...readArgs } = args;
			const childTool = buildTools({
				rs: child.rs,
				providerUrl,
				presentationGrantId: grantId,
			}).find((entry) => entry.name === tool.name);
			if (!childTool) {
				throw new Error(`Missing package tool: ${tool.name}`);
			}
			const result = await childTool.handler(readArgs);
			const error = result.structuredContent?.error as
				| { code?: string }
				| undefined;
			if (
				result.isError &&
				(error?.code === "grant_revoked" || error?.code === "grant_expired")
			) {
				return selectorError(
					"package_child_inactive",
					`Access to grant ${grantId} has ended. Do not retry this call. Ask the owner if this access is needed again.`,
					grantId,
				);
			}
			return scopePackageResult(result, tool.name, grantId);
		},
	}));
	tools.push({
		name: "list_package_children",
		title: "List package children",
		description:
			"Discover only the approved metadata and current status of children covered by this package. No records or derived facts.",
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: z.object({}).strict(),
		handler: async () => {
			const children = profile.children.map(
				({ grant_id, status, source, purpose, streams, mode }) => ({
					grant_id,
					status,
					source,
					purpose,
					streams,
					mode,
				}),
			);
			return {
				content: [
					{ type: "text" as const, text: JSON.stringify({ children }) },
				],
				structuredContent: { children },
			};
		},
	});
	return tools;
}
