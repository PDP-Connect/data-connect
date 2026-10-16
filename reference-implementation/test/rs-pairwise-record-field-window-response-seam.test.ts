// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { codeToStatus } from "../server/routes/ref-error-status.ts";
import { mountRsRecordFieldWindow } from "../server/routes/rs-read.ts";

const SOURCE_ID = "https://sources.example/field-window-seam";
const INTERNAL_ID = "cin_field_window_private";
const HANDLE = "inst_field_window_public";

type SeamOptions = {
	bindings?: Array<{ connectorId: string; connectorInstanceId: string }>;
	finalizeError?: Error;
	windowError?: Error;
	windowResult?: unknown;
};

async function invokeWindow(options: SeamOptions = {}) {
	let handler: ((req: unknown, res: unknown) => unknown) | undefined;
	const events: string[] = [];
	const rejected: Array<{ code?: string; message?: string; param?: string }> = [];
	let responseBody: unknown;
	let responseStatus = 200;
	const app = {
		get: (_path: string, ...args: unknown[]) => {
			handler = args.at(-1) as (req: unknown, res: unknown) => unknown;
			return app;
		},
	};
	const ctx = {
		canonicalConnectorKey: (value: string) => value,
		buildClientSourceDescriptor: () => ({ id: SOURCE_ID, kind: "connector" }),
		buildQueryActorContext: () => ({ actorId: "subject", actorType: "client", scenarioId: null, traceId: null }),
		ensureRequestId: () => "request-seam",
		emitQueryReceived: async () => {},
		emitSpineEvent: async (event: Record<string, unknown>) => {
			events.push(String(event.event_type));
		},
		finalizeCanonicalEnvelope: (body: unknown) => {
			events.push("finalize");
			if (options.finalizeError) throw options.finalizeError;
			return body;
		},
		getRecordFieldWindowAcrossBindings: async (..._args: unknown[]) => {
			events.push("storage");
			if (options.windowError) throw options.windowError;
			return options.windowResult ?? {
				field_path: "body",
				field_type: "string",
				record_key: "record",
				warnings: [],
				window: {
					complete: true,
					end_chars: 16,
					has_more: false,
					limit_chars: 4096,
					match_end_chars: null,
					match_start_chars: null,
					next_offset_chars: null,
					previous_offset_chars: null,
					start_chars: 0,
					text: "application data",
					total_chars: 16,
				},
			};
		},
		handleError: (_res: unknown, error: Error) => {
			rejected.push(error);
		},
		opts: {},
		ownerSubjectIdForBindings: () => "owner",
		rejectQuery: async (_res: unknown, _req: unknown, _context: unknown, error: Error & { code?: string; param?: string }) => {
			rejected.push(error);
			responseStatus = codeToStatus[error.code ?? "api_error"] || 500;
			return response.json({ error: { code: error.code, message: error.message, param: error.param } });
		},
		resolveGrantManifest: async () => ({
			manifest: { streams: [{ name: "stream" }] },
			source: { id: SOURCE_ID, kind: "connector" },
			storageBinding: { connector_id: "connector" },
		}),
		resolveReadRequestBindings: async () => ({
			bindings: options.bindings ?? [{ connectorId: "connector", connectorInstanceId: INTERNAL_ID }],
			warnings: [],
		}),
		requireCoreEndpointToken: () => {},
		requireToken: () => {},
		setReferenceTraceId: () => {},
		validatePairwiseReadBindingOwnership: async () => {},
	};
	const response = {
		json: (body: unknown) => {
			responseBody = body;
			return body;
		},
		send: (body: unknown) => {
			responseBody = body;
			return body;
		},
		setHeader: () => {},
	};
	mountRsRecordFieldWindow(app as never, ctx as never);
	assert.ok(handler);
	await handler(
		{
			headers: { authorization: "Bearer seam-token" },
			params: { id: "record", stream: "stream" },
			path: "/v1/streams/stream/records/record/field-window",
			url: `/v1/streams/stream/records/record/field-window?field=body&instance_id=${HANDLE}`,
			query: { field: "body", instance_id: HANDLE },
			tokenInfo: {
				client_id: "client",
				grant_id: "grant",
				pdpp_instance_bindings: [
					{ instance_id: HANDLE, rs_instance: INTERNAL_ID, source_id: SOURCE_ID, stream: "stream" },
				],
				pdpp_token_kind: "client",
				subject_id: "subject",
				grant: {
					source: { id: SOURCE_ID, kind: "connector" },
					streams: [{ fields: ["body"], instance_ids: [HANDLE], name: "stream" }],
				},
			},
		},
		response,
	);
	return { events, rejected, responseBody, responseStatus };
}

