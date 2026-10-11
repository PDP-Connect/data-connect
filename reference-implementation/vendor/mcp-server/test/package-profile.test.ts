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

const FIELD_TOTAL_CHARS = 64;

// Offset-dependent window: offset 0 keeps the source-imitation text; other
// offsets carry their own offset so a replay at the wrong offset is visible.
function fieldWindowAt(offset: number, limit: number) {
	const end = Math.min(offset + limit, FIELD_TOTAL_CHARS);
	const next = end < FIELD_TOTAL_CHARS ? end : null;
	return {
		complete: next === null,
		end_chars: end,
		limit_chars: limit,
		next_offset_chars: next,
		previous_offset_chars: Math.max(offset - limit, 0),
		start_chars: offset,
		text: offset === 0 ? SOURCE_WINDOW_TEXT : `text@${offset}`,
	};
}

type Fault = "always-first-child" | "drop-offset";

function fixture(fault?: Fault) {
	const reads: string[] = [];
	const bearers: string[] = [];
	const children = ["a", "b", "revoked", "expired"].map((id) => ({
		grant_id: `grt_${id}`,
		mode: "continuous",
		purpose: { code: "analysis" },
		rs: new RsClient({
			accessToken: `child_${id}`,
			fetch: async (url, init) => {
				bearers.push(
					`${id}:${new Headers(init?.headers).get("authorization")}`,
				);
				if (String(url).includes("/field-window")) {
					reads.push(`${id}:${String(url)}`);
					const params = new URL(String(url)).searchParams;
					return Response.json({
						connection_id: `conn_${id}`,
						field: { path: "text" },
						record_id: id,
						stream: "notes",
						window: fieldWindowAt(
							Number(params.get("offset_chars") ?? 0),
							Number(params.get("limit_chars") ?? 16),
						),
					});
				}
				if (String(url).includes("/aggregate")) {
					reads.push(`${id}:${String(url)}`);
					return Response.json({
						metric: "count",
						object: "aggregation",
						value: id === "a" ? 11 : 22,
					});
				}
				if (String(url).includes("/v1/search")) {
					reads.push(`${id}:${String(url)}`);
					return Response.json({
						hits: [
							{
								connection_id: `conn_${id}`,
								field_windows: [
									{
										field_path: "text",
										preview_status: "truncated",
										preview_text: "partial evidence",
										size_chars: 9000,
									},
								],
								id,
								record_key: id,
								stream: "notes",
							},
						],
					});
				}
				reads.push(`${id}:${String(url)}`);
				return Response.json({
					data: [
						{
							args: { keep: true },
							id,
							text: `text from ${id}`,
							tool: "user-authored-tool",
						},
					],
				});
			},
			providerUrl: "https://rs.test",
		}),
		source: { id, type: "connector" },
		status: id === "revoked" || id === "expired" ? id : "active",
		streams: [{ instance_ids: [`conn_${id}`], name: "notes" }],
	}));
	const [first] = children;
	if (fault === "always-first-child" && first) {
		for (const child of children) {
			child.rs = first.rs;
		}
	}
	if (fault === "drop-offset") {
		for (const child of children) {
			const original = child.rs.fetch;
			child.rs.fetch = (url, init) =>
				original(String(url).replace(/([?&])offset_chars=\d+&?/, "$1"), init);
		}
	}
	return { bearers, profile: { children } satisfies PackageProfile, reads };
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
			accessToken: "ordinary",
			providerUrl: "https://rs.test",
			...(profile ? { packageProfile: profile } : {}),
		},
	);
	return { body: JSON.parse(await response.text()), status: response.status };
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
		arguments: {
			...validArgs.read_record_field,
			grant_id: "grt_a",
			limit_chars: 16,
		},
		name: "read_record_field",
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
			arguments: args,
			name: "read_record_field",
		});
		assert.equal(replay.status, 200);
		assert.equal(replay.body.result.isError, undefined);
		assert.equal(
			replay.body.result.structuredContent.window.start_chars,
			args.offset_chars,
		);
	}
});

