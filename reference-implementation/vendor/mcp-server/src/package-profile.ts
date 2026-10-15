// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";
import type { RsClient } from "./rs-client.ts";
import { buildTools } from "./tools.ts";

export interface PackageProfileChild {
	grant_id: string;
	rs: RsClient;
}

export interface PackageProfile {
	children: PackageProfileChild[];
}

const GRANT_ID_PATTERN = /^[A-Za-z0-9._~-]+$/;
const SELECTOR_RECOVERY =
	"Pass exactly one valid child grant_id. Use list_package_children to discover package children, then retry.";

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
	| { error: ReturnType<typeof selectorError> } {
	if (typeof grantId !== "string" || !GRANT_ID_PATTERN.test(grantId)) {
		return {
			error: selectorError("invalid_grant_selector", SELECTOR_RECOVERY),
		};
	}
	const child = profile.children.find((entry) => entry.grant_id === grantId);
	return child
		? { child }
		: {
				error: selectorError(
					"unknown_grant_selector",
					`Unknown grant_id. ${SELECTOR_RECOVERY}`,
				),
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
	const schemaTools = buildTools({ rs: profile.children[0]!.rs, providerUrl });
	return schemaTools.map((tool) => ({
		...tool,
		description: `${tool.description} For package tokens, pass one child grant_id; use list_package_children to discover children.`,
		inputSchema: (tool.inputSchema as z.ZodObject).extend({
			grant_id: z
				.string()
				.describe(
					"Required package child grant_id. Discover children with list_package_children.",
				),
		}),
		handler: async (args: Record<string, unknown>) => {
			const selection = resolvePackageChild(profile, args.grant_id);
			if ("error" in selection) {
				return selection.error;
			}
			const { child } = selection;
			const grantId = child.grant_id;
			const { grant_id: _selector, ...readArgs } = args;
			const childTool = buildTools({ rs: child.rs, providerUrl }).find(
				(entry) => entry.name === tool.name,
			);
			if (!childTool) {
				throw new Error(`Missing package tool: ${tool.name}`);
			}
			return scopePackageResult(
				await childTool.handler(readArgs),
				tool.name,
				grantId,
			);
		},
	}));
}
