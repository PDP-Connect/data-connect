// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Pool } from "pg";
import type { getDb } from "../server/db.ts";
import {
	migratePostgresIssuanceCutover,
	migrateSqliteIssuanceCutover,
	postgresIssuanceProtection,
	sqliteIssuanceProtection,
} from "../server/issuance-cutover.ts";
import { SqliteDriver } from "../server/sqlite-driver.ts";

const SCHEMA = `CREATE TABLE tokens(token_id TEXT PRIMARY KEY, expires_at TEXT);
 CREATE TABLE oauth_refresh_tokens(refresh_token_hash TEXT PRIMARY KEY, family_id TEXT, expires_at TEXT);
 CREATE TABLE grants(grant_id TEXT PRIMARY KEY, expires_at TEXT);
 CREATE TABLE grant_packages(package_id TEXT PRIMARY KEY);
 INSERT INTO tokens VALUES ('old-null', NULL), ('old-finite', '2030-01-01T00:00:00.123Z');
 INSERT INTO oauth_refresh_tokens VALUES ('old-refresh', 'old-family', NULL),
 ('old-finite-refresh-a', 'old-finite-family', '2030-01-01T00:00:00.123Z'),
 ('old-finite-refresh-b', 'old-finite-family', '2030-01-01T00:00:00.123Z');
 INSERT INTO grants VALUES ('old-grant', NULL), ('old-finite-grant', '2030-01-01T00:00:00.123Z');
 INSERT INTO grant_packages VALUES ('old-package');`;
const READ = "SELECT * FROM as_issuance_cohort ORDER BY kind, row_id";
const INCOMPLETE_CUTOVER_ERROR = /incomplete/;
const SQLITE_CHECK_CONSTRAINT_ERROR = /CHECK/;
const POSTGRES_CHECK_CONSTRAINT_ERROR = /check constraint/;
const SOURCE_ROWS = `SELECT 'token' AS kind, token_id AS row_id, expires_at FROM tokens
 UNION ALL SELECT 'refresh', refresh_token_hash, expires_at FROM oauth_refresh_tokens
 UNION ALL SELECT 'grant', grant_id, expires_at FROM grants
 UNION ALL SELECT 'package', package_id, NULL FROM grant_packages ORDER BY kind, row_id`;
const EXPECTED_PROTECTION = [
	["token", "old-null", null],
	["refresh", "old-refresh", null],
	["family", "old-family", null],
	["grant", "old-grant", null],
	["token", "old-finite", "2030-01-01T00:00:00.123Z"],
	["refresh", "old-finite-refresh-a", "2030-01-01T00:00:00.123Z"],
	["refresh", "old-finite-refresh-b", "2030-01-01T00:00:00.123Z"],
	["family", "old-finite-family", "2030-01-01T00:00:00.123Z"],
	["grant", "old-finite-grant", "2030-01-01T00:00:00.123Z"],
] as const;

