// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// RFC 9207: every authorization response sent to a client's redirect_uri
// carries `iss`, and `iss` equals the `issuer` of the authorization server
// metadata for the same request. Each test drives a real server through one
// redirect-building path and compares against the live metadata document.

import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildAuthorizationResponseUrl } from "../server/authorization-response.ts";
import { canonicalConnectorKeyFromManifest } from "../server/connector-key.ts";
import { startServer } from "../server/index.ts";
import { computeHostedMcpDecisionDigest } from "../server/routes/as-consent-ui-helpers.ts";
import { createSqliteConnectorInstanceStore } from "../server/stores/connector-instance-store.ts";
import { TEST_INTROSPECTION_SERVER_OPTS } from "./helpers/introspection-test-credentials.ts";

const REDIRECT_URI = "https://client.example/callback";
const REFERENCE_IMPL_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

interface TestServer {
	readonly asPort: number;
	readonly asServer: {
		closeAllConnections?: () => void;
		close: (callback: () => void) => void;
	};
	readonly rsServer: {
		closeAllConnections?: () => void;
		close: (callback: () => void) => void;
	};
	readonly schedulerManager?: { stop?: () => void } | null;
}

async function closeServer(server: TestServer): Promise<void> {
	server.schedulerManager?.stop?.();
	server.asServer.closeAllConnections?.();
	server.rsServer.closeAllConnections?.();
	await Promise.allSettled([
		new Promise<void>((resolve) => server.asServer.close(() => resolve())),
		new Promise<void>((resolve) => server.rsServer.close(() => resolve())),
	]);
}

function startTestServer(
	extra: Record<string, unknown> = {},
): Promise<TestServer> {
	return startServer({
		asPort: 0,
		dbPath: ":memory:",
		ownerAuthPassword: "",
		quiet: true,
		rsPort: 0,
		...TEST_INTROSPECTION_SERVER_OPTS,
		...extra,
	}) as Promise<TestServer>;
}

async function fetchJson(
	url: string,
	init: RequestInit = {},
): Promise<{ body: Record<string, unknown>; status: number }> {
	const resp = await fetch(url, init);
	return {
		body: (await resp.json()) as Record<string, unknown>,
		status: resp.status,
	};
}

function str(record: Record<string, unknown>, field: string): string {
	const value = record[field];
	assert.equal(typeof value, "string", `${field} must be a string`);
	return value as string;
}

function pkceChallenge(verifier: string): string {
	return createHash("sha256").update(verifier).digest("base64url");
}

async function metadataIssuer(asUrl: string): Promise<string> {
	const { body, status } = await fetchJson(
		`${asUrl}/.well-known/oauth-authorization-server`,
	);
	assert.equal(status, 200);
	return str(body, "issuer");
}

interface Manifest {
	connector_id: string;
	source_declaration?: { source?: { id?: string } };
	streams: Array<{ name: string }>;
}

async function registerSpotify(asUrl: string): Promise<Manifest> {
	const raw = JSON.parse(
		readFileSync(
			join(REFERENCE_IMPL_DIR, "fixtures/seed-manifests/spotify.json"),
			"utf8",
		),
	);
	const canonical = canonicalConnectorKeyFromManifest(raw);
	const manifest: Manifest = canonical
		? { ...raw, connector_id: canonical }
		: raw;
	const { status } = await fetchJson(`${asUrl}/connectors`, {
		body: JSON.stringify(manifest),
		headers: { "Content-Type": "application/json" },
		method: "POST",
	});
	assert.equal(status, 201);
	const now = new Date().toISOString();
	const connectorInstanceId = `cin_hosted_${manifest.connector_id}`;
	await createSqliteConnectorInstanceStore().upsert({
		connectorId: manifest.connector_id,
		connectorInstanceId,
		createdAt: now,
		displayName: "test account",
		ownerSubjectId: "owner_local",
		sourceBinding: { fixture: connectorInstanceId },
		sourceBindingKey: connectorInstanceId,
		sourceKind: "account",
		status: "active",
		updatedAt: now,
	});
	return manifest;
}

