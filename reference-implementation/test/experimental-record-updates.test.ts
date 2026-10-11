// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { executeRecordsList } from "../operations/rs-records-list/index.ts";
import { assertValidRecordEnvelope } from "../runtime/record-message-validator.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import {
	BOOTSTRAP_MAX_RECORDS,
	continueBootstrapPage,
	retainedBootstrapRecordIds,
	startBootstrapPage,
} from "../server/experimental-record-bootstrap.ts";
import { EXPERIMENTAL_PARTIAL_UPDATE_TYPE } from "../server/experimental-record-updates.ts";
import { deriveReferenceFreshness } from "../server/freshness.ts";
import {
	closePostgresStorage,
	initPostgresStorage,
	postgresQuery,
} from "../server/postgres-storage.ts";
import {
	classifyIngestFailure,
	getRecord,
	ingestRecord,
	maintainRecordIndexes,
	queryRecords,
	setClientEventEnqueueHook,
} from "../server/records.ts";
import { bumpStorageGeneration } from "../server/storage-generation.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";
import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts";

const connectorId = "experimental_record_updates";
const target = {
	connectorId,
	connectorInstanceId: "cin_experimental_record_updates",
};
const schema = {
	properties: {
		array: { type: "array" },
		created_at: { format: "date-time", type: "string" },
		id: { type: "string" },
		nested: { type: "object" },
		numeric: { type: "integer" },
		optional: { type: ["string", "null"] },
		required: { type: "string" },
	},
	required: ["id", "required"],
	type: "object",
};
const manifest = {
	streams: [
		...[
			"events",
			"state",
			"bootstrap",
			"bootstrap-followup",
			"bootstrap-order",
		].map((name) => ({
			consent_time_field: "created_at",
			cursor_field: "created_at",
			name,
			primary_key: ["id"],
			schema,
			semantics: name === "events" ? "append_only" : "mutable_state",
		})),
		...["alpha", "beta"].map((name) => ({
			name,
			primary_key: ["id"],
			schema: {
				$id: "https://example.test/reused-schema-id",
				properties: { id: { type: "string" }, [name]: { type: "string" } },
				required: ["id", name],
				type: "object",
			},
			semantics: "mutable_state",
		})),
		{
			name: "own-properties",
			primary_key: ["id"],
			schema: {
				properties: {
					constructor: {},
					id: { type: "string" },
				} as Record<string, { type?: string }>,
				required: ["id", "constructor"],
				type: "object",
			},
			semantics: "mutable_state",
		},
		{
			name: "finite-numbers",
			primary_key: ["id"],
			schema: {
				properties: {
					array: { type: "array" },
					id: { type: "string" },
					loose: { not: { type: "null" } },
					nested: { type: "object" },
					value: { type: "number" },
				},
				required: ["id", "value"],
				type: "object",
			},
			semantics: "mutable_state",
		},
		{
			name: "indexed",
			primary_key: ["id"],
			query: { search: { lexical_fields: ["required", "optional"] } },
			schema,
			semantics: "mutable_state",
		},
	],
};
function setup() {
	process.env.PDPP_EXPERIMENTAL_RECORD_UPDATES = "1";
	initDb(":memory:");
	getDb()
		.prepare("INSERT INTO connectors(connector_id, manifest) VALUES(?, ?)")
		.run(connectorId, JSON.stringify(manifest));
}
function snapshot(
	stream = "events",
	data = { id: "a", nested: { a: 1, b: 2 }, required: "value" },
) {
	return { data, emitted_at: "2026-10-01T00:00:00Z", key: "a", stream };
}
function rows() {
	return getDb()
		.prepare("SELECT record_json, emitted_at, version FROM records")
		.all();
}

interface HistoryRow {
	record_json: unknown;
	version: number | string;
}
function assertCompleteHistory(
	history: HistoryRow[],
	expected: Array<{ data: unknown; version: number }>,
): void {
	assert.deepEqual(
		history.map((row) => ({
			data:
				typeof row.record_json === "string"
					? JSON.parse(row.record_json)
					: row.record_json,
			version: Number(row.version),
		})),
		expected,
		"every changed write must retain its complete snapshot in version order",
	);
}

