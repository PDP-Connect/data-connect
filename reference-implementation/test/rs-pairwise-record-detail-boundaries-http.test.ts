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
} from "./helpers/introspection-test-credentials.ts";

if (process.env.CORE1_DETAIL_PG === "1") {
	assert.ok(
		process.env.PDPP_TEST_POSTGRES_URL,
		"PostgreSQL mode needs the wrapper-provided owned database",
	);
	process.env.PDPP_DATABASE_URL = process.env.PDPP_TEST_POSTGRES_URL;
}
const { basicIntrospectionAuthorization } = await import(
	"../server/introspection-http.ts"
);
const { startServer } = await import("../server/index.ts");
const { ingestRecord } = await import("../server/records.ts");
const { createRequestConnectorInstanceStore } = await import(
	"../server/request-store-factories.ts"
);
const { closePostgresStorage } = await import("../server/postgres-storage.ts");

const INTERNAL_A = "cin_pairwise_detail_a";
const INTERNAL_B = "cin_pairwise_detail_b";
const INTERNAL_C = "cin_pairwise_detail_c";
const CLIENT_A = "inst_v1_pairwise_client_a";
const CLIENT_B = "inst_v1_pairwise_client_b";
const OWNER_A = "inst_v1_pairwise_owner_a";
const OWNER_B = "inst_v1_pairwise_owner_b";
const OWNER_C = "owner-instance-c";
const CONNECTOR_ID = "pairwise-detail-fixture";
const SOURCE_ID = "https://sources.example/records/pairwise-detail-fixture";
const ISSUER = "https://as.pairwise-detail.example";
const CLIENT_ID = "pairwise_detail_client";
const CLIENT_TOKEN = "pairwise-detail-client-token";
const OWNER_TOKEN = "pairwise-detail-owner-token";
const OWNER_SUBJECT = "pairwise_detail_owner_internal";
const PUBLIC_SUBJECT = "pairwise_detail_subject_public";
const GRANT_ID = "pairwise_detail_grant";

test.after(async () => {
	if (process.env.CORE1_DETAIL_PG === "1") await closePostgresStorage();
});

type Reply = { status: number; text: string; body: Record<string, unknown> };
type FixtureStreamDeclaration = Record<string, unknown> & {
	name: string;
	schema: Record<string, unknown> & { properties: Record<string, unknown> };
};
type FixtureSourceDeclaration = Record<string, unknown> & {
	source: { id: string };
	streams: FixtureStreamDeclaration[];
};
type Fixture = {
	client: (path: string) => Promise<Reply>;
	owner: (path: string) => Promise<Reply>;
	registerSource: (connectorId: string, sourceId: string) => Promise<void>;
	introspection: Map<string, Record<string, unknown>>;
	store: Awaited<ReturnType<typeof createRequestConnectorInstanceStore>>;
};

function tokenBindings(
	fx: Fixture,
	token: string,
): Array<Record<string, unknown>> {
	const info = fx.introspection.get(token);
	assert.ok(info);
	assert.ok(Array.isArray(info.pdpp_instance_bindings));
	return info.pdpp_instance_bindings as Array<Record<string, unknown>>;
}

