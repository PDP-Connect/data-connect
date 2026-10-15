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
const CLIENT_A = "inst_v1_pairwise_client_a";
const CLIENT_B = "inst_v1_pairwise_client_b";
const OWNER_A = "inst_v1_pairwise_owner_a";
const OWNER_B = "inst_v1_pairwise_owner_b";
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
type Fixture = {
	client: (path: string) => Promise<Reply>;
	owner: (path: string) => Promise<Reply>;
	introspection: Map<string, Record<string, unknown>>;
};

async function makeFixture(t: TestContext): Promise<Fixture> {
	const declaration = JSON.parse(
		readFileSync(
			join(import.meta.dirname, "seam-spike/fixtures/pr89/source.json"),
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
				fields: ["id", "name"],
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

function assertNoInternalIds(text: string): void {
	assert.ok(!text.includes(INTERNAL_A), "response exposed stored instance A");
	assert.ok(!text.includes(INTERNAL_B), "response exposed stored instance B");
}

test("authenticated client and owner record detail use pairwise instance handles", async (t) => {
	const fx = await makeFixture(t);
	const requests = [
		[
			"client canonical handle",
			() =>
				fx.client(
					`/v1/streams/top_artists/records/shared?instance_id=${CLIENT_A}`,
				),
			CLIENT_A,
			"application A",
		],
		[
			"client deprecated alias",
			() =>
				fx.client(
					`/v1/streams/top_artists/records/shared?connection_id=${CLIENT_A}`,
				),
			CLIENT_A,
			"application A",
		],
		[
			"owner canonical handle",
			() =>
				fx.owner(
					`/v1/streams/top_artists/records/shared?connector_id=${CONNECTOR_ID}&instance_id=${OWNER_A}`,
				),
			OWNER_A,
			"application A",
		],
		[
			"owner deprecated alias",
			() =>
				fx.owner(
					`/v1/streams/top_artists/records/shared?connector_id=${CONNECTOR_ID}&connection_id=${OWNER_A}`,
				),
			OWNER_A,
			"application A",
		],
	] as const;
	const replies = await Promise.all(
		requests.map(async ([label, request]) => [label, await request()] as const),
	);
	for (const [label, reply] of replies)
		console.log(`PAIRWISE_DETAIL_RED ${label} ${JSON.stringify(reply)}`);
	for (let i = 0; i < replies.length; i++) {
		const [label, reply] = replies[i]!;
		const [, , expectedHandle, expectedName] = requests[i]!;
		assert.equal(reply.status, 200, `${label}: ${reply.text}`);
		assert.equal(
			reply.body.instance_id,
			expectedHandle,
			`${label} must emit a public handle`,
		);
		assert.equal(
			(reply.body.data as Record<string, unknown>)?.name,
			expectedName,
			`${label} selected wrong application data`,
		);
		assertNoInternalIds(reply.text);
		assert.equal(
			Object.hasOwn(reply.body, "connection_id"),
			false,
			`${label} must not emit an internal selector`,
		);
	}
});

test("detail selectors reject conflicting, malformed, raw, or missing selection before lookup", async (t) => {
	const fx = await makeFixture(t);
	const cases = [
		[
			"same aliases",
			`/v1/streams/top_artists/records/shared?instance_id=${CLIENT_A}&connection_id=${CLIENT_A}`,
			200,
			CLIENT_A,
		],
		[
			"different aliases",
			`/v1/streams/top_artists/records/shared?instance_id=${CLIENT_A}&connection_id=${CLIENT_B}`,
			400,
			null,
		],
		[
			"duplicate selector",
			`/v1/streams/top_artists/records/shared?instance_id=${CLIENT_A}&instance_id=${CLIENT_A}`,
			400,
			null,
		],
		[
			"empty selector",
			"/v1/streams/top_artists/records/shared?instance_id=",
			400,
			null,
		],
		[
			"raw stored selector",
			`/v1/streams/top_artists/records/shared?instance_id=${INTERNAL_A}`,
			400,
			null,
		],
		[
			"missing selector before unique lookup",
			"/v1/streams/top_artists/records/unique-a",
			400,
			null,
		],
	] as const;
	const replies = await Promise.all(
		cases.map(async ([label, path, status, handle]) => ({
			label,
			path,
			status,
			handle,
			reply: await fx.client(path),
		})),
	);
	const failures: string[] = [];
	for (const { label, status, handle, reply } of replies) {
		console.log(`PAIRWISE_DETAIL_RED ${label} ${JSON.stringify(reply)}`);
		if (reply.status !== status)
			failures.push(`${label}: expected ${status}, got ${reply.status}`);
		if (handle && reply.body.instance_id !== handle)
			failures.push(`${label}: wrong public instance_id`);
		try {
			assertNoInternalIds(reply.text);
		} catch {
			failures.push(`${label}: response disclosed an internal selector`);
		}
	}
	assert.deepEqual(failures, []);
});

test("record detail projects the pairwise handle to expanded child envelopes", async (t) => {
	const fx = await makeFixture(t);
	const reply = await fx.owner(
		`/v1/streams/parents/records/parent-a?connector_id=${CONNECTOR_ID}&instance_id=${OWNER_A}&expand=children`,
	);
	console.log(
		`PAIRWISE_DETAIL_RED owner expanded child ${JSON.stringify(reply)}`,
	);
	assert.equal(reply.status, 200, reply.text);
	assert.equal(reply.body.instance_id, OWNER_A);
	assert.equal(
		(reply.body.data as Record<string, unknown>)?.name,
		"parent application data",
	);
	const expanded = reply.body.expanded as Record<
		string,
		Record<string, unknown>
	>;
	const children = expanded.children!.data as Array<Record<string, unknown>>;
	assert.equal(children[0]?.instance_id, OWNER_A);
	assert.equal(
		(children[0]?.data as Record<string, unknown>)?.name,
		"child application data",
	);
	assertNoInternalIds(reply.text);
});

test("owner detail requires a selector before looking up a uniquely present record", async (t) => {
	const fx = await makeFixture(t);
	const reply = await fx.owner(
		`/v1/streams/top_artists/records/unique-a?connector_id=${CONNECTOR_ID}`,
	);
	console.log(
		`PAIRWISE_DETAIL_RED owner missing selector before unique lookup ${JSON.stringify(reply)}`,
	);
	assert.equal(reply.status, 400, reply.text);
	assert.equal(
		(reply.body.error as Record<string, unknown>)?.code,
		"invalid_request",
	);
	assertNoInternalIds(reply.text);
});

test("detail validates every authenticated client binding before selector narrowing", async (t) => {
	const fx = await makeFixture(t);
	const bindings = fx.introspection.get(CLIENT_TOKEN)!
		.pdpp_instance_bindings as Array<Record<string, unknown>>;
	bindings[1]!.rs_instance = "cin_unowned_unselected";
	const reply = await fx.client(
		`/v1/streams/top_artists/records/shared?instance_id=${CLIENT_A}`,
	);
	console.log(
		`PAIRWISE_DETAIL_RED invalid unselected binding ${JSON.stringify(reply)}`,
	);
	assert.equal(reply.status, 403, reply.text);
	assertNoInternalIds(reply.text);
});

test("detail validates every authenticated owner binding before selector narrowing", async (t) => {
	const fx = await makeFixture(t);
	const bindings = fx.introspection.get(OWNER_TOKEN)!
		.pdpp_instance_bindings as Array<Record<string, unknown>>;
	bindings[1]!.rs_instance = "cin_unowned_unselected";
	const reply = await fx.owner(
		`/v1/streams/top_artists/records/unique-a?connector_id=${CONNECTOR_ID}&instance_id=${OWNER_A}`,
	);
	console.log(
		`PAIRWISE_DETAIL_RED invalid unselected owner binding ${JSON.stringify(reply)}`,
	);
	assert.equal(reply.status, 403, reply.text);
	assertNoInternalIds(reply.text);
});