const postgresUrl = dedicatedPostgresTestUrl(
	process.env.PDPP_TEST_POSTGRES_URL,
);
for (const backend of ["sqlite", "postgres"] as const) {
	test(`${backend}: experimental #398 snapshots, duplicates and partial instructions`, {
		skip:
			backend === "postgres" && !postgresUrl
				? "PDPP_TEST_POSTGRES_URL unset"
				: false,
	}, async (t) => {
		async function run(databaseUrl?: string) {
			process.env.PDPP_EXPERIMENTAL_RECORD_UPDATES = "1";
			initDb(":memory:");
			if (databaseUrl) {
				await initPostgresStorage({ backend: "postgres", databaseUrl });
				await postgresQuery(
					"INSERT INTO connectors(connector_id, manifest, created_at) VALUES($1, $2::jsonb, $3)",
					[connectorId, JSON.stringify(manifest), "2026-10-01T00:00:00Z"],
				);
			} else {
				getDb()
					.prepare(
						"INSERT INTO connectors(connector_id, manifest) VALUES(?, ?)",
					)
					.run(connectorId, JSON.stringify(manifest));
			}
			const write = (
				record: Parameters<typeof ingestRecord>[1],
				instance = target,
			) => ingestRecord(instance, record, { deferIndexes: true });
			const grant = {
				streams: [
					{
						fields: ["id", "required", "optional", "nested", "array"],
						name: "state",
					},
					{
						fields: ["id", "required", "optional", "nested", "array"],
						name: "events",
					},
				],
			};
			const read = async (stream: string, fields?: string[]) => {
				const record = await getRecord(
					target,
					stream,
					"a",
					fields ? { streams: [{ fields, name: stream }] } : grant,
					manifest,
				);
				assert.ok(record.data);
				return { ...record, data: record.data };
			};
			const instruction = (
				set: unknown,
				remove: unknown = [],
				stream = "state",
			) => ({
				key: "a",
				remove,
				set,
				stream,
				type: EXPERIMENTAL_PARTIAL_UPDATE_TYPE,
			});
			const databaseState = async () => {
				const tables = ["records", "record_changes", "version_counter"];
				return await Promise.all(
					tables.map(async (table) => {
						const sql = `SELECT * FROM ${table} ORDER BY stream, ${table === "version_counter" ? "max_version" : "version"}`;
						return databaseUrl
							? (await postgresQuery(sql)).rows
							: getDb().prepare(sql).all();
					}),
				);
			};
			try {
				await t.test(
					"JSON equality and append_only schema/identity validation before duplicate conflict",
					async () => {
						let notifications = 0;
						setClientEventEnqueueHook(() => {
							notifications += 1;
						});
						await write({ ...snapshot(), type: "RECORD" });
						const original = await databaseState();
						await write({
							...snapshot(),
							data: JSON.parse(
								'{ "nested": {"b":2.0,"a":1e0}, "required":"value", "id":"a" }',
							),
							emitted_at: "2026-10-02T00:00:00Z",
						});
						assert.deepEqual(
							await databaseState(),
							original,
							"equal JSON retry changes no storage",
						);
						await assert.rejects(
							write({
								...snapshot(),
								data: { id: "wrong", required: "value" },
							}),
							{
								code: "invalid_record_identity",
							},
						);
						await assert.rejects(write({ ...snapshot(), key: [] }), {
							code: "invalid_record_identity",
						});
						await assert.rejects(
							write({ ...snapshot(), data: { required: "value" } }),
							{
								code: "invalid_record_identity",
							},
						);
						await assert.rejects(write({ ...snapshot(), data: { id: "a" } }), {
							code: "invalid_record_schema",
						});
						await assert.rejects(
							write({ ...snapshot(), data: { id: "a", required: null } }),
							{
								code: "invalid_record_schema",
							},
						);
						await assert.rejects(
							write(instruction({ required: "no" }, [], "events")),
							{
								code: "invalid_partial_update",
							},
						);
						const conflict = await write({
							...snapshot(),
							data: { id: "a", required: "different" },
						}).catch((error) => error);
						assert.deepEqual(classifyIngestFailure(conflict), {
							code: "append_only_record_conflict",
							message: conflict.message,
							retryable: false,
						});
						assert.deepEqual(
							await databaseState(),
							original,
							"rejected writes leave history and versions intact",
						);
						assert.equal(
							notifications,
							1,
							"equal retry and changed conflict emit no client event",
						);
						setClientEventEnqueueHook(null);
						await write({
							data: { array: [1, 2], id: "array", required: "value" },
							key: "array",
							stream: "events",
						});
						await assert.rejects(
							write({
								data: { array: [2, 1], id: "array", required: "value" },
								key: "array",
								stream: "events",
							}),
							{ code: "append_only_record_conflict" },
						);
					},
				);
				await t.test(
					"beginning and retries; pruned append_only history anchor stays unchanged",
					async () => {
						const beginning = await queryRecords(
							target,
							"events",
							grant,
							{ changes_since: "beginning" },
							manifest,
						);
						assert.equal(beginning.data.length, 2);
						const cursor = beginning.next_changes_since;
						assert.ok(
							cursor,
							"the completed beginning session must issue a retry cursor",
						);
						assert.equal(
							(await write(snapshot())).changed,
							false,
							"retry after saving the session cursor",
						);
						const afterRetry = await queryRecords(
							target,
							"events",
							grant,
							{ changes_since: cursor },
							manifest,
						);
						assert.equal(afterRetry.data.length, 0);
						if (databaseUrl) {
							await postgresQuery(
								"DELETE FROM record_changes WHERE stream = $1 AND record_key = 'a'",
								["events"],
							);
						} else {
							getDb()
								.prepare(
									"DELETE FROM record_changes WHERE stream = ? AND record_key = 'a'",
								)
								.run("events");
						}
						const pruned = await databaseState();
						assert.equal(
							(await write(snapshot())).changed,
							false,
							"pruned append_only anchor stays no-op",
						);
						assert.deepEqual(await databaseState(), pruned);
					},
				);
				await t.test(
					"beginning after anchor pruning enumerates current append_only state without a duplicate version",
					async () => {
						const before = await databaseState();
						const beginning = await queryRecords(
							target,
							"events",
							grant,
							{ changes_since: "beginning" },
							manifest,
						);
						assert.deepEqual(beginning.data.map((record) => record.id).sort(), [
							"a",
							"array",
						]);
						assert.equal(
							beginning.data.find((record) => record.id === "a")?.data
								?.required,
							"value",
						);
						assert.ok(beginning.next_changes_since);
						assert.deepEqual(
							await databaseState(),
							before,
							"bootstrap is read-only",
						);
					},
				);
				await t.test(
					"instance scoping, delete and post-delete reinsert",
					async () => {
						const otherTarget = {
							...target,
							connectorInstanceId: "cin_other_experimental_record_updates",
						};
						await write(snapshot(), otherTarget);
						const beforeDelete = await queryRecords(
							otherTarget,
							"events",
							grant,
							{ changes_since: "beginning" },
							manifest,
						);
						assert.ok(beforeDelete.next_changes_since);
						await write(
							{ key: "a", op: "delete", stream: "events" },
							otherTarget,
						);
						const tombstones = await queryRecords(
							otherTarget,
							"events",
							grant,
							{ changes_since: beforeDelete.next_changes_since },
							manifest,
						);
						assert.equal(tombstones.data.length, 1);
						assert.equal(tombstones.data[0]?.deleted, true);
						assert.equal(tombstones.data[0]?.id, "a");
						assert.equal(
							tombstones.data[0]?.data,
							undefined,
							"delete is served as a tombstone, not an instruction or snapshot",
						);
						await write({ key: "a", op: "delete", stream: "events" });
						await write({
							...snapshot(),
							data: { id: "a", required: "reinserted" },
						});
						assert.equal((await read("events")).data.required, "reinserted");
					},
				);
				await t.test(
					"partial set/null/remove preserve unnamed values and projected reads",
					async () => {
						await write({
							...snapshot("state"),
							data: {
								array: [1, 2],
								created_at: "2026-10-01T00:00:00Z",
								id: "a",
								nested: { one: 1 },
								optional: "present",
								required: "value",
							},
						});
						await write(instruction({ optional: null }));
						assert.equal((await read("state")).data.optional, null);
						await write(instruction({}, ["optional"]));
						const absent = await read("state");
						assert.equal(Object.hasOwn(absent.data, "optional"), false);
						assert.deepEqual(absent.data.nested, { one: 1 });
						const projected = await read("state", ["id", "optional"]);
						assert.deepEqual(
							projected.data,
							{ id: "a", required: "value" },
							"owner effective projection includes required fields",
						);
						const clientRecord = await getRecord(
							target,
							"state",
							"a",
							{
								streams: [
									{
										fields: ["id", "optional"],
										instance_ids: [target.connectorInstanceId],
										name: "state",
									},
								],
							},
							manifest,
						);
						assert.deepEqual(
							clientRecord.data,
							{ id: "a" },
							"client projection uses frozen grant fields; omission outside it reveals nothing",
						);
					},
				);
				await t.test(
					"required fields, nullability, identity and malformed instructions roll back atomically",
					async () => {
						const beforeInvalid = await databaseState();
						for (const invalid of [
							instruction({}, ["required"]),
							instruction({ required: null }),
							instruction({ id: "changed" }),
							instruction({}, ["id"]),
							instruction({ optional: "x" }, ["optional"]),
							instruction([], []),
							instruction({}, [42]),
							{ ...instruction({}), data: null },
							{ ...instruction({}), op: "upsert" as const },
						]) {
							await assert.rejects(write(invalid));
						}
						assert.deepEqual(
							await databaseState(),
							beforeInvalid,
							"invalid resulting snapshots roll back atomically",
						);
					},
				);
				await t.test(
					"concurrent instructions preserve both writers and array order is significant",
					async () => {
						await Promise.all([
							write(instruction({ optional: "concurrent" })),
							write(instruction({ nested: { two: 2 } })),
						]);
						const concurrent = await read("state");
						assert.equal(concurrent.data.optional, "concurrent");
						assert.deepEqual(concurrent.data.nested, { two: 2 });
						assert.equal(concurrent.data.required, "value");
						await write(instruction({ array: [2, 1] }));
						assert.deepEqual(
							(await read("state")).data.array,
							[2, 1],
							"array order is meaningful",
						);
					},
				);
				await t.test(
					"time constraints and changes_since use complete resulting snapshots",
					async () => {
						const timedGrant = {
							streams: [
								{
									fields: [
										"id",
										"required",
										"optional",
										"nested",
										"array",
										"created_at",
									],
									name: "state",
									time_constraint: {
										field: "created_at",
										since: "2026-10-02T00:00:00Z",
									},
								},
							],
						};
						assert.equal(
							(await queryRecords(target, "state", timedGrant, {}, manifest))
								.data.length,
							0,
						);
						await write(instruction({ created_at: "2026-10-03T00:00:00Z" }));
						const timed = await queryRecords(
							target,
							"state",
							timedGrant,
							{},
							manifest,
						);
						assert.equal(timed.data.length, 1);
						assert.equal(
							timed.data[0]?.data?.optional,
							"concurrent",
							"unobserved named-independent field survives instruction",
						);
						const changes = await queryRecords(
							target,
							"state",
							timedGrant,
							{ changes_since: "beginning" },
							manifest,
						);
						assert.equal(changes.data.length, 1);
						assert.equal(changes.data[0]?.data?.required, "value");
						assert.deepEqual(changes.data[0]?.data?.nested, { two: 2 });
						assert.equal(
							Object.hasOwn(changes.data[0]?.data ?? {}, "type"),
							false,
						);
					},
				);
				await t.test(
					"new collection freshness does not establish reobservation of preserved unnamed fields",
					async () => {
						const previouslyStored = (await read("state")).data.optional;
						const capturedAt = "2026-10-04T00:00:00Z";
						await write({
							...instruction({ required: "freshly collected" }),
							emitted_at: capturedAt,
						});
						assert.equal(
							(await read("state")).data.optional,
							previouslyStored,
							"instruction leaves unobserved optional field intact",
						);
						const freshness = deriveReferenceFreshness({
							lastAttemptedAt: capturedAt,
							lastSuccessfulRunAt: capturedAt,
							maximumStalenessSeconds: 3600,
							now: "2026-10-04T00:05:00Z",
						});
						assert.deepEqual(freshness, {
							captured_at: "2026-10-04T00:00:00.000Z",
							last_attempted_at: "2026-10-04T00:00:00.000Z",
							status: "current",
						});
					},
				);
				await t.test(
					"sparse resolved-client response preserves cached fields outside its projection",
					async () => {
						const stored = {
							id: "cache",
							nested: { keep: true },
							optional: "keep",
							required: "Ada",
						};
						await write({ data: stored, key: "cache", stream: "state" });
						const clientGrant = {
							streams: [
								{
									fields: ["id", "required", "optional", "nested", "array"],
									instance_ids: [target.connectorInstanceId],
									name: "state",
									resources: ["cache"],
								},
							],
						};
						const requested = ["optional", "array"];
						const output = await executeRecordsList(
							{
								actor: {
									kind: "client",
									subject_id: "owner",
									client_id: "client",
									grant_id: "grant",
								},
								rawQueryFields: requested.join(","),
								requestParams: { fields: requested },
								streamName: "state",
							},
							{
								decorateRecord: (record) => record,
								experimentalRecordUpdatesEnabled: () => true,
								getGrant: () => clientGrant,
								getManifest: () => manifest,
								getSourceDescriptor: () => ({
									id: connectorId,
									kind: "connector",
								}),
								queryRecords: async (stream, _grant, params) => {
									const result = await queryRecords(
										target,
										stream,
										clientGrant,
										params,
										manifest,
									);
									return {
										...result,
										data: result.data.map((record) => ({ ...record })),
									};
								},
								validateRequestFields: () => {},
							},
						);
						assert.deepEqual(
							output.result.data[0]?.data,
							{ id: "cache", optional: "keep", required: "Ada" },
							"required fields survive the final operation projection",
						);
						const cache: Record<string, unknown> = {
							...stored,
							array: ["stale"],
						};
						const returned = output.result.data[0]?.data as Record<
							string,
							unknown
						>;
						for (const field of ["id", "required", ...requested]) {
							if (Object.hasOwn(returned, field))
								cache[field] = returned[field];
							else delete cache[field];
						}
						assert.deepEqual(
							cache,
							stored,
							"an absent requested field disappears; unrequested nested value survives",
						);
						const full = await queryRecords(
							target,
							"state",
							clientGrant,
							{},
							manifest,
						);
						assert.deepEqual(
							full.data[0]?.data,
							stored,
							"sparse response does not delete stored values",
						);
					},
				);
				await t.test(
					"sparse client changes_since eligibility uses the full frozen grant projection",
					async () => {
						const data = {
							id: "eligibility",
							optional: "before",
							required: "stable",
						};
						await write({ data, key: "eligibility", stream: "state" });
						const clientGrant = {
							streams: [
								{
									fields: ["id", "required", "optional"],
									instance_ids: [target.connectorInstanceId],
									name: "state",
									resources: ["eligibility"],
								},
							],
						};
						const fields = ["id", "required"];
						const beginning = await queryRecords(
							target,
							"state",
							clientGrant,
							{ changes_since: "beginning", fields },
							manifest,
						);
						assert.ok(beginning.next_changes_since);
						assert.deepEqual(beginning.data[0]?.data, {
							id: "eligibility",
							required: "stable",
						});
						await write({
							...instruction({ optional: "after" }),
							key: "eligibility",
						});
						const delta = await queryRecords(
							target,
							"state",
							clientGrant,
							{ changes_since: beginning.next_changes_since, fields },
							manifest,
						);
						assert.equal(
							delta.data.length,
							1,
							"unrequested granted-field change still qualifies for sync",
						);
						assert.deepEqual(
							delta.data[0]?.data,
							beginning.data[0]?.data,
							"response is sparse even when eligibility uses more fields",
						);
					},
				);
				await t.test(
					"bootstrap pages preserve authorized h1 state after writes and history pruning",
					async () => {
						for (const id of ["a", "b", "c", "deleted", "hidden", "old"]) {
							await write({
								data: {
									created_at:
										id === "old"
											? "2026-09-01T00:00:00Z"
											: "2026-10-01T00:00:00Z",
									id,
									required: "at-h1",
								},
								key: id,
								stream: "bootstrap",
							});
						}
						await write({ key: "deleted", op: "delete", stream: "bootstrap" });
						const scope = {
							streams: [
								{
									fields: ["id", "required", "optional"],
									instance_ids: [target.connectorInstanceId],
									name: "bootstrap",
									resources: ["a", "b", "c", "deleted", "old"],
									time_constraint: {
										field: "created_at",
										since: "2026-10-01T00:00:00Z",
									},
								},
							],
						};
						const prune = async () => {
							if (databaseUrl)
								await postgresQuery(
									"DELETE FROM record_changes WHERE stream = 'bootstrap'",
								);
							else
								getDb()
									.prepare(
										"DELETE FROM record_changes WHERE stream = 'bootstrap'",
									)
									.run();
						};
						await prune();
						const before = await databaseState();
						let page = await queryRecords(
							target,
							"bootstrap",
							scope,
							{ changes_since: "beginning", limit: 1, order: "asc" },
							manifest,
						);
						assert.equal(page.has_more, true);
						assert.ok(page.next_cursor);
						assert.equal(
							page.next_changes_since,
							undefined,
							"sync token is terminal-only",
						);
						assert.deepEqual(
							await databaseState(),
							before,
							"capturing h1 is read-only",
						);
						const firstCursor = page.next_cursor;
						await assert.rejects(
							queryRecords(
								target,
								"bootstrap",
								scope,
								{ cursor: firstCursor, fields: ["id"], limit: 1, order: "asc" },
								manifest,
							),
							{ code: "invalid_cursor" },
						);
						await write({
							data: {
								created_at: "2026-10-01T00:00:00Z",
								id: "b",
								required: "after-h1",
							},
							key: "b",
							stream: "bootstrap",
						});
						await write({ key: "c", op: "delete", stream: "bootstrap" });
						await write({
							data: {
								created_at: "2026-10-01T00:00:00Z",
								id: "later",
								required: "after-h1",
							},
							key: "later",
							stream: "bootstrap",
						});
						await prune();
						const collected = [...page.data];
						while (page.has_more) {
							assert.ok(page.next_cursor);
							page = await queryRecords(
								target,
								"bootstrap",
								scope,
								{ cursor: page.next_cursor, limit: 1, order: "asc" },
								manifest,
							);
							collected.push(...page.data);
							if (page.has_more)
								assert.equal(page.next_changes_since, undefined);
						}
						assert.deepEqual(
							collected.map((record) => record.id),
							["a", "b"],
						);
						assert.deepEqual(
							collected.map((record) => record.data),
							["a", "b"].map((id) => ({ id, required: "at-h1" })),
						);
						assert.ok(page.next_changes_since);
						await write({
							data: {
								created_at: "2026-10-01T00:00:00Z",
								id: "b",
								required: "one",
							},
							key: "b",
							stream: "bootstrap",
						});
						await write({
							data: {
								created_at: "2026-10-01T00:00:00Z",
								id: "b",
								required: "two",
							},
							key: "b",
							stream: "bootstrap",
						});
						if (databaseUrl)
							await postgresQuery(
								"DELETE FROM record_changes WHERE stream = 'bootstrap' AND version < (SELECT MAX(version) FROM record_changes WHERE stream = 'bootstrap')",
							);
						else
							getDb()
								.prepare(
									"DELETE FROM record_changes WHERE stream = 'bootstrap' AND version < (SELECT MAX(version) FROM record_changes WHERE stream = 'bootstrap')",
								)
								.run();
						await assert.rejects(
							queryRecords(
								target,
								"bootstrap",
								scope,
								{ changes_since: page.next_changes_since, order: "asc" },
								manifest,
							),
							{ code: "cursor_expired" },
						);
						const restarted = await queryRecords(
							target,
							"bootstrap",
							scope,
							{ changes_since: "beginning", order: "asc" },
							manifest,
						);
						assert.deepEqual(restarted.data.map((record) => record.id).sort(), [
							"a",
							"b",
						]);
					},
				);
				await t.test(
					"post-pruning bootstrap suppresses ungranted changes and retains later deletion baselines",
					async () => {
						const record = {
							data: { id: "a", optional: "before", required: "stable" },
							key: "a",
							stream: "bootstrap-followup",
						};
						await write(record);
						if (databaseUrl)
							await postgresQuery(
								"DELETE FROM record_changes WHERE stream = 'bootstrap-followup'",
							);
						else
							getDb()
								.prepare(
									"DELETE FROM record_changes WHERE stream = 'bootstrap-followup'",
								)
								.run();
						const clientGrant = {
							streams: [
								{
									fields: ["id", "required"],
									instance_ids: [target.connectorInstanceId],
									name: "bootstrap-followup",
								},
							],
						};
						const beginning = await queryRecords(
							target,
							"bootstrap-followup",
							clientGrant,
							{ changes_since: "beginning" },
							manifest,
						);
						assert.ok(beginning.next_changes_since);
						await write(
							instruction({ optional: "after" }, [], "bootstrap-followup"),
						);
						const unchanged = await queryRecords(
							target,
							"bootstrap-followup",
							clientGrant,
							{ changes_since: beginning.next_changes_since },
							manifest,
						);
						assert.deepEqual(
							unchanged.data,
							[],
							"ungranted changes must not qualify for incremental sync",
						);
						assert.ok(unchanged.next_changes_since);
						await write({
							key: "a",
							op: "delete",
							stream: "bootstrap-followup",
						});
						const deletion = await queryRecords(
							target,
							"bootstrap-followup",
							clientGrant,
							{ changes_since: unchanged.next_changes_since },
							manifest,
						);
						assert.equal(
							deletion.data.length,
							1,
							"rolling h0 baseline must retain the prior authorized record",
						);
						assert.equal(deletion.data[0]?.deleted, true);
					},
				);
				await t.test(
					"retained sync pages order records and tombstones by canonical key and bind direction",
					async () => {
						const stream = "bootstrap-order";
						for (const id of ["z", "a", "m"])
							await write({
								stream,
								key: id,
								data: { id, required: "before" },
							});
						const orderGrant = {
							streams: [
								{
									name: stream,
									fields: ["id", "required"],
									instance_ids: [target.connectorInstanceId],
								},
							],
						};
						const first = await queryRecords(
							target,
							stream,
							orderGrant,
							{ changes_since: "beginning", limit: 1, order: "asc" },
							manifest,
						);
						assert.ok(first.next_cursor);
						const ids = first.data.map((record) => record.id);
						let page = first;
						while (page.next_cursor) {
							page = await queryRecords(
								target,
								stream,
								orderGrant,
								{ cursor: page.next_cursor, limit: 1, order: "asc" },
								manifest,
							);
							ids.push(...page.data.map((record) => record.id));
						}
						assert.deepEqual(
							ids,
							["a", "m", "z"],
							"bootstrap order must not reveal write order",
						);
						assert.ok(page.next_changes_since);
						await assert.rejects(
							queryRecords(
								target,
								stream,
								orderGrant,
								{ cursor: first.next_cursor, limit: 1, order: "desc" },
								manifest,
							),
							{ code: "invalid_cursor" },
						);
						const descending = await queryRecords(
							target,
							stream,
							orderGrant,
							{ changes_since: "beginning", order: "desc" },
							manifest,
						);
						assert.deepEqual(
							descending.data.map((record) => record.id),
							["z", "m", "a"],
						);
						await write({
							stream,
							key: "z",
							data: { id: "z", required: "after" },
						});
						await write({ stream, key: "a", op: "delete" });
						const changes = await queryRecords(
							target,
							stream,
							orderGrant,
							{ changes_since: page.next_changes_since, order: "asc" },
							manifest,
						);
						assert.deepEqual(
							changes.data.map((record) => [
								record.id,
								record.deleted === true,
							]),
							[
								["a", true],
								["z", false],
							],
							"tombstones and snapshots share canonical key order",
						);
					},
				);
				await t.test(
					"client list preserves tombstone envelopes with full and sparse responses",
					async () => {
						await write({
							data: { id: "tombstone", required: "before" },
							key: "tombstone",
							stream: "state",
						});
						const clientGrant = {
							streams: [
								{
									fields: ["id", "required"],
									instance_ids: [target.connectorInstanceId],
									name: "state",
									resources: ["tombstone"],
								},
							],
						};
						const beginning = await queryRecords(
							target,
							"state",
							clientGrant,
							{ changes_since: "beginning" },
							manifest,
						);
						assert.ok(beginning.next_changes_since);
						await write({ key: "tombstone", op: "delete", stream: "state" });
						for (const fields of [undefined, ["id"]]) {
							const params = {
								changes_since: beginning.next_changes_since,
								...(fields ? { fields } : {}),
							};
							const output = await executeRecordsList(
								{
									actor: {
										kind: "client",
										subject_id: "owner",
										client_id: "client",
										grant_id: "grant",
									},
									requestParams: params,
									streamName: "state",
								},
								{
									decorateRecord: (record) => record,
									experimentalRecordUpdatesEnabled: () => true,
									getGrant: () => clientGrant,
									getManifest: () => manifest,
									getSourceDescriptor: () => ({
										id: connectorId,
										kind: "connector",
									}),
									queryRecords: async (stream, _grant, request) => {
										const result = await queryRecords(
											target,
											stream,
											clientGrant,
											request,
											manifest,
										);
										return {
											...result,
											data: result.data.map((record) => ({ ...record })),
										};
									},
									validateRequestFields: () => {},
								},
							);
							assert.equal(output.result.data.length, 1);
							assert.equal(output.result.data[0]?.deleted, true);
							assert.equal(output.result.data[0]?.object, "record");
							assert.equal(output.result.data[0]?.stream, "state");
							assert.equal(output.result.data[0]?.id, "tombstone");
							assert.equal(output.result.data[0]?.data, undefined);
						}
					},
				);
				await t.test(
					"snapshot replacement and complete version history",
					async () => {
						const initial = {
							array: [1, 2],
							id: "history",
							nested: { one: 1 },
							optional: "present",
							required: "initial",
						};
						const nullable = { ...initial, optional: null };
						const removed = {
							array: [1, 2],
							id: "history",
							nested: { one: 1 },
							required: "initial",
						};
						const replacement = { id: "history", required: "replacement" };
						const writes = [
							{ data: initial, key: "history", stream: "state" },
							{ ...instruction({ optional: null }), key: "history" },
							{ ...instruction({}, ["optional"]), key: "history" },
							{ data: replacement, key: "history", stream: "state" },
						];
						const expected: Array<{ data: unknown; version: number }> = [];
						for (const [index, record] of writes.entries()) {
							const outcome = await write(record);
							assert.equal(outcome.changed, true);
							assert.equal(typeof outcome.version, "number");
							expected.push({
								data: [initial, nullable, removed, replacement][index],
								version: outcome.version as number,
							});
						}
						const historySql =
							"SELECT record_json, version FROM record_changes WHERE stream = 'state' AND record_key = 'history' AND NOT deleted ORDER BY version";
						const history = databaseUrl
							? (await postgresQuery(historySql)).rows
							: getDb().prepare(historySql).all();
						assertCompleteHistory(history as HistoryRow[], expected);
						assert.throws(
							() => assertCompleteHistory([], expected),
							"the oracle must reject deleted history",
						);
						assert.throws(
							() =>
								assertCompleteHistory(
									(history as HistoryRow[]).slice(1),
									expected,
								),
							"the oracle must reject a missing partial snapshot",
						);
						assert.throws(
							() =>
								assertCompleteHistory(
									[...(history as HistoryRow[])].reverse(),
									expected,
								),
							"the oracle must reject reordered versions",
						);
						assert.throws(
							() =>
								assertCompleteHistory(
									(history as HistoryRow[]).map((row) => ({
										...row,
										record_json: replacement,
									})),
									expected,
								),
							"the oracle must reject loss of unnamed historical values",
						);
					},
				);
				await t.test(
					"schema IDs are scoped to schema contents and do not collide across streams",
					async () => {
						await write({
							data: { alpha: "first schema", id: "a" },
							key: "a",
							stream: "alpha",
						});
						await write({
							data: { beta: "second schema", id: "a" },
							key: "a",
							stream: "beta",
						});
						await assert.rejects(
							write({
								data: { alpha: "wrong schema", id: "a" },
								key: "a",
								stream: "beta",
							}),
							{
								code: "invalid_record_schema",
							},
						);
					},
				);
				await t.test(
					"removing required constructor cannot be satisfied by inherited properties and is atomic",
					async () => {
						await write({
							data: { constructor: "own value", id: "a" },
							key: "a",
							stream: "own-properties",
						});
						const before = await databaseState();
						await assert.rejects(
							write(instruction({}, ["constructor"], "own-properties")),
							{
								code: "invalid_record_schema",
							},
						);
						assert.deepEqual(await databaseState(), before);
					},
				);
				await t.test(
					"derived lexical index receives complete snapshots after partial instructions",
					async () => {
						const full = {
							data: {
								id: "a",
								optional: "old search text",
								required: "retained search text",
							},
							key: "a",
							stream: "indexed",
						};
						const initial = await write(full);
						assert.ok(initial.version);
						const indexOptions = {
							attemptContext: {
								streams: {
									indexed: {
										lexicalFields: ["required", "optional"],
										primaryKey: ["id"],
										semanticFields: [],
									},
								},
							},
						};
						await maintainRecordIndexes(
							target,
							full,
							initial.version,
							indexOptions,
						);
						const partial = instruction(
							{ optional: "updated search text" },
							[],
							"indexed",
						);
						const updated = await write(partial);
						assert.ok(updated.version);
						await maintainRecordIndexes(
							target,
							partial,
							updated.version,
							indexOptions,
						);
						const sql =
							"SELECT field, text FROM lexical_search_index WHERE connector_instance_id = ? AND stream = 'indexed' ORDER BY field";
						const indexed = databaseUrl
							? (
									await postgresQuery(
										sql
											.replace("?", "$1")
											.replace("field, text", "field, value AS text"),
										[target.connectorInstanceId],
									)
								).rows
							: getDb().prepare(sql).all(target.connectorInstanceId);
						assert.deepEqual(
							indexed.map((row) => ({ ...(row as object) })),
							[
								{ field: "optional", text: "updated search text" },
								{ field: "required", text: "retained search text" },
							],
						);
						const removal = instruction({}, ["optional"], "indexed");
						const removed = await write(removal);
						assert.ok(removed.version);
						await maintainRecordIndexes(
							target,
							removal,
							removed.version,
							indexOptions,
						);
						const remaining = databaseUrl
							? (
									await postgresQuery(
										sql
											.replace("?", "$1")
											.replace("field, text", "field, value AS text"),
										[target.connectorInstanceId],
									)
								).rows
							: getDb().prepare(sql).all(target.connectorInstanceId);
						assert.deepEqual(
							remaining.map((row) => ({ ...(row as object) })),
							[{ field: "required", text: "retained search text" }],
							"named field disappears from index while unnamed full-snapshot field survives",
						);
					},
				);
				await t.test(
					"observed precision limit: distinct unsafe JSON integers collapse before append_only equality",
					async () => {
						const firstJson =
							'{"stream":"events","key":"precision","data":{"id":"precision","required":"value","numeric":9007199254740992}}';
						const secondJson =
							'{"stream":"events","key":"precision","data":{"id":"precision","required":"value","numeric":9007199254740993}}';
						assert.notEqual(firstJson, secondJson);
						const first = JSON.parse(firstJson);
						const second = JSON.parse(secondJson);
						assert.equal(
							first.data.numeric,
							second.data.numeric,
							"native JSON.parse already discarded the distinct integer value",
						);
						await write(first);
						const before = await databaseState();
						assert.equal(
							(await write(second)).changed,
							false,
							"prototype compares parsed JSON values and cannot detect this raw producer conflict",
						);
						assert.deepEqual(await databaseState(), before);
					},
				);
				await t.test(
					"overflowing JSON numbers cannot become stored null and reject atomically",
					async () => {
						await write({
							data: { id: "a", value: 1 },
							key: "a",
							stream: "finite-numbers",
						});
						const before = await databaseState();
						for (const value of ["1e400", "-1e400"]) {
							for (const rawSet of [
								`{"value":${value}}`,
								`{"loose":${value}}`,
								`{"nested":{"value":${value}}}`,
								`{"array":[${value}]}`,
							]) {
								const set = JSON.parse(rawSet);
								await assert.rejects(
									write({
										data: { id: "a", value: 1, ...set },
										key: "a",
										stream: "finite-numbers",
									}),
									{ code: "invalid_record_schema" },
								);
								await assert.rejects(
									write(instruction(set, [], "finite-numbers")),
									{ code: "invalid_record_schema" },
								);
							}
						}
						assert.deepEqual(await databaseState(), before);
					},
				);
				await t.test(
					"flag off retains RECORD legacy rewrites and rejects prototype instructions",
					async () => {
						delete process.env.PDPP_EXPERIMENTAL_RECORD_UPDATES;
						await write({
							...snapshot(),
							data: { id: "a", required: "legacy rewrite" },
							type: "RECORD",
						});
						assert.equal(
							(await read("events")).data.required,
							"legacy rewrite",
						);
						const extendedSnapshot = {
							...snapshot(),
							data: { id: "a", required: "legacy snapshot with extensions" },
							type: "RECORD",
							set: { required: "must remain an ignored extension" },
							remove: ["required"],
						};
						assert.doesNotThrow(() =>
							assertValidRecordEnvelope(extendedSnapshot),
						);
						assert.equal((await write(extendedSnapshot)).accepted, true);
						assert.equal(
							(await read("events")).data.required,
							"legacy snapshot with extensions",
							"flag-off RECORD extensions must not be treated as partial instructions",
						);
						await assert.rejects(write(instruction({ optional: "disabled" })), {
							code: "invalid_partial_update",
						});
					},
				);
			} finally {
				setClientEventEnqueueHook(null);
				closeDb();
				await closePostgresStorage();
				delete process.env.PDPP_EXPERIMENTAL_RECORD_UPDATES;
			}
		}
		if (backend === "postgres") {
			await withTemporaryPostgresDatabase(
				{
					closeConnections: closePostgresStorage,
					connectionString: postgresUrl ?? "",
					databaseName: `pdpp_test_record_updates_${Date.now().toString(36)}`,
				},
				run,
			);
		} else {
			await run();
		}
	});
}
test("experimental append_only rejects changed duplicate without rewriting", async () => {
	setup();
	try {
		await ingestRecord(target, snapshot(), { deferIndexes: true });
		const before = rows();
		await assert.rejects(
			ingestRecord(
				target,
				snapshot("events", {
					id: "a",
					nested: { a: 1, b: 2 },
					required: "changed",
				}),
				{
					deferIndexes: true,
				},
			),
			{ code: "append_only_record_conflict" },
		);
		assert.deepEqual(rows(), before);
	} finally {
		closeDb();
		delete process.env.PDPP_EXPERIMENTAL_RECORD_UPDATES;
	}
});
test("experimental SQLite JSON equality ignores nested member order", async () => {
	setup();
	try {
		await ingestRecord(target, snapshot(), { deferIndexes: true });
		const before = rows();
		const result = await ingestRecord(
			target,
			{
				...snapshot(),
				data: {
					id: "a",
					nested: JSON.parse('{"b":2,"a":1}'),
					required: "value",
				},
				emitted_at: "2026-10-02T00:00:00Z",
			},
			{ deferIndexes: true },
		);
		assert.equal(result.changed, false);
		assert.deepEqual(rows(), before);
	} finally {
		closeDb();
		delete process.env.PDPP_EXPERIMENTAL_RECORD_UPDATES;
	}
});

