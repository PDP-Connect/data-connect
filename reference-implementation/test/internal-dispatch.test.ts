// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import {
	getDispatchEntry,
	getDispatchRegistrySize,
	runWithDispatchScope,
} from "../server/internal-dispatch.ts";

const tokenInfo = {
	active: true,
	aud: "https://resource.example/mcp",
	exp: Math.floor(Date.now() / 1000) + 60,
	grant_id: "grant_dispatch_test",
	pdpp_token_kind: "client",
	scope: { streams: ["orders"] },
};

test("dispatch scope injects with its live nonce and removes it after success", async () => {
	let nonce = "";
	let authorization: string | undefined;
	let injectedUrl = "";
	const app = {
		inject: async (options: {
			headers: Record<string, string>;
			method: string;
			payload?: Buffer;
			url: string;
		}) => {
		authorization = options.headers.authorization;
		nonce = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
			const storedInfo = getDispatchEntry(nonce)?.info;
			assert.notEqual(storedInfo, tokenInfo, "scope stores a structured clone");
			assert.notEqual(
				storedInfo?.scope,
				tokenInfo.scope,
				"nested authorization state is cloned too",
			);
			assert.equal("pdpp-internal-dispatch" in options.headers, false);
			assert.equal(authorization, `Bearer ${nonce}`);
			injectedUrl = options.url;
			return {
				headers: { "content-type": "application/json" },
				payload: '{"ok":true}',
				statusCode: 200,
			};
		},
	};

	const response = await runWithDispatchScope(
		tokenInfo,
		"https://resource.example/mcp",
		app,
		(dispatchFetch: typeof fetch) =>
			dispatchFetch(
				new Request("https://resource.example/v1/schema?view=compact", {
					headers: {
						Authorization: "Bearer must-not-forward",
						"X-Trace": "trace-1",
					},
				}),
			),
	);

	assert.match(nonce, /^[0-9a-f]{32}$/);
	assert.equal(authorization, `Bearer ${nonce}`);
	assert.equal(injectedUrl, "/v1/schema?view=compact");
	assert.equal(response.status, 200);
	const body = await response.text();
	assert.equal(body, '{"ok":true}');
	assert.equal(
		body.includes(nonce),
		false,
		"nonce is absent from the response body",
	);
	assert.ok(
		[...response.headers].every(([name, value]) => !name.includes(nonce) && !value.includes(nonce)),
		"nonce is absent from response headers",
	);
	assert.equal(getDispatchRegistrySize(), 0);
	assert.equal(
		getDispatchEntry(nonce),
		undefined,
		"nonce cannot be replayed after scope completion",
	);
});

test("dispatch scope removes its nonce after a tool failure", async () => {
	const app = {
		inject: async () => {
			throw new Error("tool failed");
		},
	};

	await assert.rejects(
		runWithDispatchScope(
			tokenInfo,
			"https://resource.example/mcp",
			app,
			async () => {
				throw new Error("tool failed");
			},
		),
		/tool failed/,
	);
	assert.equal(getDispatchRegistrySize(), 0);
});

test("concurrent dispatch scopes keep distinct authorization contexts", async () => {
	const observed = new Map<string, string>();
	const app = {
		inject: async ({ headers }: { headers: Record<string, string> }) => {
			const authorization = headers.authorization;
			const nonce = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
			observed.set(nonce ?? "", getDispatchEntry(nonce ?? "")?.info.grant_id as string);
			await new Promise((resolve) => setTimeout(resolve, 5));
			return { headers: {}, payload: "{}", statusCode: 200 };
		},
	};

	await Promise.all(
		["grant_a", "grant_b"].map((grant_id) =>
			runWithDispatchScope(
				{ ...tokenInfo, grant_id },
				"https://resource.example/mcp",
				app,
				(dispatchFetch: typeof fetch) =>
					dispatchFetch(new Request("https://resource.example/v1/schema")),
			),
		),
	);

	assert.equal(observed.size, 2);
	assert.ok(
		[...observed.keys()].every((nonce) => /^[0-9a-f]{32}$/.test(nonce)),
	);
	assert.equal(getDispatchRegistrySize(), 0);
});

test("P3 TODO: network requests reject MCP-audience bearers at the /v1 mount", {
	todo: "P3 per-mount audience enforcement is not in this change",
}, async () => {
	let innerAuthorization: string | undefined;
	const app = {
		inject: async ({ headers }: { headers: Record<string, string> }) => {
			innerAuthorization = headers.authorization;
			return { headers: {}, payload: "{}", statusCode: 200 };
		},
	};
	await runWithDispatchScope(
		tokenInfo,
		"https://resource.example/mcp",
		app,
		(dispatchFetch: typeof fetch) =>
			dispatchFetch(
				new Request("https://resource.example/v1/schema", {
					headers: { Authorization: "Bearer mcp-audience-token" },
				}),
			),
	);
	assert.equal(
		innerAuthorization?.startsWith("Bearer "),
		true,
		"the internal request uses a bearer nonce rather than the MCP bearer",
	);
	assert.notEqual(innerAuthorization, "Bearer mcp-audience-token");
});

test("aborting the outer request deletes its dispatch context immediately", async () => {
	const controller = new AbortController();
	let finish: (() => void) | undefined;
	const pending = runWithDispatchScope(
		tokenInfo,
		"https://resource.example/mcp",
		{ inject: async () => ({ headers: {}, payload: "{}", statusCode: 200 }) },
		() =>
			new Promise<void>((resolve) => {
				finish = resolve;
			}),
		controller.signal,
	);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(getDispatchRegistrySize(), 1);
	controller.abort();
	assert.equal(getDispatchRegistrySize(), 0);
	finish?.();
	await pending;
});

test("an already-aborted request cannot open a dispatch scope", async () => {
	const controller = new AbortController();
	controller.abort();
	let dispatched = false;

	await assert.rejects(
		runWithDispatchScope(
			tokenInfo,
			"https://resource.example/mcp",
			{ inject: async () => ({ headers: {}, payload: "{}", statusCode: 200 }) },
			async () => {
				dispatched = true;
			},
			controller.signal,
		),
		{ name: "AbortError" },
	);
	assert.equal(dispatched, false, "an aborted outer request must not begin tool work");
	assert.equal(getDispatchRegistrySize(), 0);
});
