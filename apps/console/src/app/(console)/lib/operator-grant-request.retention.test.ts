// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { validateCoreSelectionRequest } from "../../../../../../reference-implementation/server/core-source-authorization.ts";
import type {
	GrantRequestDraft,
	GrantRequestWorkspace,
} from "./operator-grant-request.ts";

let loaded: Promise<typeof import("./operator-grant-request.ts")> | null = null;
let parBody: Record<string, unknown> | null = null;

function loadProducer(): Promise<typeof import("./operator-grant-request.ts")> {
	loaded ??= (async () => {
		mock.module("server-only", { namedExports: {} });
		mock.module("./owner-token.ts", {
			namedExports: {
				getAsInternalUrl: () => "http://127.0.0.1:1",
				getReferencePublicOrigin: async () => "https://as.example.test",
				withOwnerSessionCookie: async (init: RequestInit = {}) => init,
				ReferenceServerUnreachableError: class extends Error {},
			},
		});
		return import("./operator-grant-request.ts");
	})();
	return loaded;
}

function requestBodyFromCurl(curl: string): Record<string, unknown> {
	const data = curl.match(/--data '([^']+)'/);
	assert.ok(data, "stage example includes a request body");
	const body = data[1];
	assert.ok(body);
	return JSON.parse(body) as Record<string, unknown>;
}

test("real grant producer emits a contract-shaped instance pin and retention matching its example", async (t) => {
	const producer = await loadProducer();
	const fetchMock = t.mock.method(
		globalThis,
		"fetch",
		async (_url: string | URL | Request, init?: RequestInit) => {
			parBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return Response.json({ request_uri: "urn:example:request" });
		},
	);

	const workspace = await producer.stageGrantRequest(undefined, {
		clientId: "client-123",
		connectionId: "cin_selected_b",
		sourceId: "https://example.test/source-123",
		streamName: "transactions",
		retention: "P30D",
		retentionOnExpiry: "anonymize",
	} satisfies Partial<GrantRequestDraft>);
	assert.equal(fetchMock.mock.callCount(), 1);
	assert.ok(parBody);
	const detail = (
		parBody.authorization_details as Record<string, unknown>[]
	)[0];
	assert.ok(detail);
	assert.deepEqual(detail.retention, {
		max_duration: "P30D",
		on_expiry: "anonymize",
	});
	assert.equal(detail.access_mode, "single_use");
	assert.equal(
		detail.source && (detail.source as Record<string, unknown>).id,
		"https://example.test/source-123",
	);
	const selection = detail.streams as Record<string, unknown>[];
	assert.ok(selection[0]);
	assert.equal(selection[0].name, "transactions");
	assert.deepEqual(selection[0].instance_ids, ["cin_selected_b"]);
	assert.equal("connection_id" in selection[0], false);
	assert.deepEqual(validateCoreSelectionRequest(detail), detail);

	const examples = await producer.buildGrantRequestExamples(workspace);
	const exampleBody = requestBodyFromCurl(examples.stageCurl);
	const exampleDetail = (
		exampleBody.authorization_details as Record<string, unknown>[]
	)[0];
	assert.ok(exampleDetail);
	assert.deepEqual(exampleDetail.retention, detail.retention);
	assert.deepEqual(exampleDetail.streams, detail.streams);
	assert.equal(exampleDetail.client_id, undefined);
	assert.equal(exampleBody.client_id, "client-123");
});

test("retention defaults to delete, including drafts saved before the action field existed", async () => {
	const producer = await loadProducer();
	const draft = producer.createDefaultGrantRequestDraft();
	assert.equal(draft.retentionOnExpiry, "delete");
	const legacy = producer.updateGrantRequestWorkspaceDraft(undefined, {
		retention: "P30D",
	});
	const oldDraft = { ...legacy.draft } as Partial<GrantRequestDraft>;
	delete oldDraft.retentionOnExpiry;
	const examples = await producer.buildGrantRequestExamples({
		...legacy,
		draft: oldDraft as GrantRequestDraft,
	} satisfies GrantRequestWorkspace);
	const detail = (
		requestBodyFromCurl(examples.stageCurl).authorization_details as Record<
			string,
			unknown
		>[]
	)[0];
	assert.ok(detail);
	assert.deepEqual(detail.retention, {
		max_duration: "P30D",
		on_expiry: "delete",
	});
});

test("invalid nonempty expiry action is rejected before HTTP", async (t) => {
	const producer = await loadProducer();
	const fetchMock = t.mock.method(globalThis, "fetch", async () =>
		Response.json({ request_uri: "urn:example" }),
	);
	await assert.rejects(
		producer.stageGrantRequest(undefined, {
			clientId: "client-123",
			sourceId: "https://example.test/source-123",
			streamName: "transactions",
			retentionOnExpiry: "keep",
		}),
		/on-expiry action/,
	);
	assert.equal(fetchMock.mock.callCount(), 0);
});
