// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { registerConnector } from "../server/auth.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { ingestRecord } from "../server/records.ts";

function manifest(connectorId: string) {
	return {
		capabilities: { human_interaction: [] },
		connector_id: connectorId,
		display_name: connectorId,
		manifest_uri: `https://sources.example/${connectorId}`,
		protocol_version: "0.1.0",
		streams: [
			{
				name: "items",
				primary_key: ["id"],
				query: { search: { lexical_fields: ["subject"] } },
				schema: {
					properties: { id: { type: "string" }, subject: { type: "string" } },
					required: ["id", "subject"],
					type: "object",
				},
				selection: { fields: true, resources: true },
				semantics: "mutable_state",
			},
		],
		version: "0.1.0",
	};
}

async function setup(connectorId: string) {
	initDb(":memory:");
	await registerConnector(manifest(connectorId));
}

function ingest(connectorId: string) {
	return ingestRecord(
		{
			connector_id: connectorId,
			connector_instance_id: `${connectorId}-instance`,
		},
		{
			data: { id: "k1", subject: "one" },
			emitted_at: "2026-10-17T00:00:00.000Z",
			key: "k1",
			stream: "items",
		},
		{ deferIndexes: true },
	);
}

test("SQLite ingest rolls back the record and history if its dirty mark fails", async () => {
	initDb(":memory:");
	try {
		const connectorId = "gap-dirty-mark-rollback";
		await registerConnector(manifest(connectorId));
		getDb().exec(`
			CREATE TRIGGER reject_search_index_dirty_insert
			BEFORE INSERT ON search_index_dirty
			BEGIN
				SELECT RAISE(ABORT, 'reject dirty mark');
			END;
		`);

		await assert.rejects(ingest(connectorId), /reject dirty mark/);
		assert.equal(
			getDb().prepare("SELECT COUNT(*) AS count FROM records").get()?.count,
			0,
		);
		assert.equal(
			getDb().prepare("SELECT COUNT(*) AS count FROM record_changes").get()
				?.count,
			0,
		);
		assert.equal(
			getDb().prepare("SELECT COUNT(*) AS count FROM search_index_dirty").get()
				?.count,
			0,
		);
	} finally {
		closeDb();
	}
});

test("SQLite ingest persists both the record and dirty mark when the transaction succeeds", async () => {
	try {
		const connectorId = "gap-dirty-mark-commit";
		await setup(connectorId);
		const result = await ingest(connectorId);
		assert.equal(result.accepted, true);
		assert.equal(
			getDb().prepare("SELECT COUNT(*) AS count FROM records").get()?.count,
			1,
		);
		assert.equal(
			getDb().prepare("SELECT COUNT(*) AS count FROM record_changes").get()
				?.count,
			1,
		);
		assert.equal(
			getDb()
				.prepare(
					"SELECT COUNT(*) AS count FROM search_index_dirty WHERE dirty = 1",
				)
				.get()?.count,
			1,
		);
	} finally {
		closeDb();
	}
});
