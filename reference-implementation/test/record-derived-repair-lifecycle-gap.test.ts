// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { closeDb, getDb, initDb } from "../server/db.ts";
import {
	listPendingRecordDerivedRepairs,
	runRecordDerivedRepairRound,
} from "../server/record-derived-repair.ts";
import { markRecordDerivedRepairPendingSqlite } from "../server/stores/record-derived-repair-store.ts";

test("missing SQLite manifest retains grouped debt; backoff and requeue recover", async () => {
	initDb(":memory:");
	try {
		const connectorId = "gap-missing-manifest";
		const scopes = ["cin_gap_a", "cin_gap_b"].map((connectorInstanceId) => ({
			connectorId,
			connectorInstanceId,
			stream: "items",
		}));
		const markedAt = "2026-01-01T00:00:00.000Z";
		for (const scope of scopes)
			markRecordDerivedRepairPendingSqlite(scope, markedAt);
		markRecordDerivedRepairPendingSqlite(
			{
				connectorId: "gap-other",
				connectorInstanceId: "cin_gap_other",
				stream: "items",
			},
			markedAt,
		);
		const rows = () =>
			getDb()
				.prepare(
					"SELECT * FROM record_derived_repair_pending WHERE connector_id = ? ORDER BY connector_instance_id",
				)
				.all<{
					job_id: string;
					attempts: number;
					next_attempt_at: string | null;
					last_error: string | null;
					after_record_key: string | null;
				}>(connectorId);
		const original = rows();
		const started = Date.now();
		const failed = await runRecordDerivedRepairRound({ connectorId });
		const ended = Date.now();
		assert.deepEqual(failed, {
			attempted: 2,
			completed: 0,
			failed: 2,
			incomplete: false,
		});
		const backedOff = rows();
		assert.equal(backedOff.length, 2);
		for (const [index, row] of backedOff.entries()) {
			assert.equal(row.job_id, original[index]?.job_id);
			assert.equal(row.attempts, 1);
			assert.match(row.last_error ?? "", /manifest is missing/);
			assert.ok(row.next_attempt_at);
			const due = Date.parse(row.next_attempt_at);
			assert.ok(due >= started + 30_000 && due <= ended + 30_000);
		}
		const dueTimes = backedOff.map((row) => {
			assert.ok(row.next_attempt_at);
			return Date.parse(row.next_attempt_at);
		});
		const earliest = Math.min(...dueTimes);
		assert.equal(
			(
				await listPendingRecordDerivedRepairs({
					connectorId,
					nowIso: new Date(earliest - 1).toISOString(),
				})
			).length,
			0,
		);
		const latest = Math.max(...dueTimes);
		assert.equal(
			(
				await listPendingRecordDerivedRepairs({
					connectorId,
					nowIso: new Date(latest).toISOString(),
				})
			).length,
			2,
		);

		getDb()
			.prepare(
				"UPDATE record_derived_repair_pending SET attempts = 20, next_attempt_at = NULL WHERE connector_id = ?",
			)
			.run(connectorId);
		const capStart = Date.now();
		const again = await runRecordDerivedRepairRound({ connectorId });
		const capEnd = Date.now();
		assert.equal(
			again.failed,
			2,
			"failure must release in-flight keys for another round",
		);
		for (const row of rows()) {
			assert.equal(row.attempts, 21);
			assert.ok(row.next_attempt_at);
			const due = Date.parse(row.next_attempt_at);
			assert.ok(due >= capStart + 3_600_000 && due <= capEnd + 3_600_000);
		}

		for (const scope of scopes)
			markRecordDerivedRepairPendingSqlite(scope, markedAt);
		for (const [index, row] of rows().entries()) {
			assert.notEqual(row.job_id, original[index]?.job_id);
			assert.equal(row.attempts, 0);
			assert.equal(row.next_attempt_at, null);
			assert.equal(row.last_error, null);
			assert.equal(row.after_record_key, null);
		}
		getDb()
			.prepare(
				"INSERT INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)",
			)
			.run(
				connectorId,
				JSON.stringify({ connector_id: connectorId, streams: [] }),
				markedAt,
			);
		const recovered = await runRecordDerivedRepairRound({ connectorId });
		assert.deepEqual(recovered, {
			attempted: 2,
			completed: 2,
			failed: 0,
			incomplete: false,
		});
		assert.equal(rows().length, 0);
		const other = getDb()
			.prepare(
				"SELECT attempts FROM record_derived_repair_pending WHERE connector_instance_id = ?",
			)
			.get<{ attempts: number }>("cin_gap_other");
		assert.equal(
			other?.attempts,
			0,
			"connector filter must leave unrelated debt untouched",
		);
	} finally {
		closeDb();
	}
});