test("SQLite cutover: exact provenance, rollback, partial state, concurrent startup", async () => {
	const dir = mkdtempSync(join(tmpdir(), "issuance-cutover-"));
	const path = join(dir, "db.sqlite");
	const db = new SqliteDriver(path, {
		timeout: 30_000,
	}) as unknown as ReturnType<typeof getDb>;
	try {
		db.pragma("busy_timeout = 30000");
		const fresh = new SqliteDriver(":memory:", {
			timeout: 30_000,
		}) as unknown as ReturnType<typeof getDb>;
		try {
			fresh.exec(SCHEMA.slice(0, SCHEMA.indexOf("INSERT INTO")));
			migrateSqliteIssuanceCutover(fresh);
			assert.equal(fresh.prepare(READ).all().length, 0);
			fresh.exec("INSERT INTO tokens VALUES ('new-null', NULL)");
			migrateSqliteIssuanceCutover(fresh);
			assert.equal(
				sqliteIssuanceProtection(fresh, "token", "new-null"),
				undefined,
			);
		} finally {
			fresh.close();
		}
		db.exec(SCHEMA);
		// Conflicting historical family expiry must fail atomically, never guess.
		db.exec(
			"INSERT INTO oauth_refresh_tokens VALUES ('conflict', 'old-family', '2030-01-01T00:00:00.123Z')",
		);
		const sourceBeforeFailure = db.prepare(SOURCE_ROWS).all();
		assert.throws(() => migrateSqliteIssuanceCutover(db));
		assert.deepEqual(db.prepare(SOURCE_ROWS).all(), sourceBeforeFailure);
		assert.equal(
			db
				.prepare(
					"SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'as_issuance_%'",
				)
				.get()?.n,
			0,
		);
		assert.equal(
			db
				.prepare("SELECT expires_at FROM tokens WHERE token_id = 'old-null'")
				.get()?.expires_at,
			null,
		);
		db.exec(
			"DELETE FROM oauth_refresh_tokens WHERE refresh_token_hash = 'conflict'",
		);
		const sourceBefore = db.prepare(SOURCE_ROWS).all();
		const source = `import {SqliteDriver} from ${JSON.stringify(new URL("../server/sqlite-driver.ts", import.meta.url).href)}; import {migrateSqliteIssuanceCutover} from ${JSON.stringify(new URL("../server/issuance-cutover.ts", import.meta.url).href)}; const db = new SqliteDriver(${JSON.stringify(path)}); db.pragma('busy_timeout = 30000'); migrateSqliteIssuanceCutover(db); db.close();`;
		await Promise.all(
			Array.from(
				{ length: 4 },
				() =>
					new Promise<void>((resolve, reject) => {
						const child = spawn(
							process.execPath,
							["--import", "tsx", "--input-type=module", "-e", source],
							{
								stdio: "pipe",
							},
						);
						let error = "";
						child.stderr.on("data", (chunk) => {
							error += chunk;
						});
						child.on("error", reject);
						child.on("exit", (code) =>
							code === 0 ? resolve() : reject(new Error(error)),
						);
					}),
			),
		);
		const before = db.prepare(READ).all();
		assert.equal(before.length, 10);
		assert.deepEqual(db.prepare(SOURCE_ROWS).all(), sourceBefore);
		assert.deepEqual(
			EXPECTED_PROTECTION.map(([kind, id]) =>
				sqliteIssuanceProtection(db, kind, id),
			),
			EXPECTED_PROTECTION.map(([, , expires]) => ({
				original_expires_at: expires,
			})),
		);
		assert.throws(
			() =>
				db.exec(
					"INSERT INTO as_issuance_cutover VALUES ('client_claimed_legacy', 'now')",
				),
			SQLITE_CHECK_CONSTRAINT_ERROR,
		);
		assert.deepEqual(sqliteIssuanceProtection(db, "token", "old-null"), {
			original_expires_at: null,
		});
		assert.equal(
			sqliteIssuanceProtection(db, "family", "old-null"),
			undefined,
			"wrong kind is not authority",
		);
		assert.equal(
			sqliteIssuanceProtection(db, "token", "foreign"),
			undefined,
			"foreign ID is not authority",
		);
		db.exec(`INSERT INTO tokens VALUES ('new-null', NULL); INSERT INTO grants VALUES ('new-grant', NULL);
      INSERT INTO oauth_refresh_tokens VALUES ('new-refresh', 'new-family', NULL);
      INSERT INTO grant_packages VALUES ('new-package')`);
		migrateSqliteIssuanceCutover(db);
		assert.deepEqual(db.prepare(READ).all(), before);
		assert.equal(sqliteIssuanceProtection(db, "token", "new-null"), undefined);
		assert.equal(
			sqliteIssuanceProtection(db, "refresh", "new-refresh"),
			undefined,
		);
		assert.equal(
			sqliteIssuanceProtection(db, "family", "new-family"),
			undefined,
		);
		assert.equal(sqliteIssuanceProtection(db, "grant", "new-grant"), undefined);
		assert.equal(
			sqliteIssuanceProtection(db, "package", "new-package"),
			undefined,
		);
		db.exec("DELETE FROM as_issuance_cohort; DELETE FROM as_issuance_cutover");
		assert.throws(
			() => migrateSqliteIssuanceCutover(db),
			INCOMPLETE_CUTOVER_ERROR,
		);
		assert.throws(
			() => sqliteIssuanceProtection(db, "token", "new-null"),
			INCOMPLETE_CUTOVER_ERROR,
		);
		db.exec("DROP TABLE as_issuance_cohort");
		assert.throws(
			() => migrateSqliteIssuanceCutover(db),
			INCOMPLETE_CUTOVER_ERROR,
		);
	} finally {
		db.close();
		rmSync(dir, { force: true, recursive: true });
	}
});

