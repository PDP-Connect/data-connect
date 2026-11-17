// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Test adapter for the client range filters conformance vectors
// (spec-client-range-filters.md Section 11.4). The vectors name abstract
// fixtures and requests; this file turns them into a running reference
// server, a real authorization (or a seeded grant), and HTTP calls.
//
// Stored numbers are loaded from JSON lexemes and written to the store
// verbatim, so a value such as 9007199254740993 is never rounded on the way in.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CLIENT_RANGE_FILTERS_PROFILE_URI } from "../../server/client-range-filters.ts";
import { canonicalConnectorKey } from "../../server/connector-key.ts";
import { getDb } from "../../server/db.ts";
import { startServer } from "../../server/index.ts";
import { parseJsonWithNumbers } from "../../server/lossless-json.ts";
import { OWNER_AUTH_DEFAULT_SUBJECT_ID } from "../../server/owner-auth.ts";
import { ingestRecord } from "../../server/records.ts";
import { createSqliteConnectorInstanceStore } from "../../server/stores/connector-instance-store.ts";
import { TEST_PRE_REGISTERED_PUBLIC_CLIENTS } from "../fixtures/demo-clients.ts";
import { TEST_INTROSPECTION_SERVER_OPTS } from "./introspection-test-credentials.ts";

// Vector content is data of unknown shape; the adapter narrows it where it reads.
export type Json = any;
export type JsonObject = Record<string, any>;

const here = dirname(fileURLToPath(import.meta.url));
export const VECTOR_FILE = join(
	here,
	"..",
	"fixtures",
	"client-range-filters",
	"client-range-filters-0.1-experimental.json",
);

// The reference server resolves a connector type through its key registry, so
// the fixture borrows a registered first-party identity and replaces its streams.
// The vectors call their source https://example.test/source; the adapter maps it.
export const SOURCE_ID = "https://registry.pdpp.dev/connectors/spotify";
const CONNECTOR_KEY = canonicalConnectorKey(SOURCE_ID) as string;
const CLIENT_ID = "longview";
const DCR_TOKEN = "pdpp-reference-test-initial-access-token";

// A number lexeme kept exactly as written in the vector file.
export class Lexeme {
	readonly raw: string;
	constructor(raw: string) {
		this.raw = raw;
	}
}

function toPlain(value: unknown): Json {
	if (value instanceof Lexeme) {
		return Number(value.raw);
	}
	if (Array.isArray(value)) {
		return value.map(toPlain);
	}
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [key, toPlain(item)]),
		);
	}
	return value as Json;
}