async function makeFixture(t: TestContext): Promise<Fixture> {
	const declaration = JSON.parse(
		readFileSync(
			join(import.meta.dirname, "seam-spike/fixtures/pr89/source.json"),
			"utf8",
		),
	) as FixtureSourceDeclaration;
	declaration.source.id = SOURCE_ID;
	const topArtists = declaration.streams.find(
		(stream) => stream.name === "top_artists",
	);
	assert.ok(topArtists);
	declaration.streams = [topArtists];
	topArtists.query = { aggregations: { count: true } };
	topArtists.schema.properties.connection_id = { type: "string" };
	topArtists.schema.properties.connector_instance_id = {
		type: "string",
	};
	topArtists.schema.properties.object = {
		type: "object",
		properties: { connection_id: { type: "string" } },
	};
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
	await new Promise<void>((resolve) =>
		introspectionServer.listen(0, "127.0.0.1", resolve),
	);
	t.after(async () => {
		introspectionServer.closeAllConnections();
		await new Promise<void>((resolve) =>
			introspectionServer.close(() => resolve()),
		);
	});
	const introspectionPort = (introspectionServer.address() as { port: number })
		.port;
	const server = (await startServer({
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
	} as Parameters<typeof startServer>[0])) as Awaited<
		ReturnType<typeof startServer>
	> & {
		asServer: {
			close: (cb: () => void) => void;
			closeAllConnections: () => void;
		};
		rsServer: {
			close: (cb: () => void) => void;
			closeAllConnections: () => void;
		};
	};
	t.after(async () => {
		server.asServer.closeAllConnections();
		server.rsServer.closeAllConnections();
		await Promise.allSettled([
			new Promise<void>((resolve) => server.asServer.close(() => resolve())),
			new Promise<void>((resolve) => server.rsServer.close(() => resolve())),
		]);
	});
	rsUrl = `http://localhost:${server.rsPort}`;
	const registration = await fetch(
		`http://localhost:${server.asPort}/connectors`,
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
	for (const [instance, key, name] of [
		[INTERNAL_A, "shared", "application A"],
		[INTERNAL_B, "shared", "application B"],
		[INTERNAL_A, "unique-a", "unique application A"],
	] as const) {
		await ingestRecord(
			{ connector_id: CONNECTOR_ID, connector_instance_id: instance },
			{
				data: { id: key, name },
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
				fields: [
					"id",
					"name",
					"connection_id",
					"connector_instance_id",
					"object",
				],
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
		registerSource: async (connectorId, sourceId) => {
			const secondManifest = structuredClone(manifest) as Record<
				string,
				unknown
			>;
			secondManifest.connector_id = connectorId;
			secondManifest.connector_key = connectorId;
			secondManifest.manifest_uri = `https://implementations.example/connectors/${connectorId}`;
			(secondManifest.source as Record<string, unknown>).id = sourceId;
			(
				(secondManifest.source_declaration as Record<string, unknown>)
					.source as Record<string, unknown>
			).id = sourceId;
			const reply = await fetch(
				`http://localhost:${server.asPort}/connectors`,
				{
					body: JSON.stringify(secondManifest),
					headers: { "Content-Type": "application/json" },
					method: "POST",
				},
			);
			assert.equal(reply.status, 201, await reply.text());
		},
		introspection,
		store,
	};
}

function assertNoInternalIds(text: string): void {
	assert.ok(!text.includes(INTERNAL_A), "response exposed stored instance A");
	assert.ok(!text.includes(INTERNAL_B), "response exposed stored instance B");
}

test("foreign and raw internal handles never resolve for client or owner detail", async (t) => {
	const fx = await makeFixture(t);
	const replies = await Promise.all([
		fx.client(
			"/v1/streams/top_artists/records/shared?instance_id=inst_foreign_handle",
		),
		fx.owner(
			`/v1/streams/top_artists/records/shared?connector_id=${CONNECTOR_ID}&instance_id=inst_foreign_handle`,
		),
		fx.client(
			`/v1/streams/top_artists/records/shared?instance_id=${INTERNAL_A}`,
		),
		fx.owner(
			`/v1/streams/top_artists/records/shared?connector_id=${CONNECTOR_ID}&instance_id=${INTERNAL_A}`,
		),
	]);
	const failures = replies.flatMap((reply, index) => {
		const expected = index < 2 ? 404 : 400;
		return [
			...(reply.status === expected
				? []
				: [`case ${index}: expected ${expected}, got ${reply.status}`]),
			...(reply.text.includes(INTERNAL_A) || reply.text.includes(INTERNAL_B)
				? [`case ${index}: leaked stored ID`]
				: []),
		];
	});
	assert.deepEqual(failures, []);
});

test("owner detail accepts equal canonical and deprecated public selectors", async (t) => {
	const fx = await makeFixture(t);
	const reply = await fx.owner(
		`/v1/streams/top_artists/records/shared?connector_id=${CONNECTOR_ID}&instance_id=${OWNER_A}&connection_id=${OWNER_A}`,
	);
	assert.equal(reply.status, 200, reply.text);
	assert.equal(reply.body.instance_id, OWNER_A);
	assert.equal(
		(reply.body.data as Record<string, unknown>)?.name,
		"application A",
	);
	assertNoInternalIds(reply.text);
});

test("an invalid unselected owner source binding fails the whole detail request", async (t) => {
	const fx = await makeFixture(t);
	const bindings = tokenBindings(fx, OWNER_TOKEN);
	assert.ok(bindings[1]);
	bindings[1].source_id = "https://sources.example/records/foreign-source";
	const reply = await fx.owner(
		`/v1/streams/top_artists/records/shared?connector_id=${CONNECTOR_ID}&instance_id=${OWNER_A}`,
	);
	assert.equal(reply.status, 403, reply.text);
	assert.equal(
		(reply.body.error as Record<string, unknown>)?.code,
		"grant_invalid",
	);
	assertNoInternalIds(reply.text);
});

test("an unselected owner binding owned by another subject fails before selection", async (t) => {
	const fx = await makeFixture(t);
	const foreignInstance = "cin_pairwise_detail_other_subject";
	const now = new Date().toISOString();
	await fx.store.upsert({
		connectorId: CONNECTOR_ID,
		connectorInstanceId: foreignInstance,
		createdAt: now,
		displayName: "foreign owner instance",
		ownerSubjectId: "different_owner_subject",
		sourceBinding: { fixture: foreignInstance },
		sourceBindingKey: foreignInstance,
		sourceKind: "account",
		status: "active",
		updatedAt: now,
	});
	const bindings = tokenBindings(fx, OWNER_TOKEN);
	assert.ok(bindings[1]);
	bindings[1].rs_instance = foreignInstance;
	const reply = await fx.owner(
		`/v1/streams/top_artists/records/shared?connector_id=${CONNECTOR_ID}&instance_id=${OWNER_A}`,
	);
	assert.equal(reply.status, 403, reply.text);
	assert.equal(
		(reply.body.error as Record<string, unknown>)?.code,
		"grant_invalid",
	);
	assert.ok(!reply.text.includes(foreignInstance));
	assertNoInternalIds(reply.text);
});

test("an unselected client binding owned by another subject fails before selection", async (t) => {
	const fx = await makeFixture(t);
	const foreignInstance = "cin_pairwise_detail_other_client_subject";
	const now = new Date().toISOString();
	await fx.store.upsert({
		connectorId: CONNECTOR_ID,
		connectorInstanceId: foreignInstance,
		createdAt: now,
		displayName: "foreign client binding",
		ownerSubjectId: "different_owner_subject",
		sourceBinding: { fixture: foreignInstance },
		sourceBindingKey: foreignInstance,
		sourceKind: "account",
		status: "active",
		updatedAt: now,
	});
	for (const binding of tokenBindings(fx, CLIENT_TOKEN)) {
		if (binding.instance_id === CLIENT_B) binding.rs_instance = foreignInstance;
	}
	const reply = await fx.client(
		`/v1/streams/top_artists/records/shared?instance_id=${CLIENT_A}`,
	);
	assert.equal(reply.status, 403, reply.text);
	assert.equal(
		(reply.body.error as Record<string, unknown>)?.code,
		"grant_invalid",
	);
	assert.ok(!reply.text.includes(foreignInstance));
	assertNoInternalIds(reply.text);
});

test("a stored owner instance without an authenticated binding remains outside the owner scope", async (t) => {
	const fx = await makeFixture(t);
	const unbound = "cin_pairwise_detail_unbound";
	const now = new Date().toISOString();
	await fx.store.upsert({
		connectorId: CONNECTOR_ID,
		connectorInstanceId: unbound,
		createdAt: now,
		displayName: "unbound owner instance",
		ownerSubjectId: OWNER_SUBJECT,
		sourceBinding: { fixture: unbound },
		sourceBindingKey: unbound,
		sourceKind: "account",
		status: "active",
		updatedAt: now,
	});
	await ingestRecord(
		{ connector_id: CONNECTOR_ID, connector_instance_id: unbound },
		{
			data: { id: "unbound-only", name: "outside binding scope" },
			emitted_at: now,
			key: "unbound-only",
			stream: "top_artists",
		},
	);
	const reply = await fx.owner(
		`/v1/streams/top_artists/records/unbound-only?connector_id=${CONNECTOR_ID}&instance_id=${OWNER_A}`,
	);
	assert.equal(reply.status, 404, reply.text);
	assert.equal(
		(reply.body.error as Record<string, unknown>)?.code,
		"not_found",
	);
	assert.ok(!reply.text.includes(unbound));
});

test("record detail preserves application fields named like identity selectors", async (t) => {
	const fx = await makeFixture(t);
	const data = {
		connection_id: "application connection field",
		connector_instance_id: "application connector field",
		id: "identity-shaped-data",
		object: { connection_id: "nested application object" },
	};
	await ingestRecord(
		{ connector_id: CONNECTOR_ID, connector_instance_id: INTERNAL_A },
		{
			data,
			emitted_at: new Date().toISOString(),
			key: data.id,
			stream: "top_artists",
		},
	);
	const reply = await fx.client(
		`/v1/streams/top_artists/records/${data.id}?instance_id=${CLIENT_A}`,
	);
	assert.equal(reply.status, 200, reply.text);
	assert.deepEqual(reply.body.data, data);
	assert.equal(reply.body.instance_id, CLIENT_A);
	assertNoInternalIds(reply.text);
});

test("single-instance client detail allows an omitted instance selector", async (t) => {
	const fx = await makeFixture(t);
	const info = fx.introspection.get(CLIENT_TOKEN)!;
	const detail = (
		info.authorization_details as Array<Record<string, unknown>>
	)[0]!;
	for (const stream of detail.streams as Array<Record<string, unknown>>)
		stream.instance_ids = [CLIENT_A];
	info.pdpp_instance_bindings = tokenBindings(fx, CLIENT_TOKEN).filter(
		(binding) => binding.instance_id === CLIENT_A,
	);
	const reply = await fx.client("/v1/streams/top_artists/records/shared");
	assert.equal(reply.status, 200, reply.text);
	assert.equal(reply.body.instance_id, CLIENT_A);
	assertNoInternalIds(reply.text);
});

test("single-instance owner scope allows an omitted instance selector", async (t) => {
	const fx = await makeFixture(t);
	fx.introspection.get(OWNER_TOKEN)!.pdpp_instance_bindings = tokenBindings(
		fx,
		OWNER_TOKEN,
	).filter((binding) => binding.instance_id === OWNER_A);
	const reply = await fx.owner(
		`/v1/streams/top_artists/records/shared?connector_id=${CONNECTOR_ID}`,
	);
	assert.equal(reply.status, 200, reply.text);
	assert.equal(reply.body.instance_id, OWNER_A);
	assertNoInternalIds(reply.text);
});

test("owner connector mismatch errors never disclose the resolved stored instance", async (t) => {
	const fx = await makeFixture(t);
	const reply = await fx.owner(
		`/v1/streams/top_artists/records/shared?connector_id=wrong-connector&instance_id=${OWNER_A}`,
	);
	assert.notEqual(reply.status, 200);
	assertNoInternalIds(reply.text);
});

test("owner connector scope narrows omission to one source while unscoped multi-source omission fails", async (t) => {
	const fx = await makeFixture(t);
	const secondConnectorId = `${CONNECTOR_ID}-second`;
	const secondSourceId = `${SOURCE_ID}-second`;
	await fx.registerSource(secondConnectorId, secondSourceId);
	const now = new Date().toISOString();
	await fx.store.upsert({
		connectorId: secondConnectorId,
		connectorInstanceId: INTERNAL_C,
		createdAt: now,
		displayName: INTERNAL_C,
		ownerSubjectId: OWNER_SUBJECT,
		sourceBinding: { fixture: INTERNAL_C },
		sourceBindingKey: INTERNAL_C,
		sourceKind: "account",
		status: "active",
		updatedAt: now,
	});
	fx.introspection.get(OWNER_TOKEN)!.pdpp_instance_bindings = [
		{ instance_id: OWNER_A, rs_instance: INTERNAL_A, source_id: SOURCE_ID },
		{
			instance_id: OWNER_C,
			rs_instance: INTERNAL_C,
			source_id: secondSourceId,
		},
	];

	const scoped = await fx.owner(
		`/v1/streams/top_artists/records/shared?connector_id=${CONNECTOR_ID}`,
	);
	assert.equal(scoped.status, 200, scoped.text);
	assert.equal(scoped.body.instance_id, OWNER_A);
	assertNoInternalIds(scoped.text);

	const unscoped = await fx.owner("/v1/streams/top_artists/records/shared");
	assert.equal(unscoped.status, 400, unscoped.text);
	assert.equal(
		(unscoped.body.error as Record<string, unknown>).code,
		"invalid_request",
	);
	assertNoInternalIds(unscoped.text);
});