const OPERATION_PATHS: Record<string, string> = {
	aggregate: "/v1/streams/notes/aggregate",
	fetch: "/v1/streams/notes/records/",
	query_records: "/v1/streams/notes/records",
	read_record_field: "/v1/streams/notes/records/",
	schema: "/v1/schema",
	search: "/v1/search",
};

async function assertEachChildServesEveryTool(fault?: Fault) {
	for (const child of ["a", "b"]) {
		const { profile, reads, bearers } = fixture(fault);
		for (const name of names) {
			const before = reads.length;
			const bearersBefore = bearers.length;
			const result = await request(profile, "tools/call", {
				arguments: {
					...validArgs[name],
					...(name === "fetch" || name === "read_record_field"
						? { id: `conn_${child}/notes:${child}` }
						: {}),
					grant_id: `grt_${child}`,
				},
				name,
			});
			assert.equal(result.body.result.isError, undefined, `${child}/${name}`);
			const calls = reads.slice(before);
			const callBearers = bearers.slice(bearersBefore);
			assert.deepEqual(
				callBearers,
				callBearers.map(() => `${child}:Bearer child_${child}`),
				`${child}/${name} bearer`,
			);
			assert.ok(calls.length > 0, `${child}/${name} performed no read`);
			for (const read of calls) {
				assert.ok(read.startsWith(`${child}:`), `${child}/${name}: ${read}`);
				const path = OPERATION_PATHS[name];
				assert.ok(path);
				const expectedPath =
					name === "fetch" || name === "read_record_field"
						? `${path}${child}${name === "read_record_field" ? "/field-window" : ""}`
						: path;
				assert.equal(
					new URL(read.slice(child.length + 1)).pathname,
					expectedPath,
					`${child}/${name} path`,
				);
			}
			if (name === "query_records") {
				assert.equal(
					result.body.result.structuredContent.data.data[0].text,
					`text from ${child}`,
				);
			}
			if (name === "aggregate") {
				const expectedValue = child === "a" ? 11 : 22;
				assert.equal(
					result.body.result.structuredContent.data.value,
					expectedValue,
				);
				assert.ok(
					result.body.result.content[0].text.includes(
						`count(notes) = ${expectedValue}`,
					),
				);
			}
		}
	}
}

test("each selected child serves every tool alone, with per-call traces and operation-specific results", () =>
	assertEachChildServesEveryTool());

async function assertOffsetReplay(fault?: Fault) {
	const { profile } = fixture(fault);
	const call = async (extra: Record<string, unknown>) =>
		request(profile, "tools/call", {
			arguments: {
				...validArgs.read_record_field,
				grant_id: "grt_a",
				limit_chars: 16,
				...extra,
			},
			name: "read_record_field",
		});
	const descriptorsOf = (text: string) =>
		text
			.split("\n")
			.map((line: string) => FIELD_CONTINUATION_LINE.exec(line))
			.filter(Boolean)
			.map((m) => ({ args: JSON.parse(m?.[2] ?? "{}"), kind: m?.[1] }));
	const middle = await call({ offset_chars: 16 });
	const middleWindow = middle.body.result.structuredContent.window;
	assert.equal(middleWindow.start_chars, 16);
	const [previous, next] = [
		descriptorsOf(middle.body.result.content[0].text).find(
			(d) => d.kind === "previous",
		),
		descriptorsOf(middle.body.result.content[0].text).find(
			(d) => d.kind === "next",
		),
	];
	assert.equal(previous?.args.offset_chars, 0);
	assert.equal(next?.args.offset_chars, 32);
	const forward = await call(next?.args ?? {});
	assert.equal(forward.body.result.structuredContent.window.start_chars, 32);
	assert.equal(forward.body.result.structuredContent.window.text, "text@32");
	const backward = await call(previous?.args ?? {});
	assert.equal(backward.body.result.structuredContent.window.start_chars, 0);
	assert.ok(backward.body.result.content[0].text.endsWith(SOURCE_WINDOW_TEXT));
	const last = await call({ offset_chars: 48 });
	assert.equal(last.body.result.structuredContent.window.complete, true);
	assert.equal(descriptorsOf(last.body.result.content[0].text).length, 0);
}

