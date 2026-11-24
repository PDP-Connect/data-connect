// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { canonicalConnectorKeyFromManifest } from "../server/connector-key.ts";
import { startServer } from "../server/index.ts";
import { computeHostedMcpDecisionDigest } from "../server/routes/as-consent-ui-helpers.ts";
import { createSqliteConnectorInstanceStore } from "../server/stores/connector-instance-store.ts";
import { TEST_INTROSPECTION_SERVER_OPTS } from "./helpers/introspection-test-credentials.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

interface ResponseJson {
	body: Record<string, unknown>;
	status: number;
}

async function fetchJson(
	url: string,
	init: RequestInit = {},
): Promise<ResponseJson> {
	const response = await fetch(url, init);
	return {
		body: (await response.json()) as Record<string, unknown>,
		status: response.status,
	};
}

function field(body: Record<string, unknown>, name: string): string {
	const value = body[name];
	assert.equal(typeof value, "string", `${name} must be a string`);
	return value as string;
}

async function registerConnector(
	asUrl: string,
	fixture: string,
): Promise<string> {
	const raw = JSON.parse(
		readFileSync(join(ROOT, `fixtures/seed-manifests/${fixture}.json`), "utf8"),
	) as Record<string, unknown>;
	const connectorKey = canonicalConnectorKeyFromManifest(
		raw as { connector_id: string; [key: string]: unknown },
	);
	const manifest = connectorKey ? { ...raw, connector_id: connectorKey } : raw;
	const registered = await fetchJson(`${asUrl}/connectors`, {
		body: JSON.stringify(manifest),
		headers: { "Content-Type": "application/json" },
		method: "POST",
	});
	assert.equal(registered.status, 201);
	const canonicalId = String(manifest.connector_id);
	const instanceId = `cin_hosted_${canonicalId}`;
	const now = new Date().toISOString();
	await createSqliteConnectorInstanceStore().upsert({
		connectorId: canonicalId,
		connectorInstanceId: instanceId,
		createdAt: now,
		displayName: `${canonicalId} test account`,
		ownerSubjectId: "owner_local",
		sourceBinding: { fixture: instanceId },
		sourceBindingKey: instanceId,
		sourceKind: "account",
		status: "active",
		updatedAt: now,
	});
	return canonicalId;
}