test("flag-off SQLite retries do not parse current snapshots for disabled duplicate handling", async (t) => {
	setup();
	delete process.env.PDPP_EXPERIMENTAL_RECORD_UPDATES;
	try {
		const data = { id: "a", required: "unique-disabled-parse-probe" };
		const record = { data, key: "a", stream: "events" };
		await ingestRecord(target, record, { deferIndexes: true });
		const storedJson = getDb()
			.prepare("SELECT record_json FROM records WHERE stream = 'events'")
			.get()?.record_json;
		let calls = 0;
		const parse = JSON.parse;
		t.mock.method(
			JSON,
			"parse",
			(value: string, reviver?: Parameters<typeof JSON.parse>[1]) => {
				if (value === storedJson) calls += 1;
				return parse(value, reviver);
			},
		);
		assert.equal(
			(await ingestRecord(target, record, { deferIndexes: true })).changed,
			false,
		);
		assert.equal(
			calls,
			0,
			"flag-off duplicate handling must retain the legacy string comparison",
		);
	} finally {
		t.mock.restoreAll();
		closeDb();
		delete process.env.PDPP_EXPERIMENTAL_RECORD_UPDATES;
	}
});

test("retained bootstrap state binds tokens and pages to context and storage lifecycle", (t) => {
	bumpStorageGeneration();
	const token = Buffer.from(JSON.stringify({ v: 2 })).toString("base64url");
	const records = ["a", "b"].map((id) => ({
		record: { id, data: { id } },
		eligibility: { id },
	}));
	const result = startBootstrapPage({
		context: "authorized",
		records,
		changesCursor: token,
		limit: 1,
	});
	assert.equal(result.has_more, true);
	assert.equal(result.next_changes_since, undefined);
	assert.ok(result.next_cursor);
	const cursor = JSON.parse(
		Buffer.from(result.next_cursor, "base64url").toString(),
	);
	assert.throws(() => continueBootstrapPage(cursor, "different-grant", 1), {
		code: "invalid_cursor",
	});
	const terminal = continueBootstrapPage<{ id: string; data: { id: string } }>(
		cursor,
		"authorized",
		1,
	);
	assert.deepEqual(terminal.data, [{ id: "b", data: { id: "b" } }]);
	assert.ok(terminal.next_changes_since);
	const terminalToken = terminal.next_changes_since;
	assert.deepEqual(
		retainedBootstrapRecordIds(terminal.next_changes_since, "authorized"),
		["a", "b"],
	);
	const forged = JSON.parse(
		Buffer.from(terminal.next_changes_since, "base64url").toString(),
	);
	forged.v = 3;
	assert.throws(
		() =>
			retainedBootstrapRecordIds(
				Buffer.from(JSON.stringify(forged)).toString("base64url"),
				"authorized",
			),
		{ code: "invalid_cursor" },
	);
	assert.throws(
		() => retainedBootstrapRecordIds(terminalToken, "different-grant"),
		{ code: "invalid_cursor" },
	);
	const originalNow = Date.now();
	t.mock.method(Date, "now", () => originalNow + 5 * 60 * 1000 + 1);
	assert.throws(() => retainedBootstrapRecordIds(terminalToken, "authorized"), {
		code: "cursor_expired",
	});
	t.mock.restoreAll();
	const restarted = startBootstrapPage({
		context: "authorized",
		records,
		changesCursor: token,
		limit: 10,
	});
	assert.ok(restarted.next_changes_since);
	const restartedToken = restarted.next_changes_since;
	bumpStorageGeneration();
	assert.throws(
		() => retainedBootstrapRecordIds(restartedToken, "authorized"),
		{ code: "cursor_expired" },
	);
});

