// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
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