async function createPackage(asUrl: string): Promise<string> {
	await registerConnector(asUrl, "spotify");
	await registerConnector(asUrl, "github");
	const clientResponse = await fetchJson(`${asUrl}/oauth/register`, {
		body: JSON.stringify({
			application_type: "web",
			client_name: "Package Core rejection test",
			grant_types: ["authorization_code", "refresh_token"],
			redirect_uris: ["https://client.example/callback"],
			response_types: ["code"],
			token_endpoint_auth_method: "none",
		}),
		headers: { "Content-Type": "application/json" },
		method: "POST",
	});
	assert.equal(clientResponse.status, 201);
	const clientId = field(clientResponse.body, "client_id");
	const verifier = randomBytes(32).toString("base64url");
	const state = "g5-package-state";
	const authorize = new URL(`${asUrl}/oauth/authorize`);
	authorize.searchParams.set("client_id", clientId);
	authorize.searchParams.set("redirect_uri", "https://client.example/callback");
	authorize.searchParams.set("response_type", "code");
	authorize.searchParams.set("state", state);
	authorize.searchParams.set(
		"code_challenge",
		createHash("sha256").update(verifier).digest("base64url"),
	);
	authorize.searchParams.set("code_challenge_method", "S256");
	const challengeResponse = await fetch(authorize, { redirect: "manual" });
	assert.equal(challengeResponse.status, 302);
	const challenge = new URL(
		challengeResponse.headers.get("location") || "",
	).searchParams.get("challenge");
	assert.ok(challenge);
	const modelResponse = await fetchJson(
		`${asUrl}/oauth/authorize/consent-challenges/${challenge}`,
	);
	assert.equal(modelResponse.status, 200);
	const model = modelResponse.body as unknown as {
		grantExpiry: { defaultId: string };
		reviewDigest: string;
		sources: Array<{
			id: string;
			streams: Array<{ id: string; name: string }>;
		}>;
	};
	const selected = model.sources.map((source) => ({
		source,
		streams: source.streams,
	}));
	assert.equal(selected.length, 2);
	const accessMode = "continuous";
	const decisionDigest = computeHostedMcpDecisionDigest({
		accessMode,
		clientId,
		grantExpiry: model.grantExpiry.defaultId,
		sources: selected.map(({ source, streams }) => ({
			sourceKey: source.id,
			streamNames: streams.map((stream) => stream.name).sort(),
		})),
	});
	const approval = await fetchJson(
		`${asUrl}/oauth/authorize/consent-challenges/${challenge}/accept`,
		{
			body: JSON.stringify({
				access_mode: accessMode,
				decision_digest: decisionDigest,
				grant_expiry: model.grantExpiry.defaultId,
				review_digest: model.reviewDigest,
				source_id: selected.map(({ source }) => source.id),
				stream: selected.flatMap(({ streams }) =>
					streams.map((stream) => stream.id),
				),
			}),
			headers: {
				Accept: "application/json",
				"Content-Type": "application/json",
			},
			method: "POST",
		},
	);
	assert.equal(approval.status, 200, JSON.stringify(approval.body));
	const code = new URL(field(approval.body, "redirect_url")).searchParams.get(
		"code",
	);
	assert.ok(code);
	const tokenResponse = await fetchJson(`${asUrl}/oauth/token`, {
		body: new URLSearchParams({
			client_id: clientId,
			code,
			code_verifier: verifier,
			grant_type: "authorization_code",
			redirect_uri: "https://client.example/callback",
		}).toString(),
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		method: "POST",
	});
	assert.equal(tokenResponse.status, 200, JSON.stringify(tokenResponse.body));
	assert.ok(tokenResponse.body.grant_package_id);
	return field(tokenResponse.body, "access_token");
}

async function packageToken(): Promise<{
	asUrl: string;
	rsUrl: string;
	token: string;
	close: () => Promise<void>;
}> {
	const server = await startServer({
		asPort: 0,
		dbPath: ":memory:",
		ownerAuthPassword: "",
		quiet: true,
		rsPort: 0,
		...TEST_INTROSPECTION_SERVER_OPTS,
	});
	return {
		asUrl: `http://localhost:${server.asPort}`,
		rsUrl: `http://localhost:${server.rsPort}`,
		token: await createPackage(`http://localhost:${server.asPort}`),
		close: async () => {
			server.schedulerManager?.stop?.();
			server.asServer.closeAllConnections?.();
			server.rsServer.closeAllConnections?.();
			await Promise.all([
				new Promise<void>((resolve) => server.asServer.close(() => resolve())),
				new Promise<void>((resolve) => server.rsServer.close(() => resolve())),
			]);
		},
	};
}