test("field-window response rejects a storage binding that differs from the selected handle", async () => {
	for (const bindings of [
		[],
		[
			{ connectorId: "connector", connectorInstanceId: INTERNAL_ID },
			{ connectorId: "connector", connectorInstanceId: "cin_other_private" },
		],
		[{ connectorId: "other-connector", connectorInstanceId: INTERNAL_ID }],
		[{ connectorId: "connector", connectorInstanceId: "cin_other_private" }],
	]) {
		const result = await invokeWindow({ bindings });
		assert.equal(result.rejected[0]?.code, "grant_invalid");
		assert.equal(result.events.includes("disclosure.served"), false);
		assert.equal(result.events.includes("storage"), false);
	}
});

test("field-window response rejects malformed or identity-bearing window metadata", async () => {
	const result = await invokeWindow({
		windowResult: {
			field_path: "body",
			field_type: "string",
			record_key: "record",
			instance_id: INTERNAL_ID,
			warnings: [],
			window: {
				complete: true,
				end_chars: 1,
				has_more: false,
				limit_chars: 4,
				match_end_chars: null,
				match_start_chars: null,
				next_offset_chars: null,
				previous_offset_chars: null,
				start_chars: 0,
				text: "x",
				total_chars: 1,
				connector_instance_id: INTERNAL_ID,
			},
		},
	});
	assert.equal(result.rejected[0]?.code, "grant_invalid");
	assert.equal(result.events.includes("disclosure.served"), false);
	assert.ok(!JSON.stringify(result.responseBody).includes(INTERNAL_ID));
	const malformedWindow = await invokeWindow({
		windowResult: {
			field_path: "body",
			field_type: "string",
			record_key: "record",
			warnings: [],
			window: {
				complete: true,
				end_chars: "1",
				has_more: false,
				limit_chars: 4,
				match_end_chars: null,
				match_start_chars: null,
				next_offset_chars: null,
				previous_offset_chars: null,
				start_chars: 0,
				text: "x",
				total_chars: 1,
			},
		},
	});
	assert.equal(malformedWindow.rejected[0]?.code, "grant_invalid");
	assert.equal(malformedWindow.events.includes("disclosure.served"), false);
	const privateType = await invokeWindow({
		windowResult: {
			field_path: "body",
			field_type: INTERNAL_ID,
			record_key: "record",
			warnings: [],
			window: {
				complete: true,
				end_chars: 1,
				has_more: false,
				limit_chars: 4,
				match_end_chars: null,
				match_start_chars: null,
				next_offset_chars: null,
				previous_offset_chars: null,
				start_chars: 0,
				text: "x",
				total_chars: 1,
			},
		},
	});
	assert.equal(privateType.rejected[0]?.code, "grant_invalid");
	assert.equal(privateType.events.includes("disclosure.served"), false);
	assert.ok(!JSON.stringify(privateType.responseBody).includes(INTERNAL_ID));
});

test("field-window response keeps application text and drops private warning fields", async () => {
	const result = await invokeWindow({
		windowResult: {
			field_path: "body",
			field_type: "string",
			record_key: "record",
			warnings: [{ code: "private-warning", message: INTERNAL_ID, private_id: INTERNAL_ID }],
			window: {
				complete: true,
				end_chars: 16,
				has_more: false,
				limit_chars: 4096,
				match_end_chars: null,
				match_start_chars: null,
				next_offset_chars: null,
				previous_offset_chars: null,
				start_chars: 0,
				text: "application data",
				total_chars: 16,
			},
		},
	});
	const body = result.responseBody as Record<string, any>;
	assert.equal(body.window.text, "application data");
	assert.deepEqual(body.meta?.warnings ?? [], []);
	assert.ok(!JSON.stringify(body.meta?.warnings ?? []).includes(INTERNAL_ID));
	assert.ok(result.events.indexOf("finalize") < result.events.indexOf("disclosure.served"));
});

