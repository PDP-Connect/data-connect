// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import type { PackageProfile } from "../src/package-profile.ts";
import { RsClient } from "../src/rs-client.ts";
import { handleStreamableHttpRequest } from "../src/server.ts";

const TOOL_NAMES = [
	"schema",
	"query_records",
	"aggregate",
	"search",
	"fetch",
	"read_record_field",
];
const VALID_ARGS: Record<string, Record<string, unknown>> = {
	schema: {},
	query_records: { stream: "notes" },
	aggregate: { metric: "count", stream: "notes" },
	search: { mode: "lexical", q: "term" },
	fetch: { id: "conn_a/notes:a" },
	read_record_field: { field_path: "text", id: "conn_a/notes:a" },
};

function fixture(options: { invalidGrantId?: string } = {}) {
	const reads: string[] = [];
	const children = ["a.child~_1-", "b.child"].map((grant_id) => ({
		grant_id,
		rs: new RsClient({
			accessToken: `token-${grant_id}`,
			fetch: async (input) => {
				const url = String(input);
				reads.push(`${grant_id}:${url}`);
				if (grant_id === options.invalidGrantId) {
					return Response.json(
						{
							error: {
								code: "grant_invalid",
								message: "The selected child grant is invalid.",
							},
						},
						{ status: 403 },
					);
				}
				if (url.includes("/field-window")) {
					return Response.json({
						field: { path: "text" },
						record_id: "a",
						stream: "notes",
						window: {
							complete: true,
							end_chars: 5,
							limit_chars: 16,
							next_offset_chars: null,
							previous_offset_chars: 0,
							start_chars: 0,
							text: "hello",
						},
					});
				}
				if (url.includes("/v1/search")) {
					return Response.json({
						hits: [
							{
								connection_id: "conn_a",
								field_windows: [
									{
										field_path: "text",
										preview_status: "truncated",
										preview_text: "preview",
										size_chars: 9000,
									},
								],
								id: "a",
								record_key: "a",
								stream: "notes",
							},
						],
					});
				}
				return Response.json({ data: [] });
			},
			providerUrl: "https://rs.test",
		}),
	}));
	return { reads, profile: { children } satisfies PackageProfile };
}

async function request(
	profile: PackageProfile | undefined,
	method: string,
	params: unknown,
) {
	const response = await handleStreamableHttpRequest(
		new Request("https://rs.test/mcp", {
			body: JSON.stringify({ id: 1, jsonrpc: "2.0", method, params }),
			headers: {
				Accept: "application/json, text/event-stream",
				"Content-Type": "application/json",
			},
			method: "POST",
		}),
		{
			...(profile
				? { packageProfile: profile }
				: { accessToken: "client-token" }),
			providerUrl: "https://rs.test",
		},
	);
	return JSON.parse(await response.text()) as {
		result: Record<string, unknown>;
		status?: number;
	};
}

async function call(
	profile: PackageProfile,
	name: string,
	args: Record<string, unknown>,
) {
	return request(profile, "tools/call", { arguments: args, name });
}

test("package tools require a valid known grant_id before any RS call", async () => {
	const { profile, reads } = fixture();
	for (const name of TOOL_NAMES) {
		for (const args of [
			VALID_ARGS[name]!,
			{ ...VALID_ARGS[name], grant_id: "" },
			{ ...VALID_ARGS[name], grant_id: "bad/id" },
			{ ...VALID_ARGS[name], grant_id: "unknown-child" },
			{ ...VALID_ARGS[name], grant_id: 7 },
			{ ...VALID_ARGS[name], grant_id: null },
			{ ...VALID_ARGS[name], grant_id: [] },
			{ ...VALID_ARGS[name], grant_id: {} },
		]) {
			const { result } = await call(profile, name, args);
			assert.equal(
				result.isError,
				true,
				`${name} rejects ${JSON.stringify(args.grant_id)}`,
			);
			assert.match(JSON.stringify(result.content), /list_package_children/);
		}
	}
	assert.deepEqual(reads, []);
});

