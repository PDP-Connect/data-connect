// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { escapeHtml, renderKeyValueList } from "../server/hosted-ui.ts";
import type { MountAsConsentContext } from "../server/routes/as-consent.ts";
import { mountAsConsent } from "../server/routes/as-consent.ts";
import type {
	ConsentSourceNameLookup,
	ConsentUiRenderer,
	PendingGrant,
} from "../server/routes/as-consent-ui-helpers.ts";

type Handler = (req: unknown, res: unknown) => unknown | Promise<unknown>;

class FakeApp {
	readonly routes = new Map<string, Handler[]>();

	get(path: string, ...handlers: unknown[]): this {
		this.routes.set(`GET ${path}`, handlers as Handler[]);
		return this;
	}

	post(path: string, ...handlers: unknown[]): this {
		this.routes.set(`POST ${path}`, handlers as Handler[]);
		return this;
	}
}

const consentUi: ConsentUiRenderer = {
	escapeHtml,
	renderActionRow: (actions) =>
		actions
			.map((action) => `<button>${escapeHtml(action.label)}</button>`)
			.join("\n"),
	renderHostedDocument: ({ body }) =>
		`<!doctype html><html><body>${body}</body></html>`,
	renderKeyValueList,
	renderPageIntro: ({ title }) => `<h1>${escapeHtml(title)}</h1>`,
	renderResultState: ({ title, body }) =>
		`<div>${escapeHtml(title)}${escapeHtml(body)}</div>`,
	renderSurface: ({ children }) => `<section>${children}</section>`,
};

const REVIEW = {
	access_mode: "one_time",
	ai_training_consented: null,
	client: { client_id: "example-client", registration_mode: "pre_registered" },
	client_claims: null,
	expires_at: null,
	purpose_code: "data_access",
	purpose_description: null,
	resolved_streams: [
		{ name: "saved_tracks", instance_ids: ["cin_spotify_1"], fields: [] },
	],
	retention: null,
	selection_preset: null,
	source: { id: "spotify", kind: "connector" },
	source_declaration: { digest: "source-digest", version: "v1" },
	subject: { id: "owner_local" },
	version: "reference.approval-review.v1",
};
const PENDING = {
	review: REVIEW,
	reviewRevision: "review-revision",
	request: {
		client: { client_id: "example-client" },
		selection: {
			streams: [{ name: "saved_tracks", instance_ids: ["cin_spotify_1"] }],
		},
		source_binding: { id: "spotify", kind: "connector" },
	},
} as unknown as PendingGrant;
const SINGLE_PENDING = {
	request: {
		client: { client_id: "example-client" },
		selection: {
			streams: [{ name: "saved_tracks", instance_ids: ["cin_spotify_1"] }],
		},
		source_binding: { id: "spotify", kind: "connector" },
	},
} as unknown as PendingGrant;

