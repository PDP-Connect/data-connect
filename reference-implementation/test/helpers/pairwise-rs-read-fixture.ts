// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import {
	TEST_INTROSPECTION_SERVER_OPTS,
	TEST_RS_INTROSPECTION_CREDENTIALS,
} from "./introspection-test-credentials.ts";

if (process.env.CORE1_DETAIL_PG === "1") {
	assert.ok(
		process.env.PDPP_TEST_POSTGRES_URL,
		"PostgreSQL mode needs the wrapper-provided owned database",
	);
	process.env.PDPP_DATABASE_URL = process.env.PDPP_TEST_POSTGRES_URL;
}
const { basicIntrospectionAuthorization } = await import(
	"../../server/introspection-http.ts"
);
const { startServer } = await import("../../server/index.ts");
const { ingestRecord } = await import("../../server/records.ts");
const { createRequestConnectorInstanceStore } = await import(
	"../../server/request-store-factories.ts"
);
const { closePostgresStorage } = await import("../../server/postgres-storage.ts");

export const INTERNAL_A = "cin_pairwise_detail_a";
export const INTERNAL_B = "cin_pairwise_detail_b";
export const INTERNAL_FOREIGN = "cin_pairwise_detail_foreign_owner";
export const INTERNAL_INACTIVE = "cin_pairwise_detail_inactive";
export const CLIENT_A = "inst_v1_pairwise_client_a";
export const CLIENT_B = "inst_v1_pairwise_client_b";
export const OWNER_A = "inst_v1_pairwise_owner_a";
export const OWNER_B = "inst_v1_pairwise_owner_b";
export const CONNECTOR_ID = "pairwise-detail-fixture";
export const SOURCE_ID = "https://sources.example/records/pairwise-detail-fixture";
export const ISSUER = "https://as.pairwise-detail.example";
export const CLIENT_ID = "pairwise_detail_client";
export const CLIENT_TOKEN = "pairwise-detail-client-token";
export const OWNER_TOKEN = "pairwise-detail-owner-token";
export const OWNER_SUBJECT = "pairwise_detail_owner_internal";
export const PUBLIC_SUBJECT = "pairwise_detail_subject_public";
export const GRANT_ID = "pairwise_detail_grant";

test.after(async () => {
	if (process.env.CORE1_DETAIL_PG === "1") await closePostgresStorage();
});

export type Reply = { status: number; text: string; body: Record<string, unknown> };
export type Fixture = {
	client: (path: string) => Promise<Reply>;
	owner: (path: string) => Promise<Reply>;
	introspection: Map<string, Record<string, unknown>>;
};