test("each package data tool reads only the named child for either child", async () => {
	const { profile, reads } = fixture();
	for (const child of profile.children) {
		for (const name of TOOL_NAMES) {
			reads.length = 0;
			const { result } = await call(profile, name, {
				...VALID_ARGS[name]!,
				grant_id: child.grant_id,
			});
			assert.notEqual(
				result.isError,
				true,
				`${name} accepts ${child.grant_id}: ${JSON.stringify(result.content)}`,
			);
			assert.ok(reads.length > 0, `${name} reaches the selected RS client`);
			assert.ok(
				reads.every((read) => read.startsWith(`${child.grant_id}:`)),
				`${name} reads only ${child.grant_id}`,
			);
		}
	}
});

test("selected child grant_invalid is returned without calling a sibling", async () => {
	const invalidGrantId = "b.child";
	const { profile, reads } = fixture({ invalidGrantId });
	const { result } = await call(profile, "query_records", {
		...VALID_ARGS.query_records!,
		grant_id: invalidGrantId,
	});
	const structured = result.structuredContent as {
		error: { code: string };
		http_status: number;
	};
	assert.equal(result.isError, true);
	assert.equal(structured.error.code, "grant_invalid");
	assert.equal(structured.http_status, 403);
	assert.equal(reads.length, 1);
	assert.ok(reads[0]!.startsWith(`${invalidGrantId}:`));
	assert.equal(reads.some((read) => read.startsWith("a.child~_1-:")), false);
});

test("package tools/list requires grant_id and hides resource templates; client surface stays unchanged", async () => {
	const { profile } = fixture();
	const packageList = await request(profile, "tools/list", {});
	assert.deepEqual(
		packageList.result.tools &&
			(packageList.result.tools as Array<{ name: string }>).map(
				(tool) => tool.name,
			),
		TOOL_NAMES,
	);
	for (const tool of packageList.result.tools as Array<{
		inputSchema: { properties: Record<string, unknown>; required: string[] };
	}>) {
		assert.equal(
			tool.inputSchema.properties.grant_id &&
				(tool.inputSchema.properties.grant_id as { type: string }).type,
			"string",
		);
		assert.ok(tool.inputSchema.required.includes("grant_id"));
	}
	const templates = await request(profile, "resources/templates/list", {});
	assert.equal(
		templates.error !== undefined ||
			templates.result.resourceTemplates === undefined,
		true,
	);
	assert.ok(
		Buffer.byteLength(JSON.stringify(packageList.result.tools)) < 24_576,
	);

	const clientList = await request(undefined, "tools/list", {});
	assert.deepEqual(
		(clientList.result.tools as Array<{ name: string }>).map(
			(tool) => tool.name,
		),
		TOOL_NAMES,
	);
	for (const tool of clientList.result.tools as Array<{
		inputSchema: { properties: Record<string, unknown> };
	}>) {
		assert.equal("grant_id" in tool.inputSchema.properties, false);
	}
});

test("package follow-up descriptors keep their selected grant_id", async () => {
	const { profile } = fixture();
	const grantId = profile.children[0]!.grant_id;
	const result = await call(profile, "search", {
		mode: "lexical",
		q: "term",
		grant_id: grantId,
	});
	assert.equal(result.result.isError, undefined);
	const structured = result.result.structuredContent as {
		content_ladder: {
			records: Array<{
				field_windows: Array<{ read: { args: Record<string, unknown> } }>;
			}>;
		};
		results: Array<{
			match_windows: Array<{ read: { args: Record<string, unknown> } }>;
		}>;
	};
	assert.equal(
		structured.content_ladder.records[0]!.field_windows[0]!.read.args.grant_id,
		grantId,
	);
	assert.equal(
		structured.results[0]!.match_windows[0]!.read.args.grant_id,
		grantId,
	);
});