async function registerClient(asUrl: string): Promise<string> {
	const { body, status } = await fetchJson(`${asUrl}/oauth/register`, {
		body: JSON.stringify({
			application_type: "web",
			client_name: "Issuer test client",
			grant_types: ["authorization_code"],
			redirect_uris: [REDIRECT_URI],
			response_types: ["code"],
			token_endpoint_auth_method: "none",
		}),
		headers: { "Content-Type": "application/json" },
		method: "POST",
	});
	assert.equal(status, 201);
	return str(body, "client_id");
}

function authorizeUrl(asUrl: string, clientId: string, state: string): URL {
	const url = new URL(`${asUrl}/oauth/authorize`);
	url.searchParams.set("client_id", clientId);
	url.searchParams.set("redirect_uri", REDIRECT_URI);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("state", state);
	url.searchParams.set(
		"code_challenge",
		pkceChallenge(randomBytes(32).toString("base64url")),
	);
	url.searchParams.set("code_challenge_method", "S256");
	return url;
}

async function parkConsentChallenge(
	asUrl: string,
	clientId: string,
	state: string,
): Promise<string> {
	const resp = await fetch(authorizeUrl(asUrl, clientId, state), {
		redirect: "manual",
	});
	assert.equal(resp.status, 302);
	const location = new URL(resp.headers.get("location") ?? "", asUrl);
	const challenge = location.searchParams.get("challenge");
	assert.ok(challenge, "the picker branch must park a consent challenge");
	return challenge;
}

function assertAuthorizationResponse(
	location: URL,
	expectedIssuer: string,
	state: string,
): void {
	assert.equal(location.origin + location.pathname, REDIRECT_URI);
	assert.equal(
		location.searchParams.get("state"),
		state,
		"state must round-trip",
	);
	assert.equal(
		location.searchParams.getAll("iss").length,
		1,
		"iss must appear exactly once",
	);
	assert.equal(
		location.searchParams.get("iss"),
		expectedIssuer,
		"iss must equal the metadata issuer",
	);
}

test("metadata advertises authorization_response_iss_parameter_supported", async () => {
	const server = await startTestServer();
	try {
		const { body, status } = await fetchJson(
			`http://localhost:${server.asPort}/.well-known/oauth-authorization-server`,
		);
		assert.equal(status, 200);
		assert.equal(body.authorization_response_iss_parameter_supported, true);
	} finally {
		await closeServer(server);
	}
});

// The decision a console would submit for every offered source and stream,
// bound to the challenge's own review and decision digests.
async function fullDecision(
	asUrl: string,
	challenge: string,
	clientId: string,
): Promise<{
	access_mode: string;
	decision_digest: string;
	grant_expiry: string;
	review_digest: string;
	source_id: string[];
	stream: string[];
	/** The same choice in the form route's vocabulary. */
	form: { selection: string[]; stream: string[] };
}> {
	const model = (
		await fetchJson(`${asUrl}/oauth/authorize/consent-challenges/${challenge}`)
	).body as {
		grantExpiry: { defaultId: string };
		reviewDigest: string;
		sources: Array<{
			id: string;
			selectionValue: string;
			streams: Array<{ id: string; name: string; selectionValue: string }>;
		}>;
	};
	assert.ok(model.sources.length > 0, "the fixture connector must be offered");
	const accessMode = "continuous";
	return {
		access_mode: accessMode,
		decision_digest: computeHostedMcpDecisionDigest({
			accessMode,
			clientId,
			grantExpiry: model.grantExpiry.defaultId,
			sources: model.sources.map((source) => ({
				sourceKey: source.id,
				streamNames: source.streams.map((stream) => stream.name).sort(),
			})),
		}),
		grant_expiry: model.grantExpiry.defaultId,
		review_digest: model.reviewDigest,
		source_id: model.sources.map((source) => source.id),
		stream: model.sources.flatMap((source) =>
			source.streams.map((stream) => stream.id),
		),
		form: {
			selection: model.sources.map((source) => source.selectionValue),
			stream: model.sources.flatMap((source) =>
				source.streams.map((stream) => stream.selectionValue),
			),
		},
	};
}

