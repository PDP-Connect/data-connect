// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Characterization tests for the legacy-era (2025-06-18 and 2025-11-25) wire
// behavior of the hosted MCP route (`server/routes/rs-hosted-mcp.ts`).
//
// These pin what the server does TODAY so that a later SDK upgrade shows every
// change to a legacy response shape as a test diff. They are not a claim that
// the pinned behavior is correct, and several pins deliberately disagree with
// the MCP 2026-07-28 spec:
//   - tools/list schemas carry the draft-07 `$schema` and `execution` hints
//     (the spec default dialect is JSON Schema 2020-12).
//   - an unknown tool name is a 200 `isError` result, not a protocol error.
//   - DELETE /mcp answers 200; the spec says servers SHOULD answer 405.
//     (GET /mcp already answers 405 with `Allow: POST, DELETE`.)
//   - an unsupported `MCP-Protocol-Version` is 400 with JSON-RPC code -32000
//     (the spec renumbers this to -32022 with `data.supported`).
// When behavior changes on purpose, update the pin in the same change.
//
// Already pinned elsewhere, so only referenced here:
//   - `serverInfo.name`, `serverInfo.icons` and the icon `Link` header on
//     initialize, and the sorted tool-name set: `hosted-mcp-oauth.test.ts`
//     ("hosted MCP OAuth code flow issues a scoped client token usable at /mcp").
//   - 421 for an untrusted Host, 401 for a missing token: `hosted-mcp-oauth.test.ts`.
// This file repeats the icons inside the whole-object initialize pin because a
// partial assertion would let other fields drift unnoticed.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { PDPP_MCP_INSTRUCTIONS } from "@pdpp/mcp-server/server";
import { productServerIcons } from "../server/product-icons.ts";
import {
	type PermanentAudienceFixture,
	startPermanentAudienceFixture,
} from "./helpers/mcp-existing-client-session.ts";

type JsonObject = Record<string, unknown>;

interface WireResponse {
	readonly body: unknown;
	readonly headers: Headers;
	readonly status: number;
	readonly text: string;
}

const LEGACY_VERSIONS = ["2025-06-18", "2025-11-25"] as const;

const HOSTED_TOOL_NAMES_IN_ORDER = [
	"schema",
	"query_records",
	"aggregate",
	"search",
	"fetch",
	"read_record_field",
];

const LEGACY_TOOL_ENTRY = {
	$schema: "http://json-schema.org/draft-07/schema#",
	execution: { taskSupport: "forbidden" },
};

let fixture: PermanentAudienceFixture;

before(async () => {
	fixture = await startPermanentAudienceFixture();
});

after(async () => {
	await fixture.close();
});

async function wire(
	method: "DELETE" | "GET" | "POST",
	message?: JsonObject,
	extraHeaders: Record<string, string> = {},
): Promise<WireResponse> {
	const headers: Record<string, string> = {
		Accept: "application/json, text/event-stream",
		Authorization: `Bearer ${fixture.client}`,
		...extraHeaders,
	};
	if (message !== undefined) {
		headers["Content-Type"] = "application/json";
	}
	const init: RequestInit = { headers, method };
	if (message !== undefined) {
		init.body = JSON.stringify(message);
	}
	const response = await fetch(`${fixture.rsUrl}/mcp`, init);
	const text = await response.text();
	return {
		body: text === "" ? undefined : JSON.parse(text),
		headers: response.headers,
		status: response.status,
		text,
	};
}

function initializeMessage(protocolVersion: string): JsonObject {
	return {
		id: 1,
		jsonrpc: "2.0",
		method: "initialize",
		params: {
			capabilities: {},
			clientInfo: { name: "legacy-wire-test", version: "0.0.0" },
			protocolVersion,
		},
	};
}

function post(
	message: JsonObject,
	protocolVersion: string,
): Promise<WireResponse> {
	return wire("POST", message, { "MCP-Protocol-Version": protocolVersion });
}

describe("hosted MCP legacy wire: initialize", () => {
	for (const version of LEGACY_VERSIONS) {
		test(`initialize ${version}: status, content type, whole result, no session id`, async () => {
			const response = await wire("POST", initializeMessage(version));

			assert.equal(response.status, 200);
			assert.equal(response.headers.get("content-type"), "application/json");
			assert.equal(
				response.headers.get("mcp-session-id"),
				null,
				"legacy mode is stateless",
			);
			// serverInfo.version is the reference revision, which varies per build;
			// the response carries the same value in a header, so pin the equality.
			const revision = response.headers.get("pdpp-reference-revision");
			assert.match(revision ?? "", /^pdpp-reference@/);
			assert.deepStrictEqual(response.body, {
				id: 1,
				jsonrpc: "2.0",
				result: {
					capabilities: {
						resources: { listChanged: true },
						tools: { listChanged: true },
					},
					instructions: PDPP_MCP_INSTRUCTIONS,
					protocolVersion: version,
					serverInfo: {
						icons: productServerIcons(fixture.rsUrl),
						name: "pdpp-reference-mcp",
						version: revision,
					},
				},
			});
		});
	}
});

