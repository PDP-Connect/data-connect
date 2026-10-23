// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { closeDb, initDb } from "../server/db.ts";
import { issueCollectionRunSequence } from "../server/stores/collection-revision-store.ts";
import { createSqliteConnectorStateStore } from "../server/stores/connector-state-store.ts";
import Database from "./helpers/sqlite-driver.ts";

const CONNECTOR_INSTANCE_ID = "cin_collection_revision_migration";

function tempDatabase(): { directory: string; path: string } {
	const directory = fs.mkdtempSync(
		path.join(os.tmpdir(), "pdpp-collection-revision-migration-"),
	);
	return { directory, path: path.join(directory, "pdpp.sqlite") };
}

function createLegacyConnectorTables(
	raw: Database.Database,
	statusValues: string,
): void {
	raw.exec(`
    CREATE TABLE connectors (
      connector_id TEXT PRIMARY KEY,
      manifest TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE connector_instances (
      connector_instance_id TEXT PRIMARY KEY,
      owner_subject_id      TEXT NOT NULL,
      connector_id          TEXT NOT NULL,
      display_name          TEXT NOT NULL,
      status                TEXT NOT NULL DEFAULT 'active' CHECK (status IN ${statusValues}),
      source_kind           TEXT NOT NULL CHECK (source_kind IN ('account', 'local_device', 'browser_collector', 'manual')),
      source_binding_key    TEXT NOT NULL,
      source_binding_json   TEXT NOT NULL DEFAULT '{}',
      created_at            TEXT NOT NULL,
      updated_at            TEXT NOT NULL,
      revoked_at            TEXT,
      UNIQUE(owner_subject_id, connector_id, source_kind, source_binding_key),
      FOREIGN KEY(connector_id) REFERENCES connectors(connector_id) ON DELETE RESTRICT
    );
    INSERT INTO connectors VALUES ('gmail', '{}', '2026-10-22');
    INSERT INTO connector_instances(
      connector_instance_id, owner_subject_id, connector_id, display_name,
      status, source_kind, source_binding_key, source_binding_json,
      created_at, updated_at, revoked_at
    ) VALUES (
      '${CONNECTOR_INSTANCE_ID}', 'owner_1', 'gmail', 'Gmail',
      'active', 'account', 'binding_1', '{}', '2026-10-22', '2026-10-22', NULL
    );
  `);
}

function tableColumns(db: ReturnType<typeof initDb>, table: string): string[] {
	return db
		.prepare(`PRAGMA table_info(${table})`)
		.all()
		.map((column) => column.name as string);
}

function foreignKeyTables(
	db: ReturnType<typeof initDb>,
	table: string,
): string[] {
	return (
		db.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<{
			table: string;
		}>
	).map((foreignKey) => foreignKey.table);
}

function revisionSchema(db: ReturnType<typeof initDb>) {
	const sequenceTable = db
		.prepare(
			"SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'collection_run_sequences'",
		)
		.get();
	return {
		connectorInstanceColumns: tableColumns(db, "connector_instances"),
		connectorStateColumns: tableColumns(db, "connector_state"),
		sequenceTable,
		sequenceForeignKeys: db
			.prepare("PRAGMA foreign_key_list(collection_run_sequences)")
			.all(),
	};
}

function assertRevisionColumns(db: ReturnType<typeof initDb>): void {
	const connectorInstanceColumns = new Set(
		tableColumns(db, "connector_instances"),
	);
	for (const column of [
		"collection_revision",
		"collection_revision_event",
		"collection_revision_run_id",
		"collection_revision_at",
		"run_sequence_issued",
		"storage_epoch",
		"run_order_sequence",
		"run_order_event",
		"run_order_run_id",
		"run_order_revision",
	]) {
		assert.ok(
			connectorInstanceColumns.has(column),
			`connector_instances has ${column}`,
		);
	}
	assert.ok(
		tableColumns(db, "connector_state").includes("collection_revision"),
	);
	assert.deepEqual(foreignKeyTables(db, "collection_run_sequences"), [
		"connector_instances",
	]);
}

function seedLegacyNarrowStatusDatabase(dbPath: string): void {
	const raw = new Database(dbPath);
	try {
		raw.pragma("foreign_keys = OFF");
		createLegacyConnectorTables(raw, "('active', 'paused', 'revoked')");
	} finally {
		raw.close();
	}
}

function seedBrokenOrderDatabase(dbPath: string): void {
	const raw = new Database(dbPath);
	try {
		raw.pragma("foreign_keys = OFF");
		createLegacyConnectorTables(
			raw,
			"('active', 'paused', 'revoked', 'draft')",
		);
		raw.exec(`
      CREATE TABLE collection_run_sequences (
        connector_instance_id TEXT NOT NULL
          REFERENCES connector_instances_old_status_draft(connector_instance_id) ON DELETE CASCADE,
        run_id TEXT NOT NULL,
        run_sequence INTEGER NOT NULL,
        storage_epoch INTEGER NOT NULL,
        device_id TEXT NOT NULL,
        source_instance_id TEXT NOT NULL,
        issued_at TEXT NOT NULL,
        PRIMARY KEY (connector_instance_id, run_id)
      );
      INSERT INTO collection_run_sequences(
        connector_instance_id, run_id, run_sequence, storage_epoch,
        device_id, source_instance_id, issued_at
      ) VALUES (
        '${CONNECTOR_INSTANCE_ID}', 'run_preserved', 7, 1,
        'device_1', 'source_1', '2026-10-22T12:00:00.000Z'
      );
    `);
	} finally {
		raw.close();
	}
}

