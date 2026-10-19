// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { initDb } from "../server/db.ts";

function schemaObjects(db: ReturnType<typeof initDb>) {
	return db
		.prepare(
			"SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name, tbl_name, sql",
		)
		.all();
}

function tableContents(db: ReturnType<typeof initDb>) {
	const tableNames = db
		.prepare(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
		)
		.all<{ name: string }>();

	return tableNames.map(({ name }) => {
		const table = `"${name.replaceAll('"', '""')}"`;
		const count = db
			.prepare(`SELECT COUNT(*) AS count FROM ${table}`)
			.get<{ count: number }>()?.count;
		const rows = db.prepare(`SELECT * FROM ${table}`).all();
		rows.sort((left, right) =>
			JSON.stringify(left).localeCompare(JSON.stringify(right)),
		);
		return { name, count, rows };
	});
}

test("new file databases restore the snapshot and reopen as normal SQLite files", () => {
	const directory = mkdtempSync(
		join(homedir(), ".tmp/testeng/dcri/initdb/file-snapshot-"),
	);
	const path = join(directory, "pdpp.sqlite");
	const initialPath = join(directory, "initial.sqlite");
	const fresh = initDb(":memory:", { onSchemaMigration: () => undefined });
	let initial: ReturnType<typeof initDb> | undefined;
	let created: ReturnType<typeof initDb> | undefined;
	let reopened: ReturnType<typeof initDb> | undefined;

	try {
		initial = initDb(initialPath, { busyTimeoutMs: 1_234 });
		assert.deepEqual(schemaObjects(initial), schemaObjects(fresh));
		assert.equal(
			initial.pragma("user_version", { simple: true }),
			fresh.pragma("user_version", { simple: true }),
		);
		assert.deepEqual(tableContents(initial), tableContents(fresh));
		initial.close();
		initial = undefined;

		created = initDb(path, { busyTimeoutMs: 2_345 });

		assert.deepEqual(schemaObjects(created), schemaObjects(fresh));
		assert.equal(
			created.pragma("user_version", { simple: true }),
			fresh.pragma("user_version", { simple: true }),
		);
		assert.deepEqual(tableContents(created), tableContents(fresh));
		assert.equal(created.pragma("journal_mode", { simple: true }), "wal");
		assert.equal(created.pragma("synchronous", { simple: true }), 1);
		assert.equal(created.pragma("temp_store", { simple: true }), 2);
		assert.equal(created.pragma("mmap_size", { simple: true }), 268_435_456);
		assert.equal(created.pragma("cache_size", { simple: true }), -65_536);
		assert.equal(created.pragma("foreign_keys", { simple: true }), 1);
		assert.equal(created.pragma("busy_timeout", { simple: true }), 2_345);
		created.exec("CREATE TABLE snapshot_existing_marker (value TEXT NOT NULL)");
		created
			.prepare("INSERT INTO snapshot_existing_marker (value) VALUES (?)")
			.run("preserved");
		created.close();
		created = undefined;

		reopened = initDb(path);
		assert.deepEqual(
			schemaObjects(reopened).filter(
				(object) => object.name !== "snapshot_existing_marker",
			),
			schemaObjects(fresh),
		);
		assert.equal(
			reopened
				.prepare("SELECT value FROM snapshot_existing_marker")
				.get<{ value: string }>()?.value,
			"preserved",
		);
		assert.equal(reopened.pragma("journal_mode", { simple: true }), "wal");
		assert.equal(reopened.pragma("foreign_keys", { simple: true }), 1);
		if (reopened.vectorIndexKind === "sqlite-vec") {
			assert.equal(
				typeof reopened
					.prepare("SELECT vec_version() AS version")
					.get<{ version: string }>()?.version,
				"string",
			);
		}
	} finally {
		reopened?.close();
		created?.close();
		initial?.close();
		fresh.close();
		rmSync(directory, { force: true, recursive: true });
	}
});

test("snapshot-restored in-memory databases preserve content and connection state", () => {
	// Options bypass the snapshot so this handle exercises the ordinary schema
	// build path even if a prior test has already warmed the process cache.
	const fresh = initDb(":memory:", { onSchemaMigration: () => undefined });
	let snapshotSource: ReturnType<typeof initDb> | undefined;
	let restored: ReturnType<typeof initDb> | undefined;

	try {
		snapshotSource = initDb(":memory:");
		restored = initDb(":memory:", { busyTimeoutMs: 1_234 });

		assert.deepEqual(schemaObjects(restored), schemaObjects(fresh));
		assert.equal(
			restored.pragma("user_version", { simple: true }),
			fresh.pragma("user_version", { simple: true }),
		);
		assert.deepEqual(tableContents(restored), tableContents(fresh));

		assert.equal(restored.pragma("foreign_keys", { simple: true }), 1);
		assert.equal(
			restored.pragma("foreign_keys", { simple: true }),
			fresh.pragma("foreign_keys", { simple: true }),
		);
		assert.equal(restored.pragma("busy_timeout", { simple: true }), 1_234);
		assert.equal(restored.vectorIndexKind, fresh.vectorIndexKind);
		if (restored.vectorIndexKind === "sqlite-vec") {
			assert.equal(
				typeof restored
					.prepare("SELECT vec_version() AS version")
					.get<{ version: string }>()?.version,
				"string",
			);
		}
	} finally {
		restored?.close();
		snapshotSource?.close();
		fresh.close();
	}
});

// The snapshot is a test-run optimisation only: outside the RI runner
// (PDPP_TEST_PROFILE unset, as in production) every open builds the schema.
test("the schema snapshot is used only in test runs", () => {
	const dbModule = join(dirname(fileURLToPath(import.meta.url)), "..", "server", "db.ts");
	const probe = `
		const m = await import(${JSON.stringify(dbModule)});
		m.initDb(":memory:"); m.closeDb?.();
		m.initDb(":memory:"); m.closeDb?.();
		process.stdout.write(String(m.sqliteSchemaSnapshotRestoreCountForTests()));
	`;
	const restores = (profile: string | undefined) =>
		execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", probe], {
			encoding: "utf8",
			env: { ...process.env, NODE_TEST_CONTEXT: undefined, PDPP_TEST_PROFILE: profile },
		}).trim();
	assert.equal(restores(undefined), "0", "without PDPP_TEST_PROFILE no database comes from a snapshot");
	assert.equal(restores("memory-default"), "1", "in a test run the second open comes from the snapshot");
});