function toExactText(value: unknown): string {
	if (value instanceof Lexeme) {
		return value.raw;
	}
	if (Array.isArray(value)) {
		return `[${value.map(toExactText).join(",")}]`;
	}
	if (value && typeof value === "object") {
		return `{${Object.entries(value)
			.map(([key, item]) => `${JSON.stringify(key)}:${toExactText(item)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

export interface VectorFile {
	fixtures: Record<string, Fixture>;
	vectors: Vector[];
}

export interface FixtureRecord {
	data: Record<string, unknown>;
	instance_id: string;
	key: string;
}

export interface Fixture {
	blobs?: Array<{
		blob_id: string;
		content_base64: string;
		instance_id: string;
		mime_type: string;
	}>;
	children?: Record<
		string,
		{ grant: JsonObject; retained_declaration: JsonObject }
	>;
	current_declaration?: JsonObject;
	grant: JsonObject;
	horizons?: Record<string, { records: FixtureRecord[] }>;
	records: FixtureRecord[];
	retained_declaration: JsonObject;
	serving?: { unevaluable_filters?: Array<{ field: string; stream: string }> };
}

export interface VectorRequest {
	body?: JsonObject;
	method?: string;
	metadata?: JsonObject;
	operation?: string;
	path?: string;
	query?: Array<[string, string]>;
	token?: { kind: string; selected_child?: string };
}

export interface Expected {
	body_contains?: JsonObject;
	error?: string;
	grant_member?: { absent?: boolean; path: string[]; value?: Json };
	has_more?: boolean;
	next_cursor_present?: boolean;
	page_length?: number;
	profile_supported?: boolean;
	query_exact?: JsonObject;
	record_keys?: string[];
	status?: number;
	tombstone_forbidden_members?: string[];
	tombstone_keys?: string[];
}

export interface Step {
	capture?: Record<string, string>;
	expected?: Expected;
	fixture?: string;
	horizon?: string;
	operation?: string;
	request?: VectorRequest;
	value?: string;
}

export interface Vector extends Step {
	follow_up?: Step[];
	id: string;
	requirements: string[];
	setup?: Step[];
}

interface RawFixtureRecord {
	data: unknown;
	instance_id: string;
	key: string;
}

export interface LoadedVectors {
	// Exact JSON text of each fixture record's data, keyed by fixture and horizon.
	exactRecords: Map<string, Map<string, string>>;
	file: VectorFile;
}

function exactKey(fixture: string, horizon: string | undefined): string {
	return `${fixture}#${horizon ?? ""}`;
}

export function loadVectors(): LoadedVectors {
	const text = readFileSync(VECTOR_FILE, "utf8");
	const lossless = parseJsonWithNumbers(
		text,
		(lexeme) => new Lexeme(lexeme),
	) as {
		fixtures: Record<
			string,
			{
				horizons?: Record<string, { records: RawFixtureRecord[] }>;
				records: RawFixtureRecord[];
			}
		>;
	};
	const exactRecords = new Map<string, Map<string, string>>();
	for (const [name, fixture] of Object.entries(lossless.fixtures)) {
		const own = new Map<string, string>();
		for (const record of fixture.records) {
			own.set(record.key, toExactText(record.data));
		}
		exactRecords.set(exactKey(name, undefined), own);
		for (const [horizon, value] of Object.entries(fixture.horizons ?? {})) {
			const forHorizon = new Map<string, string>();
			for (const record of value.records) {
				forHorizon.set(record.key, toExactText(record.data));
			}
			exactRecords.set(exactKey(name, horizon), forHorizon);
		}
	}
	return { exactRecords, file: JSON.parse(text) as VectorFile };
}

function extensionsOf(grant: JsonObject): JsonObject | undefined {
	return grant.extensions as JsonObject | undefined;
}

const ORDERED_OPERATORS = ["gte", "gt", "lte", "lt"];

function orderedType(schema: JsonObject | undefined): boolean {
	const types = ([] as string[])
		.concat(schema?.type ?? [])
		.filter((type) => type !== "null");
	const [type] = types;
	return (
		types.length === 1 &&
		(type === "integer" ||
			type === "number" ||
			(type === "string" && ["date", "date-time"].includes(schema?.format)))
	);
}

// The reference server validates a declaration before it accepts it: no
// operator outside gte/gt/lte/lt, and ranges only on orderable fields. The
// fixtures also declare `eq` and ranges on boolean, string and object fields
// so that the freezing step has ineligible entries to leave out. Dropping
// those entries here does not change what a conforming AS freezes.
function declarationStreams(declaration: JsonObject): JsonObject[] {
	return (declaration.streams as JsonObject[]).map(
		({ cursor_field: _cursorField, ...stream }) => {
			// The reference records path only orders by a numeric or date cursor_field.
			// The fixtures name the string key `id`; omitting it orders by primary key,
			// which is the order the vectors expect.
			const properties = (stream.schema?.properties ?? {}) as JsonObject;
			const declared = (stream.query?.range_filters ?? {}) as Record<
				string,
				string[]
			>;
			const rangeFilters = Object.fromEntries(
				Object.entries(declared)
					.map(
						([field, ops]) =>
							[
								field,
								ops.filter((op) => ORDERED_OPERATORS.includes(op)),
							] as const,
					)
					.filter(
						([field, ops]) => ops.length > 0 && orderedType(properties[field]),
					),
			);
			// The reference server requires a primary key and a blob_ref with the
			// full blob descriptor; the fixtures state only what the vectors read.
			const blobRef = properties.blob_ref as JsonObject | undefined;
			const completed = blobRef
				? {
						...properties,
						blob_ref: {
							...blobRef,
							properties: {
								...blobRef.properties,
								sha256: { type: "string" },
								size_bytes: { type: "integer" },
							},
						},
					}
				: properties;
			return {
				primary_key: ["id"],
				semantics: "mutable_state",
				...stream,
				query: { ...stream.query, range_filters: rangeFilters },
				schema: { ...stream.schema, properties: completed },
				selection: { fields: true, resources: true },
			};
		},
	);
}

// The fixture preset lists `fields: ["*"]`; the vendored declaration schema
// takes concrete field names, and an omitted `fields` already means all of them.
function presetsFor(presets: JsonObject[]): JsonObject[] {
	return presets.map((preset) => ({
		...preset,
		streams: (preset.streams as JsonObject[]).map(({ fields, ...stream }) =>
			Array.isArray(fields) && fields.length === 1 && fields[0] === "*"
				? stream
				: { ...stream, fields },
		),
	}));
}

export function manifestFor(
	declaration: JsonObject,
	version: string,
	sourceId: string = SOURCE_ID,
): JsonObject {
	const streams = declarationStreams(declaration);
	return {
		capabilities: { human_interaction: [] },
		connector_id: sourceId,
		display_name: "Client range filter fixture",
		protocol_version: "0.1.0",
		source_declaration: {
			declaration_version: version,
			display: { name: "Client range filter fixture" },
			protocol_version: "0.1.0",
			publisher: { id: "https://pdpp.dev/reference-implementation/tests" },
			source: { id: sourceId, kind: "connector" },
			...(declaration.selection_presets
				? { selection_presets: presetsFor(declaration.selection_presets) }
				: {}),
			streams,
		},
		streams,
		version: "1.0.0",
	} as JsonObject;
}

export interface World {
	asUrl: string;
	close: () => Promise<void>;
	rsUrl: string;
	server: Awaited<ReturnType<typeof startServer>>;
}

interface Closeable {
	close: (callback?: (error?: Error) => void) => void;
	closeAllConnections: () => void;
}

export async function startWorld(
	options: {
		evaluable?: (input: { field: string; stream: string }) => boolean;
	} = {},
): Promise<World> {
	const server = await startServer({
		...TEST_INTROSPECTION_SERVER_OPTS,
		asPort: 0,
		clientRangeFilters: options.evaluable
			? { enabled: true, evaluable: options.evaluable }
			: true,
		dbPath: ":memory:",
		dynamicClientRegistrationInitialAccessTokens: [DCR_TOKEN],
		preRegisteredPublicClients: TEST_PRE_REGISTERED_PUBLIC_CLIENTS,
		quiet: true,
		rsPort: 0,
	} as Parameters<typeof startServer>[0]);
	const as = server.asServer as unknown as Closeable;
	const rs = server.rsServer as unknown as Closeable;
	return {
		asUrl: `http://localhost:${server.asPort}`,
		async close() {
			as.closeAllConnections();
			rs.closeAllConnections();
			await Promise.allSettled([
				new Promise<void>((resolve, reject) =>
					as.close((error) => (error ? reject(error) : resolve())),
				),
				new Promise<void>((resolve, reject) =>
					rs.close((error) => (error ? reject(error) : resolve())),
				),
			]);
		},
		rsUrl: `http://localhost:${server.rsPort}`,
		server,
	};
}

export async function fetchJson(
	url: string,
	init: RequestInit = {},
): Promise<{ body: Record<string, any>; headers: Headers; status: number }> {
	const response = await fetch(url, init);
	const text = await response.text();
	let body: Record<string, any> = {};
	try {
		body = text ? (JSON.parse(text) as Record<string, any>) : {};
	} catch {
		body = { raw: text };
	}
	return { body, headers: response.headers, status: response.status };
}

export async function registerManifest(
	world: World,
	manifest: JsonObject,
): Promise<void> {
	const response = await fetchJson(`${world.asUrl}/connectors`, {
		body: JSON.stringify(manifest),
		headers: { "Content-Type": "application/json" },
		method: "POST",
	});
	assert.ok(
		response.status === 201 || response.status === 200,
		`register connector: ${JSON.stringify(response.body)}`,
	);
}

export async function materializeConnection(
	instanceId: string,
	sourceId: string = SOURCE_ID,
): Promise<void> {
	const now = "2026-01-01T00:00:00.000Z";
	await createSqliteConnectorInstanceStore().upsert({
		connectorId: canonicalConnectorKey(sourceId) as string,
		connectorInstanceId: instanceId,
		createdAt: now,
		displayName: instanceId,
		ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
		sourceBinding: { kind: "test_account", label: instanceId },
		sourceBindingKey: instanceId,
		sourceKind: "account",
		status: "active",
		updatedAt: now,
	});
}

// Store records through the normal ingest path so versions and change history
// exist, then replace the current stored JSON text with the vector's exact
// lexemes. Change history keeps the ingested (double-rounded) form, which no
// vector reads exact values from.
export async function seedRecords(
	records: FixtureRecord[],
	exact: Map<string, string>,
): Promise<void> {
	for (const record of records) {
		await ingestRecord(
			{
				connector_id: CONNECTOR_KEY,
				connector_instance_id: record.instance_id,
			} as never,
			{
				data: record.data,
				emitted_at: "2026-01-10T00:00:00Z",
				key: record.key,
				stream: "transactions",
			} as never,
		);
		const text = exact.get(record.key);
		assert.ok(text !== undefined, `exact text for ${record.key}`);
		getDb()
			.prepare(
				"UPDATE records SET record_json = ? WHERE connector_instance_id = ? AND stream = ? AND record_key = ?",
			)
			.run(text, record.instance_id, "transactions", record.key);
	}
}

export interface IssuedGrant {
	grantId: string;
	token: string;
}

// The vendored Core selection schema requires RFC 3339 date-time bounds; the
// fixtures use plain dates for a date-typed consent field. Same instant.
function asDateTime(bound: string): string {
	return /^\d{4}-\d{2}-\d{2}$/.test(bound) ? `${bound}T00:00:00Z` : bound;
}

function authorizationDetailFor(
	grant: JsonObject,
	extra: JsonObject = {},
): JsonObject {
	const streams = (grant.streams as JsonObject[]).map((stream) => {
		const timeConstraint = stream.time_constraint as JsonObject | undefined;
		return {
			fields: stream.fields,
			instance_ids: stream.instance_ids,
			name: stream.name,
			...(stream.resources ? { resources: stream.resources } : {}),
			...(timeConstraint
				? {
						time_range: {
							...(timeConstraint.since
								? { since: asDateTime(timeConstraint.since) }
								: {}),
							...(timeConstraint.until
								? { until: asDateTime(timeConstraint.until) }
								: {}),
						},
					}
				: {}),
			...extra,
		};
	});
	return {
		access_mode: "continuous",
		purpose_code: "https://pdpp.dev/purpose/analytics",
		source: { id: SOURCE_ID, kind: "connector" },
		streams,
		type: "https://pdpp.dev/data-access",
	};
}

export async function issueClientGrant(
	world: World,
	grant: JsonObject,
): Promise<IssuedGrant> {
	const par = await fetchJson(`${world.asUrl}/oauth/par`, {
		body: JSON.stringify({
			authorization_details: [authorizationDetailFor(grant)],
			client_id: CLIENT_ID,
		}),
		headers: { "Content-Type": "application/json" },
		method: "POST",
	});
	assert.equal(par.status, 201, JSON.stringify(par.body));
	const review = await fetchJson(`${world.asUrl}/consent/review`, {
		body: JSON.stringify({
			request_uri: par.body.request_uri,
			subject_id: OWNER_AUTH_DEFAULT_SUBJECT_ID,
		}),
		headers: { Accept: "application/json", "Content-Type": "application/json" },
		method: "POST",
	});
	assert.equal(review.status, 200, JSON.stringify(review.body));
	const approved = await fetchJson(`${world.asUrl}/consent/approve`, {
		body: JSON.stringify({
			approval_review_revision: review.body.approval_review_revision,
			request_uri: par.body.request_uri,
		}),
		headers: { Accept: "application/json", "Content-Type": "application/json" },
		method: "POST",
	});
	assert.equal(approved.status, 200, JSON.stringify(approved.body));
	return {
		grantId: approved.body.grant?.grant_id ?? approved.body.grant_id,
		token: approved.body.token,
	};
}

// The vectors say what the grant carries. The seeded grant takes its frozen
// member from the fixture exactly, valid or not, so RS behavior is tested
// against that member and not against what this AS would have frozen.
export function setGrantExtensions(
	grantId: string,
	extensions: JsonObject | undefined,
): void {
	const row = getDb()
		.prepare("SELECT grant_json FROM grants WHERE grant_id = ?")
		.get(grantId) as { grant_json: string } | undefined;
	assert.ok(row, `grant ${grantId} exists`);
	const grant = JSON.parse(row.grant_json) as JsonObject;
	if (extensions === undefined) {
		Reflect.deleteProperty(grant, "extensions");
	} else {
		grant.extensions = extensions;
	}
	getDb()
		.prepare("UPDATE grants SET grant_json = ? WHERE grant_id = ?")
		.run(JSON.stringify(grant), grantId);
}

export { CLIENT_RANGE_FILTERS_PROFILE_URI, extensionsOf, toPlain };

// ---------------------------------------------------------------------------
// Vector execution
// ---------------------------------------------------------------------------

export function responseMember(response: ResponseLike, path: string): unknown {
	let value: unknown = { error: response.body.error, status: response.status };
	for (const part of path.split(".")) {
		value = (value as Record<string, unknown> | undefined)?.[part];
	}
	return value;
}

export interface ResponseLike {
	body: Record<string, any>;
	headers?: Headers;
	status: number;
}

function contains(actual: unknown, expected: unknown, where: string): void {
	if (Array.isArray(expected)) {
		assert.ok(Array.isArray(actual), `${where}: expected an array`);
		for (const item of expected) {
			assert.ok(
				(actual as unknown[]).some((candidate) => {
					try {
						contains(candidate, item, where);
						return true;
					} catch {
						return false;
					}
				}),
				`${where}: array lacks ${JSON.stringify(item)}`,
			);
		}
		return;
	}
	if (expected && typeof expected === "object") {
		assert.ok(
			actual && typeof actual === "object",
			`${where}: expected an object`,
		);
		for (const [key, value] of Object.entries(expected)) {
			contains(
				(actual as Record<string, unknown>)[key],
				value,
				`${where}.${key}`,
			);
		}
		return;
	}
	assert.deepEqual(actual, expected, where);
}

function asSets(value: unknown): unknown {
	if (Array.isArray(value)) {
		return [...value].map(asSets).sort();
	}
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [key, asSets(item)]),
		);
	}
	return value;
}

