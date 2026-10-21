// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { codeToStatus } from "../server/routes/ref-error-status.ts";
import { mountRsRecordDetail } from "../server/routes/rs-read.ts";
import { pairwiseClientReadMap, pairwiseOwnerReadMap } from "../server/pairwise-rs-identity.ts";

const SOURCE = "https://sources.example/projection-route";
const INTERNAL_A = "cin_projection_a";
const INTERNAL_B = "cin_projection_b";
const PUBLIC_A = "opaque-projection-a";
const PUBLIC_B = "opaque-projection-b";

function bindings() {
	return [
		[PUBLIC_A, INTERNAL_A],
		[PUBLIC_B, INTERNAL_B],
	].flatMap(([instance_id, rs_instance]) =>
		["parents", "children"].map((stream) => ({
			instance_id,
			rs_instance,
			source_id: SOURCE,
			stream,
		})),
	);
}

async function invokeDetailRoute(storedRecord: Record<string, unknown>, options: { owner?: boolean; storageError?: Error } = {}) {
	const grant = {
		source: { id: SOURCE },
		streams: [
			{ instance_ids: [PUBLIC_A, PUBLIC_B], name: "parents" },
			{ instance_ids: [PUBLIC_A, PUBLIC_B], name: "children" },
		],
	};
	const tokenInfo = {
		client_id: options.owner ? "@owner" : "projection-test-client",
		grant,
		grant_id: "projection-test-grant",
		pdpp_instance_bindings: options.owner
			? [[PUBLIC_A, INTERNAL_A], [PUBLIC_B, INTERNAL_B]].map(([instance_id, rs_instance]) => ({
				instance_id, rs_instance, source_id: SOURCE,
			}))
			: bindings(),
		pdpp_token_kind: options.owner ? "owner" : "client",
		subject_id: "projection-test-subject",
	};
	// This is the already-authenticated context that the HTTP suite supplies
	// through remote introspection. Validate it before calling the mounted route.
	if (options.owner) pairwiseOwnerReadMap(tokenInfo);
	else pairwiseClientReadMap(tokenInfo, SOURCE, "parents");

	const emitted: Record<string, unknown>[] = [];
	let responseBody: unknown;
	let responseStatus = 200;
	let storageCalls = 0;
	let handler: ((req: unknown, res: unknown) => unknown) | undefined;
	const app = {
		get: (_path: string, ...args: unknown[]) => {
			handler = args.at(-1) as typeof handler;
			return app;
		},
	};
	const sourceDescriptor = { id: SOURCE, kind: "connector" };
	const manifest = {
		streams: [{ name: "parents" }, { name: "children" }],
	};
	const context = {
		buildClientSourceDescriptor: () => sourceDescriptor,
		buildOwnerQuerySourceDescriptor: () => sourceDescriptor,
		buildSourceDescriptor: () => sourceDescriptor,
		resolveNativeManifest: () => null,
		resolveOwnerReadScope: async () => ({ source: sourceDescriptor }),
		resolveOwnerManifestFromScope: async () => ({ manifest, storageBinding: { connector_id: "projection-connector" } }),
		buildOwnerReadGrant: () => ({ streams: [{ name: "parents" }] }),
		buildQueryActorContext: () => ({
			actorId: "projection-test-subject",
			actorType: options.owner ? "owner" : "client",
			scenarioId: null,
			traceId: null,
		}),
		decorateRecordBlobRefs: (record: unknown) => record,
		emitQueryReceived: async () => undefined,
		emitSpineEvent: async (event: Record<string, unknown>) => {
			emitted.push(event);
		},
		ensureRequestId: () => "projection-query",
		finalizeCanonicalEnvelope: (value: unknown) => value,
		getRecordAcrossBindings: async () => {
			storageCalls++;
			if (options.storageError) throw options.storageError;
			return storedRecord;
		},
		opts: {},
		ownerSubjectIdForBindings: () => "projection-test-subject",
		rejectQuery: async (
			res: { json: (value: unknown) => unknown },
			_req: unknown,
			_context: unknown,
			err: Error & { code?: string },
		) => {
			responseStatus = codeToStatus[err.code ?? "api_error"] || 500;
			return res.json({
				error: { code: err.code ?? "api_error", message: err.message },
			});
		},
		resolveGrantManifest: async () => ({
			manifest,
			source: sourceDescriptor,
			storageBinding: { connector_id: "projection-connector" },
		}),
		resolveReadRequestBindings: async () => ({
			bindings: [
				{
					connectorId: "projection-connector",
					connectorInstanceId: INTERNAL_A,
				},
			],
		}),
		setReferenceTraceId: () => undefined,
		validatePairwiseReadBindingOwnership: async () => undefined,
		validateRequestedQueryFieldParams: () => undefined,
	};

	mountRsRecordDetail(app as never, context as never);
	assert.ok(handler, "mounted detail handler was not registered");
	const req = {
		headers: { authorization: "Bearer already-authenticated-fixture" },
		params: { id: "parent-key", stream: "parents" },
		path: "/v1/streams/parents/records/parent-key",
		query: { instance_id: PUBLIC_A },
		tokenInfo,
		url: `/v1/streams/parents/records/parent-key?instance_id=${PUBLIC_A}`,
	};
	const res = {
		json: (value: unknown) => {
			responseBody = value;
			return value;
		},
		send: (value: unknown) => value,
		setHeader: () => undefined,
	};
	await handler(req, res);
	return { emitted, responseBody, responseStatus, storageCalls };
}