test("retained bootstrap capacity rejects complete captures and counts terminal baselines", () => {
	bumpStorageGeneration();
	const changesCursor = Buffer.from(JSON.stringify({ v: 1 })).toString(
		"base64url",
	);
	const capture = (
		records: Array<{
			record: { id: string; value?: string };
			eligibility: unknown;
		}>,
	) =>
		startBootstrapPage({
			context: "capacity",
			records,
			changesCursor,
			limit: 100,
		});
	assert.throws(
		() =>
			capture(
				Array.from({ length: BOOTSTRAP_MAX_RECORDS + 1 }, (_, i) => ({
					record: { id: String(i) },
					eligibility: { id: String(i) },
				})),
			),
		{ code: "bootstrap_capacity_exceeded" },
	);
	assert.throws(
		() =>
			capture([
				{
					record: { id: "large", value: "x".repeat(33 * 1024 * 1024) },
					eligibility: { id: "large" },
				},
			]),
		{ code: "bootstrap_capacity_exceeded" },
	);
	let last: ReturnType<typeof capture> | undefined;
	for (let i = 0; i < 32; i++)
		last = capture([
			{ record: { id: "retained" }, eligibility: { id: "retained" } },
		]);
	assert.ok(last?.next_changes_since);
	assert.throws(() => capture([]), { code: "bootstrap_capacity_exceeded" });
	assert.deepEqual(
		retainedBootstrapRecordIds(last.next_changes_since, "capacity"),
		["retained"],
	);
	bumpStorageGeneration();
	assert.deepEqual(capture([]).data, []);
	bumpStorageGeneration();
});
