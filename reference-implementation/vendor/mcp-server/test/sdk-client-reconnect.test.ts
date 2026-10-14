// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import "tsx";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { handleStreamableHttpRequest } from "../src/server.ts";

// End-to-end check with the official SDK client. A stateless JSON endpoint has no
// server-to-client stream; the SDK client probes GET once after `initialized` and
// must stop on the 405 instead of reconnecting in a loop. Before the 405 fix the
// same client sent one GET per second for as long as it stayed connected (a 200
// stream that closes counts as a successful connect, so the backoff never grows).

const OBSERVE_MS = 3000;

async function toWebRequest(
	req: IncomingMessage,
	port: number,
): Promise<Request> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(chunk as Buffer);
	const method = req.method ?? "GET";
	const headers = new Headers();
	for (const [name, value] of Object.entries(req.headers)) {
		if (value !== undefined)
			headers.set(name, Array.isArray(value) ? value.join(", ") : value);
	}
	return new Request(`http://127.0.0.1:${port}${req.url ?? "/"}`, {
		method,
		headers,
		body:
			method === "GET" || method === "HEAD" ? undefined : Buffer.concat(chunks),
	});
}

async function sendWebResponse(
	res: ServerResponse,
	response: Response,
): Promise<void> {
	res.writeHead(response.status, Object.fromEntries(response.headers));
	res.end(Buffer.from(await response.arrayBuffer()));
}

test("SDK client does not reconnect-storm GET against the stateless endpoint", async () => {
	const counts: Record<string, number> = {};
	const server = createServer((req, res) => {
		const { port } = server.address() as AddressInfo;
		counts[req.method ?? "?"] = (counts[req.method ?? "?"] ?? 0) + 1;
		toWebRequest(req, port)
			.then((request) =>
				handleStreamableHttpRequest(request, {
					accessToken: "tok",
					providerUrl: `http://127.0.0.1:${port}`,
				}),
			)
			.then((response) => sendWebResponse(res, response))
			.catch(() => {
				res.statusCode = 500;
				res.end();
			});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;

	const client = new Client({ name: "reconnect-test", version: "0" });
	const transport = new StreamableHTTPClientTransport(
		new URL(`http://127.0.0.1:${port}/mcp`),
	);
	try {
		await client.connect(transport);
		const { tools } = await client.listTools();
		await new Promise((resolve) => setTimeout(resolve, OBSERVE_MS));
		assert.ok(tools.length > 0, "listTools returned tools");
		assert.ok(
			(counts.GET ?? 0) <= 1,
			`GET count ${counts.GET ?? 0} over ${OBSERVE_MS}ms (all: ${JSON.stringify(counts)})`,
		);
		assert.ok(
			(counts.POST ?? 0) <= 6,
			`POST count ${counts.POST ?? 0} (all: ${JSON.stringify(counts)})`,
		);
		console.log(
			`request counts over ${OBSERVE_MS}ms window: ${JSON.stringify(counts)}`,
		);
	} finally {
		await client.close();
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});