test("field-window errors keep typed codes and strip private messages and params", async () => {
	const privateError = Object.assign(new Error(`backend failure ${INTERNAL_ID}`), {
		code: "field_not_text",
		param: INTERNAL_ID,
	});
	const result = await invokeWindow({ windowError: privateError });
	assert.equal(result.rejected[0]?.code, "field_not_text");
	assert.equal(result.rejected[0]?.param, undefined);
	assert.ok(!result.rejected[0]?.message?.includes(INTERNAL_ID));
	assert.equal(result.events.includes("disclosure.served"), false);
	const privateParam = Object.assign(new Error(`backend failure ${INTERNAL_ID}`), {
		code: "invalid_window",
		param: INTERNAL_ID,
	});
	const paramResult = await invokeWindow({ windowError: privateParam });
	assert.equal(paramResult.rejected[0]?.code, "invalid_window");
	assert.equal(paramResult.rejected[0]?.param, undefined);
});

test("field-window finalizer failure rejects before disclosure success", async () => {
	const result = await invokeWindow({
		finalizeError: Object.assign(new Error(`private finalizer ${INTERNAL_ID}`), { code: "internal_failure" }),
	});
	assert.equal(result.rejected[0]?.code, "api_error");
	assert.ok(!result.rejected[0]?.message?.includes(INTERNAL_ID));
	assert.equal(result.events.includes("disclosure.served"), false);
});

test("field-window error projection rejects inherited object-property codes", async () => {
	for (const code of ["constructor", "toString", "__proto__"]) {
		const result = await invokeWindow({
			windowError: Object.assign(new Error(INTERNAL_ID), { code }),
		});
		assert.equal(result.rejected[0]?.code, "api_error", code);
		assert.ok(!result.rejected[0]?.message?.includes(INTERNAL_ID));
		assert.equal(result.events.includes("disclosure.served"), false);
	}
});

test("field-window rejects an internal alias without rewriting the request query", async () => {
	let guard: ((...args: unknown[]) => unknown) | undefined;
	let rejection: (Error & { code?: string }) | undefined;
	let nextCalls = 0;
	const query = Object.freeze({ field: "body", connector_instance_id: INTERNAL_ID });
	const request = { query };
	const app = {
		get: (_path: string, ...args: unknown[]) => {
			guard = args[0] as (...args: unknown[]) => unknown;
			return app;
		},
	};
	mountRsRecordFieldWindow(app as never, {
		handleError: (_response: unknown, error: Error & { code?: string }) => {
			rejection = error;
		},
	} as never);
	assert.ok(guard);
	await guard(request, {}, () => { nextCalls++; });
	assert.equal(request.query, query);
	assert.equal(request.query.connector_instance_id, INTERNAL_ID);
	assert.equal(rejection?.code, "invalid_request");
	assert.ok(!rejection?.message.includes(INTERNAL_ID));
	assert.equal(nextCalls, 0);
});

test("field-window preserves safe stream_not_declared response and status", async () => {
	const privateText = "cin_error_private subject_error_private backend-private";
	const result = await invokeWindow({
		windowError: Object.assign(new Error(privateText), {
			code: "stream_not_declared", param: privateText, private_id: privateText,
		}),
	});
	assert.ok(result.events.includes("storage"), "must reach the injected production read seam");
	assert.equal(result.responseStatus, 404);
	assert.deepEqual(result.responseBody, {
		error: { code: "stream_not_declared", message: "The requested stream is not declared", param: undefined },
	});
	assert.equal(JSON.stringify(result.responseBody).includes(privateText), false);
	assert.equal(result.events.includes("disclosure.served"), false);
});