test("field-window continuations replay at the requested offsets and reach both boundaries", () =>
	assertOffsetReplay());

test("the stronger checks fail for an adapter that always uses the first child", async () => {
	await assert.rejects(assertEachChildServesEveryTool("always-first-child"));
});

test("the stronger checks fail for an adapter that ignores the requested offset", async () => {
	await assert.rejects(assertOffsetReplay("drop-offset"));
});

async function packageInstructions() {
	const { profile } = fixture();
	const initialized = await request(profile, "initialize", {
		protocolVersion: "2025-11-25",
		capabilities: {},
		clientInfo: { name: "profile-test", version: "1" },
	});
	assert.equal(initialized.status, 200);
	assert.equal(typeof initialized.body.result.instructions, "string");
	return initialized.body.result.instructions as string;
}

test("package instructions explain explicit rediscovery and restarting grant-bound searches", async () => {
	const instructions = await packageInstructions();
	assert.match(instructions, /inspect the complete new authorization result/i);
	assert.match(instructions, /choose.*explicitly/i);
	assert.match(instructions, /restart.*search.*without.*cursor/i);
});

test("package instructions explain tool failures without a structured error envelope", async () => {
	const instructions = await packageInstructions();
	assert.match(instructions, /isError/i);
	assert.match(instructions, /no structured error/i);
});

test("package errors preserve SDK, selector, inactive, downstream and adapter families", async () => {
	const { profile, reads } = fixture();
	for (const selector of [undefined, 7, "bad", "grt_unknown", "grt_revoked"]) {
		const response = await request(profile, "tools/call", {
			arguments: selector === undefined ? {} : { grant_id: selector },
			name: "schema",
		});
		assert.equal(response.status, 200);
		const result = response.body.result;
		assert.equal(result.isError, true);
		assert.equal(result.content[0].type, "text");
		assert.ok(result.content[0].text.length > 0);
		if (selector === undefined || selector === 7) {
			assert.equal(result.structuredContent, undefined);
			assert.match(result.content[0].text, /Input validation error/);
		} else {
			const error = result.structuredContent.error;
			assert.equal(
				error.code,
				selector === "bad"
					? "invalid_grant_selector"
					: selector === "grt_unknown"
						? "unknown_grant_selector"
						: "package_child_inactive",
			);
			assert.equal(
				error.grant_id,
				selector === "grt_revoked" ? selector : undefined,
			);
			assert.equal(error.message, result.content[0].text);
		}
	}
	assert.deepEqual(reads, []);
	const child = profile.children[1];
	assert.ok(child);
	child.rs.fetch = async () =>
		Response.json(
			{ error: { code: "fixture_denied", message: "Denied fixture" } },
			{ headers: { "x-request-id": "request_fixture" }, status: 403 },
		);
	const downstream = await request(profile, "tools/call", {
		arguments: { grant_id: "grt_b" },
		name: "schema",
	});
	assert.equal(downstream.status, 200);
	assert.equal(downstream.body.result.isError, true);
	assert.deepEqual(downstream.body.result.structuredContent, {
		error: {
			code: "fixture_denied",
			message: "Denied fixture",
			request_id: "request_fixture",
		},
		http_status: 403,
		provider_url: "https://rs.test",
		request_id: "request_fixture",
	});
	child.rs.fetch = async () => {
		throw new Error("Fixture transport failed");
	};
	const adapter = await request(profile, "tools/call", {
		arguments: { grant_id: "grt_b" },
		name: "schema",
	});
	assert.equal(adapter.status, 200);
	assert.equal(adapter.body.result.isError, true);
	assert.deepEqual(adapter.body.result.structuredContent.error, {
		code: "tool_handler_error",
		message: "Fixture transport failed",
		type: "adapter_error",
	});
});