export async function makeFixture(t: TestContext): Promise<Fixture> {
	const declaration = JSON.parse(
		readFileSync(
			join(import.meta.dirname, "../seam-spike/fixtures/pr89/source.json"),
			"utf8",
		),
	) as Record<string, any>;
	declaration.source.id = SOURCE_ID;
	declaration.streams = [
		declaration.streams.find(
			(stream: { name: string }) => stream.name === "top_artists",
		),
	];
	declaration.streams[0].query = { aggregations: { count: true } };
	declaration.streams[0].schema.properties.rank = { type: "integer" };
	declaration.streams.push(
		{
			name: "parents",
			primary_key: ["id"],
			query: {
				expand: [{ default_limit: 5, max_limit: 10, name: "children" }],
			},
			relationships: [
				{
					cardinality: "has_many",
					foreign_key: "parent_id",
					name: "children",
					stream: "children",
				},
			],
			schema: {
				properties: { id: { type: "string" }, name: { type: "string" } },
				required: ["id"],
				type: "object",
			},
			selection: { fields: true, resources: true },
			semantics: "mutable_state",
		},
		{
			name: "children",
			primary_key: ["id"],
			schema: {
				properties: {
					id: { type: "string" },
					name: { type: "string" },
					parent_id: { type: "string" },
				},
				required: ["id", "parent_id"],
				type: "object",
			},
			selection: { fields: true, resources: true },
			semantics: "mutable_state",
		},
	);
	const manifest = {
		...declaration,
		connector_id: CONNECTOR_ID,
		connector_key: CONNECTOR_ID,
		display_name: "Pairwise detail fixture",
		manifest_uri: `https://implementations.example/connectors/${CONNECTOR_ID}`,
		source_declaration: declaration,
		version: "1.0.0",
	};

	let rsUrl = "";
	const introspection = new Map<string, Record<string, unknown>>();
	const introspectionServer = createServer(async (request, response) => {
		let encoded = "";
		for await (const chunk of request) encoded += chunk;
		const token = new URLSearchParams(encoded).get("token") ?? "";
		const info = introspection.get(token);
		if (
			request.headers.authorization !==
				basicIntrospectionAuthorization(TEST_RS_INTROSPECTION_CREDENTIALS) ||
			!info
		) {
			response
				.writeHead(401, { "Content-Type": "application/json" })
				.end(JSON.stringify({ active: false }));
			return;
		}
		const body = structuredClone(info);
		body.aud = rsUrl;
		response
			.writeHead(200, { "Content-Type": "application/json" })
			.end(JSON.stringify(body));
	});
	t.after(async () => {
		introspectionServer.closeAllConnections();
		if (introspectionServer.listening) {
			await new Promise<void>((resolve) =>
				introspectionServer.close(() => resolve()),
			);
		}
	});
	await new Promise<void>((resolve, reject) => {
		introspectionServer.once("error", reject);
		introspectionServer.listen(0, "127.0.0.1", resolve);
	});
	const introspectionPort = (introspectionServer.address() as { port: number })
		.port;
	let server:
		| (Awaited<ReturnType<typeof startServer>> & {
				asServer: {
					close: (cb: () => void) => void;
					closeAllConnections: () => void;
				};
				rsServer: {
					close: (cb: () => void) => void;
					closeAllConnections: () => void;
				};
		  })
		| undefined;
	t.after(async () => {
		if (!server) return;
		server.asServer.closeAllConnections();
		server.rsServer.closeAllConnections();
		await Promise.allSettled([
			new Promise<void>((resolve) => server!.asServer.close(() => resolve())),
			new Promise<void>((resolve) => server!.rsServer.close(() => resolve())),
		]);
	});
	const startedServer = (await startServer({
		asIssuer: ISSUER,
		asPort: 0,
		dbPath: ":memory:",
		preRegisteredPublicClients: [
			{
				client_id: CLIENT_ID,
				metadata: {
					client_name: "Pairwise detail",
					token_endpoint_auth_method: "none",
				},
			},
		],
		quiet: true,
		resolveIntrospectionAudience: () => rsUrl || null,
		resolveIntrospectionIssuer: () => ISSUER,
		rsIntrospectionEndpoint: `http://127.0.0.1:${introspectionPort}/introspect`,
		rsPort: 0,
		...TEST_INTROSPECTION_SERVER_OPTS,
	} as Parameters<typeof startServer>[0])) as NonNullable<typeof server>;
	server = startedServer;
	rsUrl = `http://localhost:${startedServer.rsPort}`;
	const registration = await fetch(
		`http://localhost:${startedServer.asPort}/connectors`,
		{
			body: JSON.stringify(manifest),
			headers: { "Content-Type": "application/json" },
			method: "POST",
		},
	);
	assert.equal(registration.status, 201, await registration.text());

	const store = createRequestConnectorInstanceStore();
	for (const id of [INTERNAL_A, INTERNAL_B]) {
		const now = new Date().toISOString();
		await store.upsert({
			connectorId: CONNECTOR_ID,
			connectorInstanceId: id,
			createdAt: now,
			displayName: id,
			ownerSubjectId: OWNER_SUBJECT,
			sourceBinding: { fixture: id },
			sourceBindingKey: id,
			sourceKind: "account",
			status: "active",
			updatedAt: now,
		});
	}
	for (const [id, ownerSubjectId, status] of [
		[INTERNAL_FOREIGN, "pairwise_detail_other_owner", "active"],
		[INTERNAL_INACTIVE, OWNER_SUBJECT, "revoked"],
	] as const) {
		const now = new Date().toISOString();
		await store.upsert({
			connectorId: CONNECTOR_ID,
			connectorInstanceId: id,
			createdAt: now,
			displayName: id,
			ownerSubjectId,
			sourceBinding: { fixture: id },
			sourceBindingKey: id,
			sourceKind: "account",
			status,
			updatedAt: now,
		});
	}
	for (const [instance, key, name] of [
		[INTERNAL_A, "shared", "application A"],
		[INTERNAL_B, "shared", "application B"],
		[INTERNAL_A, "unique-a", "unique application A"],
	] as const) {
		await ingestRecord(
			{ connector_id: CONNECTOR_ID, connector_instance_id: instance },
			{
			data: { id: key, name, observed_at: "2026-03-01T00:00:00Z", rank: 7 },
				emitted_at: "2026-03-01T00:00:00Z",
				key,
				stream: "top_artists",
			},
		);
	}
	await ingestRecord(
		{ connector_id: CONNECTOR_ID, connector_instance_id: INTERNAL_A },
		{
			data: { id: "parent-a", name: "parent application data" },
			emitted_at: "2026-03-02T00:00:00Z",
			key: "parent-a",
			stream: "parents",
		},
	);
	await ingestRecord(
		{ connector_id: CONNECTOR_ID, connector_instance_id: INTERNAL_A },
		{
			data: {
				id: "child-a",
				name: "child application data",
				parent_id: "parent-a",
			},
			emitted_at: "2026-03-02T00:00:00Z",
			key: "child-a",
			stream: "children",
		},
	);
	const issuedAt = new Date().toISOString();
	const grant = {
		access_mode: "continuous",
		client: { client_id: CLIENT_ID },
		grant_id: GRANT_ID,
		issued_at: issuedAt,
		purpose_code: "https://pdpp.dev/purpose/research",
		source: { id: SOURCE_ID, kind: "connector" },
		source_declaration: { version: "1.0.0" },
		streams: [
			{
				fields: ["id", "name", "rank"],
				instance_ids: [CLIENT_A, CLIENT_B],
				name: "top_artists",
			},
			{
				fields: ["id", "name"],
				instance_ids: [CLIENT_A, CLIENT_B],
				name: "parents",
			},
			{
				fields: ["id", "name", "parent_id"],
				instance_ids: [CLIENT_A, CLIENT_B],
				name: "children",
			},
		],
		subject: { id: PUBLIC_SUBJECT },
		version: "0.1.0",
	};
	introspection.set(CLIENT_TOKEN, {
		active: true,
		authorization_details: [
			{
				access_mode: grant.access_mode,
				purpose_code: grant.purpose_code,
				source: grant.source,
				streams: grant.streams,
				type: "https://pdpp.dev/data-access",
			},
		],
		client_id: CLIENT_ID,
		grant_id: GRANT_ID,
		grant_storage_binding: { connector_id: CONNECTOR_ID },
		iss: ISSUER,
		pdpp: {
			client_id: CLIENT_ID,
			context_kind: "oauth_rar_0_1",
			grant_id: GRANT_ID,
			issued_at: issuedAt,
			source: { id: SOURCE_ID, kind: "connector" },
			source_declaration: { version: "1.0.0" },
			subject_id: OWNER_SUBJECT,
		},
		pdpp_instance_bindings: grant.streams.flatMap((stream) =>
			[CLIENT_A, CLIENT_B].map((instance_id, index) => ({
				instance_id,
				rs_instance: index === 0 ? INTERNAL_A : INTERNAL_B,
				source_id: SOURCE_ID,
				stream: stream.name,
			})),
		),
		pdpp_token_kind: "client",
		subject_id: OWNER_SUBJECT,
	});
	introspection.set(OWNER_TOKEN, {
		active: true,
		client_id: "@owner",
		iss: ISSUER,
		pdpp_instance_bindings: [
			{ instance_id: OWNER_A, rs_instance: INTERNAL_A, source_id: SOURCE_ID },
			{ instance_id: OWNER_B, rs_instance: INTERNAL_B, source_id: SOURCE_ID },
		],
		pdpp_token_kind: "owner",
		subject_id: OWNER_SUBJECT,
	});
	const read =
		(token: string) =>
		async (path: string): Promise<Reply> => {
			const response = await fetch(`${rsUrl}${path}`, {
				headers: { Authorization: `Bearer ${token}` },
			});
			const text = await response.text();
			let body: Record<string, unknown> = {};
			try {
				body = JSON.parse(text) as Record<string, unknown>;
			} catch {
				/* preserve raw body */
			}
			return { body, status: response.status, text };
		};
	return {
		client: read(CLIENT_TOKEN),
		owner: read(OWNER_TOKEN),
		introspection,
	};
}

export function assertNoInternalIds(text: string): void {
	assert.ok(!text.includes(INTERNAL_A), "response exposed stored instance A");
	assert.ok(!text.includes(INTERNAL_B), "response exposed stored instance B");
}