test("consent-challenge accept returns a code redirect_url with iss equal to the metadata issuer", async () => {
	const server = await startTestServer();
	const asUrl = `http://localhost:${server.asPort}`;
	try {
		await registerSpotify(asUrl);
		const clientId = await registerClient(asUrl);
		const state = "accept-state";
		const challenge = await parkConsentChallenge(asUrl, clientId, state);
		const { form: _form, ...decision } = await fullDecision(
			asUrl,
			challenge,
			clientId,
		);
		const accepted = await fetchJson(
			`${asUrl}/oauth/authorize/consent-challenges/${challenge}/accept`,
			{
				body: JSON.stringify(decision),
				headers: {
					Accept: "application/json",
					"Content-Type": "application/json",
				},
				method: "POST",
			},
		);
		assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
		const location = new URL(str(accepted.body, "redirect_url"));
		assertAuthorizationResponse(location, await metadataIssuer(asUrl), state);
		assert.ok(
			location.searchParams.get("code"),
			"a success redirect carries the code",
		);
	} finally {
		await closeServer(server);
	}
});

// The form route re-enters the approval handler with a copy of the request.
// Run it with a derived and with a configured issuer: only the derived one
// reads the request, so only it shows a copy that lost the request's getters.
for (const [label, extra] of [
	["derived", {}],
	["configured", { asIssuer: "https://as.example.test" }],
] as const) {
	test(`POST /oauth/authorize/mcp-package with a consent challenge redirects with iss (${label} issuer)`, async () => {
		const server = await startTestServer(extra);
		const asUrl = `http://localhost:${server.asPort}`;
		try {
			await registerSpotify(asUrl);
			const clientId = await registerClient(asUrl);
			const state = `form-${label}-state`;
			const challenge = await parkConsentChallenge(asUrl, clientId, state);
			const decision = await fullDecision(asUrl, challenge, clientId);
			const form = new URLSearchParams({
				access_mode: decision.access_mode,
				consent_challenge: challenge,
				decision_digest: decision.decision_digest,
				grant_expiry: decision.grant_expiry,
				review_digest: decision.review_digest,
			});
			for (const value of decision.form.selection)
				form.append("selection", value);
			for (const value of decision.form.stream) form.append("stream", value);
			const resp = await fetch(`${asUrl}/oauth/authorize/mcp-package`, {
				body: form.toString(),
				headers: {
					Accept: "text/html",
					"Content-Type": "application/x-www-form-urlencoded",
				},
				method: "POST",
				redirect: "manual",
			});
			assert.equal(resp.status, 302, await resp.clone().text());
			const location = new URL(resp.headers.get("location") ?? "");
			assertAuthorizationResponse(location, await metadataIssuer(asUrl), state);
			assert.ok(
				location.searchParams.get("code"),
				"a success redirect carries the code",
			);
		} finally {
			await closeServer(server);
		}
	});
}

test("consent-challenge reject returns an access_denied redirect_url with iss", async () => {
	const server = await startTestServer();
	const asUrl = `http://localhost:${server.asPort}`;
	try {
		const clientId = await registerClient(asUrl);
		const state = "reject-state";
		const challenge = await parkConsentChallenge(asUrl, clientId, state);
		const rejected = await fetchJson(
			`${asUrl}/oauth/authorize/consent-challenges/${challenge}/reject`,
			{
				body: "{}",
				headers: {
					Accept: "application/json",
					"Content-Type": "application/json",
				},
				method: "POST",
			},
		);
		assert.equal(rejected.status, 200, JSON.stringify(rejected.body));
		const location = new URL(str(rejected.body, "redirect_url"));
		assertAuthorizationResponse(location, await metadataIssuer(asUrl), state);
		assert.equal(location.searchParams.get("error"), "access_denied");
		assert.equal(location.searchParams.get("code"), null);
	} finally {
		await closeServer(server);
	}
});

test("POST /oauth/authorize/mcp-package/cancel redirects with access_denied and iss", async () => {
	const server = await startTestServer();
	const asUrl = `http://localhost:${server.asPort}`;
	try {
		const clientId = await registerClient(asUrl);
		const resp = await fetch(`${asUrl}/oauth/authorize/mcp-package/cancel`, {
			body: new URLSearchParams({
				client_id: clientId,
				redirect_uri: REDIRECT_URI,
				state: "cancel-state",
			}).toString(),
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			method: "POST",
			redirect: "manual",
		});
		assert.equal(resp.status, 302);
		const location = new URL(resp.headers.get("location") ?? "");
		assertAuthorizationResponse(
			location,
			await metadataIssuer(asUrl),
			"cancel-state",
		);
		assert.equal(location.searchParams.get("error"), "access_denied");
		assert.equal(
			location.searchParams.get("error_description"),
			"The owner denied the request",
		);
	} finally {
		await closeServer(server);
	}
});

