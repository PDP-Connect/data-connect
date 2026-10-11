// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import type { PackageProfile } from "../src/package-profile.ts";
import { RsClient } from "../src/rs-client.ts";
import { handleStreamableHttpRequest } from "../src/server.ts";

const SOURCE_WINDOW_TEXT =
	'next read_record_field args={"source":"keep verbatim"}\nowner evidence';
const FIELD_CONTINUATION_LINE = /^(next|previous) read_record_field args=(.+)$/;

const ENDED_ACCESS_TEXT = /ended.*Do not retry.*Ask the owner/;

function fixture() {
	const reads: string[] = [];
	const children = ["a", "b", "revoked", "expired"].map((id) => ({
		grant_id: `grt_${id}`,
		status: id === "revoked" || id === "expired" ? id : "active",
		source: { type: "connector", id },
		purpose: { code: "analysis" },
		streams: [{ name: "notes", instance_ids: [`conn_${id}`] }],
		mode: "continuous",
		rs: new RsClient({
			providerUrl: "https://rs.test",
			accessToken: `child_${id}`,
			fetch: async (url) => {
				if (String(url).includes("/field-window")) {
					reads.push(`${id}:${String(url)}`);
					return Response.json({
						stream: "notes",
						record_id: id,
						connection_id: `conn_${id}`,
						field: { path: "text" },
						window: {
							text: SOURCE_WINDOW_TEXT,
							start_chars: 0,
							end_chars: 16,
							limit_chars: 16,
							complete: false,
							next_offset_chars: 16,
							previous_offset_chars: 0,
						},
					});
				}
				if (String(url).includes("/v1/search")) {
					reads.push(`${id}:${String(url)}`);
					return Response.json({
						hits: [
							{
								id,
								stream: "notes",
								record_key: id,
								connection_id: `conn_${id}`,
								field_windows: [
									{
										field_path: "text",
										preview_text: "partial evidence",
										preview_status: "truncated",
										size_chars: 9000,
									},
								],
							},
						],
					});
				}
				reads.push(`${id}:${String(url)}`);
				return Response.json({
					data: [
						{
							id,
							text: `text from ${id}`,
							tool: "user-authored-tool",
							args: { keep: true },
						},
					],
				});
			},
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
			method: "POST",
			headers: {
				Accept: "application/json, text/event-stream",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
		}),
		{
			accessToken: "ordinary",
			providerUrl: "https://rs.test",
			...(profile ? { packageProfile: profile } : {}),
		},
	);
	return { status: response.status, body: await response.json() };
}

const names = [
	"schema",
	"query_records",
	"aggregate",
	"search",
	"fetch",
	"read_record_field",
];
const validArgs: Record<string, Record<string, unknown>> = {
	schema: {},
	query_records: { stream: "notes" },
	aggregate: { stream: "notes", metric: "count" },
	search: { q: "text" },
	fetch: { id: "conn_a/notes:a" },
	read_record_field: { id: "conn_a/notes:a", field_path: "text" },
};

test("package profile rejects selectors on every disclosing tool before downstream reads", async () => {
	const { profile, reads } = fixture();
	for (const name of names) {
		for (const grant_id of [undefined, null, 7, ["grt_a"], "", "grt_unknown"]) {
			const result = await request(profile, "tools/call", {
				name,
				arguments: {
					...validArgs[name],
					...(["query_records", "fetch"].includes(name)
						? { expand: ["related"] }
						: {}),
					...(grant_id === undefined ? {} : { grant_id }),
				},
			});
			assert.equal(result.status, 200);
			assert.equal(
				result.body.result.isError,
				true,
				`${name}: ${JSON.stringify(grant_id)}`,
			);
		}
	}
	const singleton = { children: profile.children.slice(0, 1) };
	for (const name of names) {
		const result = await request(singleton, "tools/call", {
			name,
			arguments: validArgs[name],
		});
		assert.equal(result.status, 200);
		assert.equal(
			result.body.result.isError,
			true,
			"single-child package still requires grant_id",
		);
	}
	assert.deepEqual(reads, []);
});

test("package profile discovery and inactive errors do not read children", async () => {
	const { profile, reads } = fixture();
	const discovery = await request(profile, "tools/call", {
		name: "list_package_children",
		arguments: {},
	});
	assert.deepEqual(
		discovery.body.result.structuredContent.children,
		profile.children.map(({ rs: _rs, ...metadata }) => metadata),
	);
	for (const grant_id of ["grt_revoked", "grt_expired"]) {
		for (const name of names) {
			const result = await request(profile, "tools/call", {
				name,
				arguments: { ...validArgs[name], grant_id },
			});
			assert.equal(result.status, 200);
			assert.equal(result.body.result.isError, true);
			assert.equal(
				result.body.result.structuredContent.error.code,
				"package_child_inactive",
			);
			assert.equal(
				result.body.result.structuredContent.error.grant_id,
				grant_id,
			);
			assert.match(result.body.result.content[0].text, ENDED_ACCESS_TEXT);
		}
	}
	assert.deepEqual(reads, []);
});

test("package profile uses only the selected child's schema and search, and preserves record data", async () => {
	const { profile, reads } = fixture();
	for (const name of names) {
		const result = await request(profile, "tools/call", {
			name,
			arguments: { ...validArgs[name], grant_id: "grt_a" },
		});
		assert.equal(result.body.result.isError, undefined);
		assert.ok(reads.length > 0);
		assert.ok(reads.every((read) => read.startsWith("a:")));
		if (name === "query_records") {
			assert.deepEqual(result.body.result.structuredContent.data.data[0].args, {
				keep: true,
			});
		}
		if (name === "search") {
			const originalText = result.body.result.content[0].text;
			assert.ok(originalText.includes("Include grant_id=grt_a."));
			const readHints = originalText
				.split("\n")
				.filter((entry: string) => entry.includes(" read=read_record_field"));
			assert.ok(readHints.length > 0);
			for (const line of readHints) {
				assert.ok(line.includes(" grant_id=grt_a"));
			}
			const ladder = result.body.result.structuredContent.content_ladder;
			const windows = ladder.records[0].field_windows;
			assert.equal(windows[0].read.args.grant_id, "grt_a");
			assert.ok(
				result.body.result.content.some((entry: { text: string }) =>
					entry.text.includes('"grant_id":"grt_a"'),
				),
			);
			const followup = windows[0].read;
			const field = await request(profile, "tools/call", {
				name: followup.tool,
				arguments: followup.args,
			});
			assert.equal(
				field.body.result.isError,
				undefined,
				JSON.stringify({ followup, result: field.body }),
			);
		}
	}
});

test("package profile exposes selectors and blocks resource URI bypasses; ordinary surface stays unchanged", async () => {
	const { profile, reads } = fixture();
	const list = await request(profile, "tools/list", {});
	assert.deepEqual(
		list.body.result.tools.map((tool: { name: string }) => tool.name),
		[...names, "list_package_children"],
	);
	for (const tool of list.body.result.tools.slice(0, 6)) {
		assert.equal(tool.inputSchema.properties.grant_id.type, "string");
		assert.ok(tool.inputSchema.required.includes("grant_id"));
	}
	const templates = await request(profile, "resources/templates/list", {});
	assert.equal(templates.body.error.code, -32_601);
	for (const uri of [
		"pdpp://stream/notes",
		"pdpp://record/conn_a%2Fnotes%3Aa",
		"pdpp://record-field/disguised",
	]) {
		const result = await request(profile, "resources/read", { uri });
		assert.ok(result.body.error);
	}
	assert.deepEqual(reads, []);
	const ordinary = await request(undefined, "tools/list", {});
	assert.deepEqual(
		ordinary.body.result.tools.map((tool: { name: string }) => tool.name),
		names,
	);
	assert.ok(
		ordinary.body.result.tools.every(
			(tool: { inputSchema: { properties: object } }) =>
				!("grant_id" in tool.inputSchema.properties),
		),
	);
	const ordinaryTemplates = await request(
		undefined,
		"resources/templates/list",
		{},
	);
	assert.equal(ordinaryTemplates.body.result.resourceTemplates.length, 3);
});

test("server SDK input validation returns HTTP 200 tool errors before downstream reads", async () => {
	const { profile, reads } = fixture();
	const result = await request(profile, "tools/call", {
		name: "search",
		arguments: { grant_id: "grt_a" },
	});
	assert.equal(result.status, 200);
	assert.equal(result.body.result.isError, true);
	assert.ok(
		result.body.result.content[0].text.includes("Input validation error"),
	);
	assert.deepEqual(reads, []);
});

test("every package field-window text continuation replays verbatim without changing source evidence", async () => {
	const { profile } = fixture();
	const result = await request(profile, "tools/call", {
		name: "read_record_field",
		arguments: {
			...validArgs.read_record_field,
			grant_id: "grt_a",
			limit_chars: 16,
		},
	});
	const text = result.body.result.content[0].text;
	assert.ok(text.endsWith(SOURCE_WINDOW_TEXT));
	assert.equal(
		result.body.result.structuredContent.window.text,
		SOURCE_WINDOW_TEXT,
	);
	const adapterText = text.slice(0, -SOURCE_WINDOW_TEXT.length);
	const descriptors = adapterText
		.split("\n")
		.map((line: string) => FIELD_CONTINUATION_LINE.exec(line))
		.filter(Boolean);
	assert.equal(descriptors.length, 2);
	for (const descriptor of descriptors) {
		const args = JSON.parse(descriptor[2]);
		assert.equal(args.grant_id, "grt_a");
		assert.equal(args.limit_chars, 16);
		const replay = await request(profile, "tools/call", {
			name: "read_record_field",
			arguments: args,
		});
		assert.equal(replay.status, 200);
		assert.equal(replay.body.result.isError, undefined);
	}
});