const coreProbes: Array<{
	name: string;
	method: "DELETE" | "GET" | "PATCH" | "POST";
	path: string;
	body?: unknown;
	ownerOnly?: boolean;
}> = [
	{ name: "schema", method: "GET", path: "/v1/schema" },
	{ name: "streams list", method: "GET", path: "/v1/streams" },
	{
		name: "stream metadata",
		method: "GET",
		path: "/v1/streams/spotify.playlists",
	},
	{
		name: "records list",
		method: "GET",
		path: "/v1/streams/spotify.playlists/records?changes_since=beginning",
	},
	{
		name: "record by id",
		method: "GET",
		path: "/v1/streams/spotify.playlists/records/record-1",
	},
	{ name: "search", method: "GET", path: "/v1/search?q=test" },
	{
		name: "semantic search",
		method: "GET",
		path: "/v1/search/semantic?q=test",
	},
	{ name: "hybrid search", method: "GET", path: "/v1/search/hybrid?q=test" },
	{
		name: "aggregate",
		method: "GET",
		path: "/v1/streams/spotify.playlists/aggregate",
	},
	{ name: "blob read", method: "GET", path: "/v1/blobs/blob-1" },
	{
		name: "blob upload",
		method: "POST",
		path: "/v1/blobs",
		body: {},
		ownerOnly: true,
	},
	{
		name: "event subscriptions list",
		method: "GET",
		path: "/v1/event-subscriptions",
	},
	{
		name: "event subscription create",
		method: "POST",
		path: "/v1/event-subscriptions",
		body: { callback_url: "https://client.example/events" },
	},
	{
		name: "event subscription by id",
		method: "GET",
		path: "/v1/event-subscriptions/sub-test",
	},
	{
		name: "event subscription update",
		method: "PATCH",
		path: "/v1/event-subscriptions/sub-test",
		body: { enabled: false },
	},
	{
		name: "event subscription delete",
		method: "DELETE",
		path: "/v1/event-subscriptions/sub-test",
	},
	{
		name: "event subscription test event",
		method: "POST",
		path: "/v1/event-subscriptions/sub-test/test-event",
		body: {},
	},
	{ name: "connectors", method: "GET", path: "/v1/connectors" },
	{
		name: "field window",
		method: "GET",
		path: "/v1/streams/spotify.playlists/records/record-1/field-window",
	},
	{
		name: "owner state read",
		method: "GET",
		path: "/v1/state/spotify",
		ownerOnly: true,
	},
	{
		name: "owner ingest",
		method: "POST",
		path: "/v1/ingest/spotify.playlists",
		body: {},
		ownerOnly: true,
	},
];

test("package tokens are refused across Core route families and remain accepted at /mcp", async () => {
	const fixture = await packageToken();
	try {
		const mcp = await fetch(`${fixture.rsUrl}/mcp`, {
			body: JSON.stringify({
				id: 1,
				jsonrpc: "2.0",
				method: "initialize",
				params: {
					capabilities: {},
					clientInfo: { name: "g5-test", version: "1" },
					protocolVersion: "2025-06-18",
				},
			}),
			headers: {
				Accept: "application/json, text/event-stream",
				Authorization: `Bearer ${fixture.token}`,
				"Content-Type": "application/json",
			},
			method: "POST",
		});
		assert.equal(mcp.status, 200, "a package token remains usable at /mcp");
		const outcomes = [];
		for (const probe of coreProbes) {
			const response = await fetch(`${fixture.rsUrl}${probe.path}`, {
				...(probe.body ? { body: JSON.stringify(probe.body) } : {}),
				headers: {
					Authorization: `Bearer ${fixture.token}`,
					...(probe.body ? { "Content-Type": "application/json" } : {}),
				},
				method: probe.method,
			});
			const text = await response.text();
			let body: unknown;
			try {
				body = JSON.parse(text);
			} catch {
				body = text;
			}
			const disclosedData = response.ok && JSON.stringify(body).length > 0;
			outcomes.push({
				name: probe.name,
				status: response.status,
				disclosedData,
				body,
			});
		}
		console.log(`G5 PACKAGE PROBE ${JSON.stringify(outcomes)}`);
		for (const [index, outcome] of outcomes.entries()) {
			assert.equal(
				outcome.status,
				403,
				`${outcome.name} should reject with 403`,
			);
			assert.equal(
				(outcome.body as { error?: { code?: string } }).error?.code,
				"permission_error",
			);
			if (!coreProbes[index]?.ownerOnly) {
				assert.equal(
					(outcome.body as { error?: { message?: string } }).error?.message,
					"Grant package token cannot access a Core endpoint",
				);
			}
		}
	} finally {
		await fixture.close();
	}
});