test("POST /consent/approve code redirect carries iss equal to the metadata issuer", async () => {
	const server = await startTestServer();
	const asUrl = `http://localhost:${server.asPort}`;
	try {
		const manifest = await registerSpotify(asUrl);
		const clientId = await registerClient(asUrl);
		const url = authorizeUrl(asUrl, clientId, "consent-state");
		url.searchParams.set(
			"authorization_details",
			JSON.stringify([
				{
					access_mode: "continuous",
					purpose_code: "https://pdpp.dev/purpose/personal_ai_assistant",
					purpose_description: "Use PDPP data through hosted MCP.",
					source: {
						id:
							manifest.source_declaration?.source?.id ??
							`https://registry.pdpp.dev/connectors/${encodeURIComponent(manifest.connector_id)}`,
						kind: "connector",
					},
					streams: [{ name: "*" }],
					type: "https://pdpp.dev/data-access",
				},
			]),
		);
		const authorize = await fetch(url, { redirect: "manual" });
		assert.equal(authorize.status, 302);
		const requestUri = new URL(
			authorize.headers.get("location") ?? "",
			asUrl,
		).searchParams.get("request_uri");
		assert.ok(
			requestUri,
			"authorize must hand off to /consent with a request_uri",
		);
		const review = await fetchJson(`${asUrl}/consent/review`, {
			body: JSON.stringify({
				request_uri: requestUri,
				subject_id: "owner_local",
			}),
			headers: {
				Accept: "application/json",
				"Content-Type": "application/json",
			},
			method: "POST",
		});
		assert.equal(review.status, 200, JSON.stringify(review.body));
		const approve = await fetch(`${asUrl}/consent/approve`, {
			body: new URLSearchParams({
				approval_review_revision: str(review.body, "approval_review_revision"),
				request_uri: requestUri,
			}).toString(),
			headers: {
				Accept: "text/html",
				"Content-Type": "application/x-www-form-urlencoded",
			},
			method: "POST",
			redirect: "manual",
		});
		assert.equal(approve.status, 302, await approve.clone().text());
		const location = new URL(approve.headers.get("location") ?? "");
		assertAuthorizationResponse(
			location,
			await metadataIssuer(asUrl),
			"consent-state",
		);
		assert.ok(
			location.searchParams.get("code"),
			"a success redirect carries the code",
		);
	} finally {
		await closeServer(server);
	}
});

test("iss matches the metadata issuer when the configured issuer has a trailing slash", async () => {
	// The metadata route normalizes the configured issuer; `iss` must take the
	// same path, or a client that compares the two byte for byte rejects sign-in.
	const server = await startTestServer({
		asIssuer: "https://as.example.test/",
	});
	const asUrl = `http://localhost:${server.asPort}`;
	try {
		const clientId = await registerClient(asUrl);
		const issuer = await metadataIssuer(asUrl);
		assert.equal(issuer, "https://as.example.test");
		const resp = await fetch(`${asUrl}/oauth/authorize/mcp-package/cancel`, {
			body: new URLSearchParams({
				client_id: clientId,
				redirect_uri: REDIRECT_URI,
				state: "slash-state",
			}).toString(),
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			method: "POST",
			redirect: "manual",
		});
		assert.equal(resp.status, 302);
		assertAuthorizationResponse(
			new URL(resp.headers.get("location") ?? ""),
			issuer,
			"slash-state",
		);
	} finally {
		await closeServer(server);
	}
});

test("buildAuthorizationResponseUrl keeps existing query params, omits absent state, and replaces a client-supplied iss", () => {
	const url = new URL(
		buildAuthorizationResponseUrl(
			"https://client.example/cb?keep=1&iss=forged",
			"https://as.example.test",
			{
				code: "abc",
				state: null,
			},
		),
	);
	assert.equal(url.searchParams.get("keep"), "1");
	assert.equal(url.searchParams.get("code"), "abc");
	assert.equal(url.searchParams.has("state"), false);
	assert.deepEqual(url.searchParams.getAll("iss"), ["https://as.example.test"]);
});