describe("hosted MCP legacy wire: tools/list", () => {
	for (const version of LEGACY_VERSIONS) {
		test(`tools/list ${version}: ordered names, stable across calls, schema dialect`, async () => {
			const listMessage = {
				id: 2,
				jsonrpc: "2.0",
				method: "tools/list",
				params: {},
			};
			const first = await post(listMessage, version);
			const second = await post(listMessage, version);

			for (const response of [first, second]) {
				assert.equal(response.status, 200);
				assert.equal(response.headers.get("content-type"), "application/json");
			}
			const toolsOf = (response: WireResponse) =>
				(
					response.body as {
						result: {
							tools: Array<
								JsonObject & { name: string; inputSchema: JsonObject }
							>;
						};
					}
				).result.tools;
			const firstTools = toolsOf(first);
			assert.deepStrictEqual(
				firstTools.map((tool) => tool.name),
				HOSTED_TOOL_NAMES_IN_ORDER,
			);
			assert.deepStrictEqual(
				toolsOf(second).map((tool) => tool.name),
				HOSTED_TOOL_NAMES_IN_ORDER,
				"second call must return the same order",
			);
			assert.deepStrictEqual(
				firstTools.map((tool) => ({
					$schema: tool.inputSchema.$schema,
					execution: tool.execution,
					name: tool.name,
				})),
				HOSTED_TOOL_NAMES_IN_ORDER.map((name) => ({
					...LEGACY_TOOL_ENTRY,
					name,
				})),
			);
		});
	}
});

describe("hosted MCP legacy wire: errors", () => {
	for (const version of LEGACY_VERSIONS) {
		test(`tools/call with an unknown tool ${version}: 200 isError result, not a JSON-RPC error`, async () => {
			const response = await post(
				{
					id: 3,
					jsonrpc: "2.0",
					method: "tools/call",
					params: { arguments: {}, name: "no_such_tool" },
				},
				version,
			);

			assert.equal(response.status, 200);
			assert.equal(response.headers.get("content-type"), "application/json");
			assert.deepStrictEqual(response.body, {
				id: 3,
				jsonrpc: "2.0",
				result: {
					content: [
						{
							text: "MCP error -32602: Tool no_such_tool not found",
							type: "text",
						},
					],
					isError: true,
				},
			});
		});

		test(`resources/read on an unmatched URI ${version}: JSON-RPC -32602`, async () => {
			const response = await post(
				{
					id: 4,
					jsonrpc: "2.0",
					method: "resources/read",
					params: { uri: "pdpp://unmatched.example/x" },
				},
				version,
			);

			assert.equal(response.status, 200);
			assert.equal(response.headers.get("content-type"), "application/json");
			assert.deepStrictEqual(response.body, {
				error: {
					code: -32_602,
					message:
						"MCP error -32602: Resource pdpp://unmatched.example/x not found",
				},
				id: 4,
				jsonrpc: "2.0",
			});
		});
	}

	test("MCP-Protocol-Version 2026-07-28: 400 with JSON-RPC -32000 and id null", async () => {
		const response = await post(
			{ id: 5, jsonrpc: "2.0", method: "tools/list", params: {} },
			"2026-07-28",
		);

		assert.equal(response.status, 400);
		assert.equal(response.headers.get("content-type"), "application/json");
		assert.deepStrictEqual(response.body, {
			error: {
				code: -32_000,
				message:
					"Bad Request: Unsupported protocol version: 2026-07-28 (supported versions: 2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05, 2024-10-07)",
			},
			id: null,
			jsonrpc: "2.0",
		});
	});
});

describe("hosted MCP legacy wire: GET and DELETE", () => {
	test("GET /mcp: 405 JSON-RPC error with Allow: POST, DELETE", async () => {
		const response = await wire("GET");

		assert.equal(response.status, 405);
		assert.equal(response.headers.get("content-type"), "application/json");
		assert.equal(response.headers.get("allow"), "POST, DELETE");
		assert.equal(response.headers.get("mcp-session-id"), null);
		assert.deepStrictEqual(response.body, {
			error: {
				code: -32_000,
				message: "Method not allowed: this server offers no SSE stream on GET.",
			},
			id: null,
			jsonrpc: "2.0",
		});
	});

	test("DELETE /mcp: 200 empty body, application/octet-stream, no Allow header", async () => {
		const response = await wire("DELETE");

		assert.equal(response.status, 200);
		assert.equal(
			response.headers.get("content-type"),
			"application/octet-stream",
		);
		assert.equal(response.headers.get("allow"), null);
		assert.equal(response.text, "");
	});
});