export function assertExpected(
	expected: Expected,
	response: ResponseLike,
	where: string,
): void {
	if (expected.status !== undefined) {
		assert.equal(
			response.status,
			expected.status,
			`${where}: status (${JSON.stringify(response.body).slice(0, 400)})`,
		);
	}
	if (expected.error !== undefined) {
		assert.equal(
			response.body.error?.code,
			expected.error,
			`${where}: error.code`,
		);
	}
	if (
		expected.record_keys !== undefined ||
		expected.tombstone_keys !== undefined ||
		expected.page_length !== undefined
	) {
		const data = (response.body.data ?? []) as Array<Record<string, unknown>>;
		if (expected.record_keys !== undefined) {
			assert.deepEqual(
				data
					.filter((record) => record.deleted !== true)
					.map((record) => record.id)
					.sort(),
				[...expected.record_keys].sort(),
				`${where}: record keys`,
			);
			assert.deepEqual(
				data
					.filter((record) => record.deleted === true)
					.map((record) => record.id)
					.sort(),
				[...(expected.tombstone_keys ?? [])].sort(),
				`${where}: tombstone keys`,
			);
			// Every tombstone lacks the members the vector forbids (a client
			// tombstone says nothing about when or why a record left).
			for (const tombstone of data.filter(
				(record) => record.deleted === true,
			)) {
				assert.deepEqual(
					Object.keys(tombstone).filter((key) =>
						(expected.tombstone_forbidden_members ?? []).includes(key),
					),
					[],
					`${where}: tombstone ${String(tombstone.id)} carries a forbidden member`,
				);
			}
		}
		if (expected.page_length !== undefined) {
			assert.equal(data.length, expected.page_length, `${where}: page length`);
		}
	}
	if (expected.has_more !== undefined) {
		assert.equal(
			response.body.has_more,
			expected.has_more,
			`${where}: has_more`,
		);
	}
	if (expected.next_cursor_present !== undefined) {
		assert.equal(
			Boolean(response.body.next_cursor),
			expected.next_cursor_present,
			`${where}: next_cursor presence`,
		);
	}
	if (expected.body_contains !== undefined) {
		contains(response.body, expected.body_contains, `${where}: body`);
	}
	if (expected.query_exact !== undefined) {
		for (const [key, value] of Object.entries(expected.query_exact)) {
			assert.deepEqual(
				asSets(response.body.query?.[key]),
				asSets(value),
				`${where}: query.${key}`,
			);
		}
	}
}

export function resolveQuery(
	query: Array<[string, string]>,
	captures: Map<string, string>,
): string {
	const search = new URLSearchParams();
	for (const [name, value] of query) {
		search.append(
			name,
			value.startsWith("$") ? (captures.get(value.slice(1)) ?? value) : value,
		);
	}
	return search.toString();
}