test("PostgreSQL cutover: exact provenance, rollback, partial state, concurrent startup", {
	skip: !process.env.PDPP_TEST_POSTGRES_URL,
}, async () => {
	const pool = new Pool({
		connectionString: process.env.PDPP_TEST_POSTGRES_URL,
	});
	const client = await pool.connect();
	try {
		await client.query(SCHEMA);
		await client.query(
			"INSERT INTO oauth_refresh_tokens VALUES ('conflict', 'old-family', '2030-01-01T00:00:00.123Z')",
		);
		const sourceBeforeFailure = (await client.query(SOURCE_ROWS)).rows;
		await assert.rejects(migratePostgresIssuanceCutover(client));
		assert.deepEqual(
			(await client.query(SOURCE_ROWS)).rows,
			sourceBeforeFailure,
		);
		assert.equal(
			(
				await client.query(
					"SELECT count(*) AS n FROM pg_tables WHERE schemaname = current_schema() AND tablename LIKE 'as_issuance_%'",
				)
			).rows[0].n,
			"0",
		);
		await client.query(
			"DELETE FROM oauth_refresh_tokens WHERE refresh_token_hash = 'conflict'",
		);
		const sourceBefore = (await client.query(SOURCE_ROWS)).rows;
		await Promise.all(
			Array.from({ length: 4 }, async () => {
				const worker = await pool.connect();
				try {
					await migratePostgresIssuanceCutover(worker);
				} finally {
					worker.release();
				}
			}),
		);
		const before = (await client.query(READ)).rows;
		assert.equal(before.length, 10);
		assert.deepEqual((await client.query(SOURCE_ROWS)).rows, sourceBefore);
		assert.deepEqual(
			await Promise.all(
				EXPECTED_PROTECTION.map(([kind, id]) =>
					postgresIssuanceProtection(client, kind, id),
				),
			),
			EXPECTED_PROTECTION.map(([, , expires]) => ({
				original_expires_at: expires,
			})),
		);
		await assert.rejects(
			client.query(
				"INSERT INTO as_issuance_cutover VALUES ('client_claimed_legacy', 'now')",
			),
			POSTGRES_CHECK_CONSTRAINT_ERROR,
		);
		assert.deepEqual(
			await postgresIssuanceProtection(client, "token", "old-null"),
			{ original_expires_at: null },
		);
		assert.equal(
			await postgresIssuanceProtection(client, "family", "old-null"),
			undefined,
		);
		assert.equal(
			await postgresIssuanceProtection(client, "token", "foreign"),
			undefined,
		);
		await client.query(`INSERT INTO tokens VALUES ('new-null', NULL); INSERT INTO grants VALUES ('new-grant', NULL);
      INSERT INTO oauth_refresh_tokens VALUES ('new-refresh', 'new-family', NULL);
      INSERT INTO grant_packages VALUES ('new-package')`);
		await migratePostgresIssuanceCutover(client);
		assert.deepEqual((await client.query(READ)).rows, before);
		assert.equal(
			await postgresIssuanceProtection(client, "token", "new-null"),
			undefined,
		);
		assert.equal(
			await postgresIssuanceProtection(client, "refresh", "new-refresh"),
			undefined,
		);
		assert.equal(
			await postgresIssuanceProtection(client, "family", "new-family"),
			undefined,
		);
		assert.equal(
			await postgresIssuanceProtection(client, "grant", "new-grant"),
			undefined,
		);
		assert.equal(
			await postgresIssuanceProtection(client, "package", "new-package"),
			undefined,
		);
		await client.query(
			"DELETE FROM as_issuance_cohort; DELETE FROM as_issuance_cutover",
		);
		await assert.rejects(
			migratePostgresIssuanceCutover(client),
			INCOMPLETE_CUTOVER_ERROR,
		);
		await assert.rejects(
			postgresIssuanceProtection(client, "token", "new-null"),
			INCOMPLETE_CUTOVER_ERROR,
		);
		await client.query("DROP TABLE as_issuance_cohort");
		await assert.rejects(
			migratePostgresIssuanceCutover(client),
			INCOMPLETE_CUTOVER_ERROR,
		);
	} finally {
		client.release();
		await pool.end();
	}
});
