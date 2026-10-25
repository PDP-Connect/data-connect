// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import "tsx";

import { handleStreamableHttpRequest } from "../src/server.ts";

// The hosted MCP endpoint is stateless and answers every POST with plain JSON.
// It has no server-to-client stream to offer. The Streamable HTTP spec (2025-11-25,
// "Listening for Messages from the Server") says such a server MUST answer GET
// with 405 Method Not Allowed. The SDK default opens an SSE stream, and the
// per-request `transport.close()` then ends it at once: HTTP 200 with an empty
// body. SDK clients treat that as a dropped stream and reconnect in a tight loop.

const OPTIONS = { accessToken: "tok", providerUrl: "https://provider.test" };

function mcpRequest(
	method: string,
	headers: Record<string, string> = {},
): Request {
	return new Request("https://provider.test/mcp", { method, headers });
}

test("GET /mcp with Accept: text/event-stream answers 405, not a closed 200 stream", async () => {
	const response = await handleStreamableHttpRequest(
		mcpRequest("GET", { accept: "text/event-stream" }),
		OPTIONS,
	);
	assert.equal(response.status, 405);
	assert.equal(response.headers.get("allow"), "POST");
	assert.notEqual(response.headers.get("content-type"), "text/event-stream");
});

test("GET /mcp with Last-Event-ID (stream resume) answers 405", async () => {
	const response = await handleStreamableHttpRequest(
		mcpRequest("GET", { accept: "text/event-stream", "last-event-id": "abc" }),
		OPTIONS,
	);
	assert.equal(response.status, 405);
	assert.equal(response.headers.get("allow"), "POST");
});

test("DELETE /mcp answers 405 (no sessions to terminate)", async () => {
	const response = await handleStreamableHttpRequest(
		mcpRequest("DELETE"),
		OPTIONS,
	);
	assert.equal(response.status, 405);
	assert.equal(response.headers.get("allow"), "POST");
});

test("POST /mcp still serves JSON-RPC", async () => {
	const response = await handleStreamableHttpRequest(
		new Request("https://provider.test/mcp", {
			method: "POST",
			headers: {
				accept: "application/json, text/event-stream",
				"content-type": "application/json",
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {
					protocolVersion: "2025-06-18",
					capabilities: {},
					clientInfo: { name: "t", version: "0" },
				},
			}),
		}),
		OPTIONS,
	);
	assert.equal(response.status, 200);
	assert.match(response.headers.get("content-type") ?? "", /application\/json/);
});
