// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { createPackageProfile } from "../../../server/package-rs-client.ts";
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
const PACKAGE_TOOL_NAMES = ["list_package_children", ...TOOL_NAMES];
const VALID_ARGS: Record<string, Record<string, unknown>> = {
	schema: {},
	query_records: { stream: "notes" },
	aggregate: { metric: "count", stream: "notes" },
	search: { mode: "lexical", q: "term" },
	fetch: { id: "conn_a/notes:a" },
	read_record_field: { field_path: "text", id: "conn_a/notes:a" },
};

function fixture(options: { inactiveGrantId?: string; invalidGrantId?: string } = {}) {
	const reads: string[] = [];
	const children = [
		{ grant_id: "a.child~_1-", active: options.inactiveGrantId !== "a.child~_1-" },
		{ grant_id: "b.child", active: options.inactiveGrantId !== "b.child" },
	].map(({ grant_id, active }) => ({
		grant_id,
		source: {
			id: `source-${grant_id}`,
			kind: "connector" as const,
			display_name: `Source ${grant_id}`,
			connection_id: `pairwise-${grant_id}`,
			subject_id: "subject_private",
			rs_instance: "rs_instance_private",
			internal_instance: "cin_internal_1",
		},
		purpose: "personal records",
		streams: [
			{ name: "notes", instance_ids: [`pairwise-${grant_id}`], private_field: "omit" },
		],
		access_mode: "continuous",
		active,
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
	return {
		...(JSON.parse(await response.text()) as { result: Record<string, unknown> }),
		httpStatus: response.status,
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
	const { profile, reads } = fixture({ inactiveGrantId: "none" });
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
	const invalidGrantId = "a.child~_1-";
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
	assert.equal(reads.some((read) => read.startsWith("b.child:")), false);
	const sibling = await call(profile, "query_records", {
		...VALID_ARGS.query_records!,
		grant_id: "b.child",
	});
	assert.equal(sibling.result.isError, undefined, "lost mapping does not block a sibling");
	assert.ok(reads.some((read) => read.startsWith("b.child:")));
});

test("package discovery lists covered children, including inactive, with only declared public fields", async () => {
	const { profile, reads } = fixture({ inactiveGrantId: "b.child" });
	const { result } = await call(profile, "list_package_children", {});
	assert.equal(result.isError, undefined);
	assert.deepEqual(reads, []);
	assert.deepEqual(result.structuredContent, {
		children: [
			{
				grant_id: "a.child~_1-",
				purpose: "personal records",
				streams: [{ name: "notes", instance_ids: ["pairwise-a.child~_1-"] }],
				source: {
					id: "source-a.child~_1-",
					kind: "connector",
					display_name: "Source a.child~_1-",
					connection_id: "pairwise-a.child~_1-",
				},
				access_mode: "continuous",
				active: true,
			},
			{
				grant_id: "b.child",
				purpose: "personal records",
				streams: [{ name: "notes", instance_ids: ["pairwise-b.child"] }],
				source: {
					id: "source-b.child",
					kind: "connector",
					display_name: "Source b.child",
					connection_id: "pairwise-b.child",
				},
				access_mode: "continuous",
				active: false,
			},
		],
	});
	const serialized = JSON.stringify(result);
	for (const secret of ["subject_private", "rs_instance_private", "cin_internal_1", "private_field", "token-"]) {
		assert.equal(serialized.includes(secret), false, `discovery excludes ${secret}`);
	}
	const initialized = await request(profile, "initialize", {
		capabilities: {},
		clientInfo: { name: "test", version: "1" },
		protocolVersion: "2025-03-26",
	});
	const exposed = JSON.stringify({ result, instructions: initialized.result.instructions });
	assert.doesNotMatch(exposed, /subject_id|rs_instance|cin_/);
	assert.equal(exposed.includes("child-bearer-secret"), false);
	assert.match(String(initialized.result.instructions), /list_package_children.*statuses.*grant_id/);
});

test("frozen package members map to child metadata without exposing per-child tokens", async () => {
	const profile = createPackageProfile({
		providerUrl: "https://rs.test",
		fetch: async () => Response.json({ data: [] }),
		members: [
			{
				access_mode: "continuous",
				active: true,
				connection_id: "pairwise-a",
				grant: {
					purpose: "personal records",
					streams: [{ name: "notes", instance_ids: ["pairwise-a"] }],
				},
				grant_id: "grant-a",
				package_id: "package-public",
				source: { id: "source-a", kind: "connector", connection_id: "pairwise-a" },
				token: "child-bearer-secret",
			},
			{
				access_mode: "single_use",
				active: false,
				connection_id: "pairwise-b",
				grant: {
					purpose: "personal records",
					streams: [{ name: "notes", instance_ids: ["pairwise-b"] }],
				},
				grant_id: "grant-b",
				package_id: "package-public",
				source: { id: "source-b", kind: "provider_native", connection_id: "pairwise-b" },
				token: "inactive-bearer-secret",
			},
		],
	});
	assert.deepEqual(
		profile.children.map(({ grant_id, active, streams }) => ({ grant_id, active, streams })),
		[
			{ grant_id: "grant-a", active: true, streams: [{ name: "notes", instance_ids: ["pairwise-a"] }] },
			{ grant_id: "grant-b", active: false, streams: [{ name: "notes", instance_ids: ["pairwise-b"] }] },
		],
	);
	assert.equal("token" in profile.children[0]!, false);
	const { result } = await call(profile, "list_package_children", {});
	assert.equal(JSON.stringify(result).includes("bearer-secret"), false);
});

test("inactive selected child returns terminal package_child_inactive while its sibling stays readable", async () => {
	const { profile, reads } = fixture({ inactiveGrantId: "b.child" });
	const inactiveId = "b.child";
	const inactive = await call(profile, "query_records", {
		...VALID_ARGS.query_records!,
		grant_id: inactiveId,
	});
	assert.equal(inactive.httpStatus, 200, "inactive child is a tool result, not HTTP status");
	assert.equal(inactive.result.isError, true);
	assert.deepEqual(inactive.result.structuredContent, {
		error: { code: "package_child_inactive", grant_id: inactiveId },
	});
	assert.deepEqual(inactive.result.content, [
		{
			type: "text",
			text: `Access to grant ${inactiveId} has ended. Do not retry this call. Ask the owner if this access is needed again.`,
		},
	]);
	assert.doesNotMatch(JSON.stringify(inactive.result), /subject_id|rs_instance|cin_|child-bearer-secret/);
	assert.equal(reads.length, 0);
	const sibling = await call(profile, "query_records", {
		...VALID_ARGS.query_records!,
		grant_id: "a.child~_1-",
	});
	assert.equal(sibling.result.isError, undefined);
	assert.ok(reads.some((read) => read.startsWith("a.child~_1-:")));
});

test("selected downstream 403 package inactivity codes map to package_child_inactive", async () => {
	for (const code of ["package_child_inactive", "grant_revoked", "grant_expired"]) {
		const child = fixture().profile.children[0]!;
		child.rs = new RsClient({
			accessToken: "child-token",
			fetch: async () =>
				Response.json({ error: { code, message: "downstream detail" } }, { status: 403 }),
			providerUrl: "https://rs.test",
		});
		const { result } = await call({ children: [child] }, "query_records", {
			...VALID_ARGS.query_records!,
			grant_id: child.grant_id,
		});
		assert.equal(result.isError, true, code);
		assert.deepEqual(result.structuredContent, {
			error: { code: "package_child_inactive", grant_id: child.grant_id },
		});
		assert.deepEqual(result.content, [
			{
				type: "text",
				text: `Access to grant ${child.grant_id} has ended. Do not retry this call. Ask the owner if this access is needed again.`,
			},
		]);
	}
});

test("package tools/list requires grant_id and hides resource templates; client surface stays unchanged", async () => {
	const { profile } = fixture();
	const packageList = await request(profile, "tools/list", {});
	assert.deepEqual(
		packageList.result.tools &&
			(packageList.result.tools as Array<{ name: string }>).map(
				(tool) => tool.name,
			),
		PACKAGE_TOOL_NAMES,
	);
	for (const tool of packageList.result.tools as Array<{
		name: string;
		annotations?: { idempotentHint?: boolean; readOnlyHint?: boolean };
		inputSchema: { properties: Record<string, unknown>; required?: string[] };
		outputSchema?: { properties?: Record<string, unknown> };
	}>) {
		if (tool.name === "list_package_children") {
			assert.deepEqual(tool.inputSchema.properties, {});
			assert.equal((tool.inputSchema.required ?? []).includes("grant_id"), false);
			assert.equal(tool.annotations?.readOnlyHint, true);
			assert.equal(tool.annotations?.idempotentHint, true);
			assert.ok(tool.outputSchema?.properties?.children, "discovery declares its output schema");
			continue;
		}
		assert.equal(
			tool.inputSchema.properties.grant_id &&
				(tool.inputSchema.properties.grant_id as { type: string }).type,
			"string",
		);
		assert.ok(tool.inputSchema.required?.includes("grant_id"));
	}
	const unknown = await call(profile, "schema", { grant_id: "never-granted" });
	assert.equal(
		(unknown.result.structuredContent as { error: { code: string } }).error.code,
		"unknown_grant_selector",
	);
	const templates = await request(profile, "resources/templates/list", {});
	assert.equal(
		templates.error !== undefined ||
			templates.result.resourceTemplates === undefined,
		true,
	);
	const packageToolListBytes = Buffer.byteLength(JSON.stringify(packageList.result.tools));
	assert.ok(packageToolListBytes <= 24_576, `package tools/list: ${packageToolListBytes} bytes`);

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