function insertFreshConnection(db: ReturnType<typeof initDb>): void {
	db.prepare(
		"INSERT INTO connectors(connector_id, manifest, created_at) VALUES ('gmail', '{}', '2026-10-22')",
	).run();
	db.prepare(
		`INSERT INTO connector_instances(
       connector_instance_id, owner_subject_id, connector_id, display_name,
       status, source_kind, source_binding_key, source_binding_json,
       created_at, updated_at, revoked_at
     ) VALUES (?, 'owner_1', 'gmail', 'Gmail', 'active', 'account', 'binding_1', '{}', '2026-10-22', '2026-10-22', NULL)`,
	).run(CONNECTOR_INSTANCE_ID);
}

async function writeOwnerState() {
	return await createSqliteConnectorStateStore().putState(
		{ connectorId: "gmail", connectorInstanceId: CONNECTOR_INSTANCE_ID },
		{ messages: { cursor: "after-1" } },
	);
}

test("legacy status rebuild creates collection revisions after connector_instances and keeps both writes usable", async () => {
	const { directory, path: dbPath } = tempDatabase();
	try {
		seedLegacyNarrowStatusDatabase(dbPath);
		const db = initDb(dbPath);
		const errors: string[] = [];
		let state: Awaited<ReturnType<typeof writeOwnerState>> | undefined;
		let runStart:
			| Awaited<ReturnType<typeof issueCollectionRunSequence>>
			| undefined;
		try {
			try {
				state = await writeOwnerState();
			} catch (error) {
				errors.push(
					`owner-scoped state write: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			try {
				runStart = await issueCollectionRunSequence({
					connectorInstanceId: CONNECTOR_INSTANCE_ID,
					deviceId: "device_1",
					runId: "run_after_migration",
					sourceInstanceId: "source_1",
				});
			} catch (error) {
				errors.push(
					`run-start registration: ${error instanceof Error ? error.message : String(error)}`,
				);
			}

			assert.deepEqual(errors, [], errors.join("; "));
			assertRevisionColumns(db);
			assert.deepEqual(state?.state, { messages: { cursor: "after-1" } });
			assert.equal(state?.updated_at !== null, true);
			assert.equal(runStart?.issued.runSequence, 1);
			assert.equal(runStart?.issued.storageEpoch, 1);
		} finally {
			closeDb();
		}
	} finally {
		fs.rmSync(directory, { force: true, recursive: true });
	}
});

test("a previously misdirected run-sequence foreign key is repaired without losing rows", () => {
	const { directory, path: dbPath } = tempDatabase();
	try {
		seedBrokenOrderDatabase(dbPath);
		const db = initDb(dbPath);
		try {
			assertRevisionColumns(db);
			assert.deepEqual(
				db
					.prepare("SELECT * FROM collection_run_sequences ORDER BY run_id")
					.all(),
				[
					{
						connector_instance_id: CONNECTOR_INSTANCE_ID,
						run_id: "run_preserved",
						run_sequence: 7,
						storage_epoch: 1,
						device_id: "device_1",
						source_instance_id: "source_1",
						issued_at: "2026-10-22T12:00:00.000Z",
					},
				],
			);
			assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
		} finally {
			closeDb();
		}
	} finally {
		fs.rmSync(directory, { force: true, recursive: true });
	}
});

test("fresh collection revision schema and data stay unchanged on a second boot", async () => {
	const { directory, path: dbPath } = tempDatabase();
	const onSchemaMigration = () => undefined;
	try {
		const first = initDb(dbPath, { onSchemaMigration });
		let schema: ReturnType<typeof revisionSchema>;
		let stateRows: unknown[];
		let sequenceRows: unknown[];
		try {
			schema = revisionSchema(first);
			assertRevisionColumns(first);
			insertFreshConnection(first);
			const state = await writeOwnerState();
			assert.deepEqual(state.state, { messages: { cursor: "after-1" } });
			await issueCollectionRunSequence({
				connectorInstanceId: CONNECTOR_INSTANCE_ID,
				deviceId: "device_1",
				runId: "run_fresh",
				sourceInstanceId: "source_1",
			});
			stateRows = first
				.prepare("SELECT * FROM connector_state ORDER BY stream")
				.all();
			sequenceRows = first
				.prepare("SELECT * FROM collection_run_sequences ORDER BY run_id")
				.all();
			assert.deepEqual(first.prepare("PRAGMA foreign_key_check").all(), []);
		} finally {
			closeDb();
		}

		const second = initDb(dbPath, { onSchemaMigration });
		try {
			assert.deepEqual(revisionSchema(second), schema);
			assert.deepEqual(
				second.prepare("SELECT * FROM connector_state ORDER BY stream").all(),
				stateRows,
			);
			assert.deepEqual(
				second
					.prepare("SELECT * FROM collection_run_sequences ORDER BY run_id")
					.all(),
				sequenceRows,
			);
			assert.deepEqual(second.prepare("PRAGMA foreign_key_check").all(), []);
		} finally {
			closeDb();
		}
	} finally {
		fs.rmSync(directory, { force: true, recursive: true });
	}
});
