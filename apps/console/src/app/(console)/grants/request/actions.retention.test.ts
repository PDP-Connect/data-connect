// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mock, type TestContext, test } from "node:test";

let loaded: Promise<typeof import("./actions.ts")> | null = null;
let events: string[] = [];
let capturedRetention: unknown;

function loadActions(): Promise<typeof import("./actions.ts")> {
	loaded ??= (async () => {
		mock.module("server-only", { namedExports: {} });
		mock.module("next/navigation", {
			namedExports: { redirect: () => {} },
		});
		mock.module(
			new URL("../../lib/dashboard-access.ts", import.meta.url).href,
			{
				namedExports: {
					requireDashboardAccess: async () => {
						events.push("owner-access");
					},
				},
			},
		);
		mock.module(new URL("../../lib/owner-token.ts", import.meta.url).href, {
			namedExports: {
				getAsInternalUrl: () => "http://127.0.0.1:1",
				getReferencePublicOrigin: async () => "https://as.example.test",
				withOwnerSessionCookie: async (init: RequestInit = {}) => init,
				ReferenceServerUnreachableError: class extends Error {},
			},
		});
		return import("./actions.ts");
	})();
	return loaded;
}

async function stageWithExpiry(t: TestContext, expiry?: string) {
	events = [];
	capturedRetention = undefined;
	const fetchMock = t.mock.method(
		globalThis,
		"fetch",
		async (_url: string | URL | Request, init?: RequestInit) => {
			events.push("stage");
			const body = JSON.parse(String(init?.body)) as {
				authorization_details: Array<{ retention: unknown }>;
			};
			capturedRetention = body.authorization_details[0]?.retention;
			return Response.json({ request_uri: "urn:example:request" });
		},
	);
	const form = new FormData();
	form.set("client_id", "client-123");
	form.set("source_id", "https://example.test/source-123");
	form.set("stream_name", "transactions");
	form.set("retention", "P30D");
	if (expiry !== undefined) form.set("retention_on_expiry", expiry);
	try {
		await (await loadActions()).stageGrantRequestAction(form);
	} finally {
		fetchMock.mock.restore();
	}
}

for (const action of ["anonymize", "delete"] as const) {
	test(`stage action sends explicit ${action} retention through the real producer`, async (t) => {
		await stageWithExpiry(t, action);
		assert.deepEqual(capturedRetention, {
			max_duration: "P30D",
			on_expiry: action,
		});
		assert.deepEqual(events, ["owner-access", "stage"]);
	});
}

test("stage action defaults a missing legacy expiry field to delete", async (t) => {
	await stageWithExpiry(t);
	assert.deepEqual(capturedRetention, {
		max_duration: "P30D",
		on_expiry: "delete",
	});
	assert.deepEqual(events, ["owner-access", "stage"]);
});

test("stage action rejects an invalid expiry value before the real producer fetch", async (t) => {
	await assert.rejects(
		stageWithExpiry(t, "keep"),
		/Invalid retention on-expiry action/,
	);
	assert.deepEqual(events, ["owner-access"]);
});