const malformedEnvelopes = [
	[
		"requires stored parent identity",
		{ data: { id: "parent-key" } },
	],
	[
		"rejects a parent from another selected instance",
		{ connection_id: INTERNAL_B, data: { id: "parent-key" } },
	],
	[
		"rejects conflicting parent identity aliases",
		{
			connection_id: INTERNAL_A,
			connector_instance_id: INTERNAL_B,
			data: { id: "parent-key" },
		},
	],
	[
		"rejects an expanded child from another instance",
		{
			connection_id: INTERNAL_A,
			data: { id: "parent-key" },
			expanded: {
				children: {
					data: [
						{
							connection_id: INTERNAL_B,
							data: { id: "child-key" },
						},
					],
				},
			},
		},
	],
] as const;

for (const [name, storedRecord] of malformedEnvelopes) {
	test(`record detail projection boundary ${name}`, async () => {
		const outcome = await invokeDetailRoute(storedRecord);
		assert.equal(
			(outcome.responseBody as { error?: { code?: string } })?.error?.code,
			"grant_invalid",
		);
		assert.deepEqual(
			outcome.emitted.filter(
				(event) =>
					event.event_type === "disclosure.served" &&
					event.status === "succeeded",
			),
			[],
		);
		assert.ok(!JSON.stringify(outcome.responseBody).includes(INTERNAL_A));
		assert.ok(!JSON.stringify(outcome.responseBody).includes(INTERNAL_B));
	});
}

for (const [code, message, status, owner] of [
	["stream_not_declared", "The requested stream is not declared", 404, false],
	["invalid_expand", "The record expansion request is invalid", 400, true],
] as const) {
	test(`record detail preserves safe ${code} response and status`, async () => {
		const privateText = "cin_error_private subject_error_private backend-private";
		const error = Object.assign(new Error(privateText), { code, param: privateText, private_id: privateText });
		const result = await invokeDetailRoute({}, { owner, storageError: error });
		assert.equal(result.storageCalls, 1, "must reach the injected production read seam");
		assert.equal(result.responseStatus, status);
		assert.deepEqual(result.responseBody, { error: { code, message } });
		assert.equal(JSON.stringify(result.responseBody).includes(privateText), false);
		assert.equal(result.emitted.some((event) => event.event_type === "disclosure.served"), false);
	});
}