function mount(
	resolveSourceName?: ConsentSourceNameLookup,
	pending: PendingGrant = PENDING,
): FakeApp {
	const app = new FakeApp();
	const ctx = {
		agentConnectAttemptStore: {
			complete: async () => {},
			fail: async () => {},
		},
		buildPendingConsentRequestUri: (deviceCode: string) =>
			`request:${deviceCode}`,
		consentStore: {
			approveGrant: async () => ({
				grant: { grant_id: "grant" },
				token: "token",
			}),
			denyGrant: async () => true,
			getPendingConsentByApprovalId: async () => null,
			getPendingConsentByDeviceCode: async () => pending,
			parseRequestUri: (requestUri: string) =>
				requestUri === "request-uri" ? "device-code" : null,
		},
		consentUi,
		consumeConsentExchangeCode: async () => ({ ok: false }),
		createConsentExchangeCode: async () => "exchange-code",
		handleError: (_res: unknown, err: unknown) => {
			throw err;
		},
		issueOAuthAuthorizationCodeForDeviceCode: async () => null,
		issueOAuthAuthorizationCodeForPackageDeviceCode: async () => null,
		ownerAuth: {
			csrfFieldName: "_csrf",
			enabled: false,
			ensureCsrfToken: () => "csrf",
			requireCsrf: (_req: unknown, _res: unknown, next: () => void) => next(),
			requireOwnerSession: (_req: unknown, _res: unknown, next: () => void) =>
				next(),
			subjectId: "owner_local",
		},
		pdppError: (
			res: unknown,
			status: number,
			code: string,
			message: string,
		) => {
			(res as { status: (code: number) => { json: (body: unknown) => void } })
				.status(status)
				.json({ error: { code, message } });
		},
		providerName: "PDPP",
		resolveBaseUrl: () => "https://pdpp.test",
		resolveIssuer: () => "https://pdpp.test",
		resolveSourceName,
		setReferenceTraceId: () => {},
	};
	mountAsConsent(
		app as unknown as Parameters<typeof mountAsConsent>[0],
		ctx as unknown as MountAsConsentContext,
	);
	return app;
}

function makeResponse(): {
	body?: unknown;
	statusCode: number;
	response: unknown;
} {
	const captured = { body: undefined as unknown, statusCode: 200 };
	const response = {
		json(body: unknown) {
			captured.body = body;
			return response;
		},
		redirect(_status: number, url: string) {
			captured.body = url;
			return response;
		},
		send(body: unknown) {
			captured.body = body;
			return response;
		},
		setHeader: () => {},
		status(code: number) {
			captured.statusCode = code;
			return response;
		},
	};
	return {
		get body() {
			return captured.body;
		},
		get statusCode() {
			return captured.statusCode;
		},
		response,
	};
}

function makeRequest(accept: "html" | "json") {
	return {
		accepts: () => accept,
		body: { request_uri: "request-uri" },
		is: () => false,
		query: { request_uri: "request-uri" },
	};
}

async function invoke(app: FakeApp, route: string, accept: "html" | "json") {
	const handlers = app.routes.get(route);
	assert.ok(handlers, `${route} mounted`);
	const response = makeResponse();
	await handlers.at(-1)?.(makeRequest(accept), response.response);
	return response;
}

test("GET consent passes resolved source names to the consent renderer", async () => {
	const seen: Array<{ connectorId: string; connectionId: string | null }> = [];
	const app = mount(async (source) => {
		seen.push(source);
		return "Spotify · Personal listening";
	}, SINGLE_PENDING);

	const response = await invoke(app, "GET /consent", "html");

	assert.equal(response.statusCode, 200);
	assert.match(String(response.body), /Spotify · Personal listening/);
	assert.deepEqual(seen, [
		{ connectorId: "spotify", connectionId: "cin_spotify_1" },
	]);
});

test("HTML consent review passes resolved names after the JSON branch", async () => {
	const seen: Array<{ connectorId: string; connectionId: string | null }> = [];
	const app = mount(async (source) => {
		seen.push(source);
		return "Spotify · Personal listening";
	});

	const response = await invoke(app, "POST /consent/review", "html");

	assert.equal(response.statusCode, 200);
	assert.match(String(response.body), /Spotify · Personal listening/);
	assert.deepEqual(seen, [
		{ connectorId: "spotify", connectionId: "cin_spotify_1" },
	]);
});

test("JSON consent review is byte-identical with or without a source-name lookup", async () => {
	const withoutLookup = await invoke(mount(), "POST /consent/review", "json");
	let lookups = 0;
	const withLookup = await invoke(
		mount(async () => {
			lookups += 1;
			return "Spotify";
		}),
		"POST /consent/review",
		"json",
	);

	assert.equal(
		JSON.stringify(withLookup.body),
		JSON.stringify(withoutLookup.body),
	);
	assert.equal(
		lookups,
		0,
		"JSON review returns before owner-facing labels are resolved",
	);
});
