// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { closeDb, initDb } from "../server/db.ts";
import { postgresIngestRecord } from "../server/postgres-records.ts";
import {
	closePostgresStorage,
	initPostgresStorage,
	postgresQuery,
} from "../server/postgres-storage.ts";
import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts";

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;

test("PostgreSQL live history pruning retains the anchor for a cold current record", {
	skip: POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL unset",
}, async () => {
	assert.ok(POSTGRES_URL);
	const previousLimit = process.env.PDPP_CHANGE_HISTORY_LIMIT;
	process.env.PDPP_CHANGE_HISTORY_LIMIT = "2";
	try {
		await withTemporaryPostgresDatabase(
			{
				closeConnections: closePostgresStorage,
				connectionString: POSTGRES_URL,
				databaseName: `pdpp_test_record_anchor_prune_${Date.now().toString(36)}_${Math.random()
					.toString(16)
					.slice(2, 10)}`,
				templateName: null,
			},
			async (databaseUrl) => {
				initDb(":memory:");
				try {
					await initPostgresStorage({ backend: "postgres", databaseUrl });
					const storageTarget = {
						connectorId: "gap_anchor_prune",
						connectorInstanceId: "cin_gap_anchor_prune",
					};
					const ingest = (key: string, value: number) =>
						postgresIngestRecord(storageTarget, {
							data: { id: key, value },
							emitted_at: "2026-10-17T00:00:00.000Z",
							key,
							op: "upsert",
							stream: "items",
						});

					assert.equal((await ingest("cold", 1)).changed, true);
					for (let value = 2; value <= 5; value += 1) {
						assert.equal((await ingest("hot", value)).changed, true);
					}

					const anchor = await postgresQuery<{ version: number | string }>(
						`SELECT version FROM record_changes
                WHERE connector_instance_id = $1 AND stream = $2 AND record_key = $3`,
						[storageTarget.connectorInstanceId, "items", "cold"],
					);
					assert.deepEqual(
						anchor.rows.map((row) => Number(row.version)),
						[1],
					);
					const current = await postgresQuery<{ version: number | string }>(
						`SELECT version FROM records
                WHERE connector_instance_id = $1 AND stream = $2 AND record_key = $3 AND deleted = FALSE`,
						[storageTarget.connectorInstanceId, "items", "cold"],
					);
					assert.deepEqual(
						current.rows.map((row) => Number(row.version)),
						[1],
					);
				} finally {
					await closePostgresStorage();
					closeDb();
				}
			},
		);
	} finally {
		if (previousLimit === undefined)
			delete process.env.PDPP_CHANGE_HISTORY_LIMIT;
		else process.env.PDPP_CHANGE_HISTORY_LIMIT = previousLimit;
	}
});

test("SQLite pruning removes an expired tombstone but keeps a cold live anchor", () => {
	const query = (file: string) =>
		readFileSync(new URL(`../server/queries/records/ingest/${file}.sql`, import.meta.url), "utf8");
	const db = new DatabaseSync(":memory:");
	try {
		db.exec(`
			CREATE TABLE records (connector_instance_id TEXT, stream TEXT, record_key TEXT,
				version INTEGER, deleted INTEGER, deleted_at TEXT);
			CREATE TABLE record_changes (connector_instance_id TEXT, stream TEXT, record_key TEXT,
				version INTEGER);
			INSERT INTO records VALUES
				('test', 'items', 'live', 1, 0, NULL),
				('test', 'items', 'gone', 2, 0, NULL),
				('test', 'items', 'hot', 6, 0, NULL);
			INSERT INTO record_changes VALUES
				('test', 'items', 'live', 1), ('test', 'items', 'gone', 2),
				('test', 'items', 'gone', 3), ('test', 'items', 'hot', 4),
				('test', 'items', 'hot', 5), ('test', 'items', 'hot', 6);
		`);
		db.prepare(query("mark-record-deleted")).run(
			"2026-10-17T00:00:00.000Z", 3, "test", "items", "gone",
		);
		const tombstone = db.prepare("SELECT deleted, version FROM records WHERE record_key = 'gone'");
		assert.equal(tombstone.get()?.version, 3);
		assert.equal(tombstone.get()?.deleted, 1);

		const result = db.prepare(query("prune-record-changes")).run("test", "items", 6 - 2);
		const retained = db.prepare("SELECT record_key, version FROM record_changes ORDER BY version").all();
		assert.deepEqual(retained.map((row) => [row.record_key, row.version]), [
			["live", 1], ["hot", 5], ["hot", 6],
		]);
		assert.equal(result.changes, 3);
		assert.equal(tombstone.get()?.deleted, 1);
	} finally {
		db.close();
	}
});
