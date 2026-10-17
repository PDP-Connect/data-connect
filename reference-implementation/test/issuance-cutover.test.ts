// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Pool, type PoolClient } from "pg";
import type { getDb } from "../server/db.ts";
import {
	migratePostgresIssuanceCutover,
	migrateSqliteIssuanceCutover,
	postgresIssuanceProtection,
	sqliteIssuanceProtection,
} from "../server/issuance-cutover.ts";
import { SqliteDriver } from "../server/sqlite-driver.ts";
import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts";

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
	skip: process.env.PDPP_TEST_POSTGRES_URL
		? false
		: "PDPP_TEST_POSTGRES_URL unset",
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

test("PostgreSQL cutover fences source writers and snapshots one issuance cohort", {
	skip: process.env.PDPP_TEST_POSTGRES_URL
		? false
		: "PDPP_TEST_POSTGRES_URL unset",
}, async () => {
	const connectionString = process.env.PDPP_TEST_POSTGRES_URL;
	assert.ok(connectionString);
	const databaseName = `ri394_${randomBytes(8).toString("hex")}`;
	let pool: Pool | undefined;
	await withTemporaryPostgresDatabase(
		{
			connectionString,
			databaseName,
			templateName: null,
			closeConnections: async () => pool?.end(),
		},
		async (databaseUrl) => {
			pool = new Pool({
				connectionString: databaseUrl,
				connectionTimeoutMillis: 5_000,
				statement_timeout: 15_000,
			});
			const setup = await pool.connect();
			try {
				await setup.query(`CREATE TABLE tokens(token_id TEXT PRIMARY KEY, expires_at TEXT);
          CREATE TABLE oauth_refresh_tokens(refresh_token_hash TEXT PRIMARY KEY, family_id TEXT, expires_at TEXT);
          CREATE TABLE grants(grant_id TEXT PRIMARY KEY, expires_at TEXT);
          CREATE TABLE grant_packages(package_id TEXT PRIMARY KEY);
          CREATE FUNCTION public.ri394_pause_cutover() RETURNS event_trigger LANGUAGE plpgsql AS $$
          BEGIN
            PERFORM pg_advisory_xact_lock(current_setting('ri394.pause_key')::bigint);
          END;
          $$;
          CREATE EVENT TRIGGER ri394_pause_cutover ON ddl_command_end
          WHEN TAG IN ('CREATE TABLE') EXECUTE FUNCTION public.ri394_pause_cutover();`);
				await setup.query(`BEGIN;
          INSERT INTO tokens VALUES ('before-token', NULL);
          INSERT INTO oauth_refresh_tokens VALUES ('before-refresh', 'before-family', NULL);
          INSERT INTO grants VALUES ('before-grant', NULL);
          INSERT INTO grant_packages VALUES ('before-package');
          COMMIT;`);
			} finally {
				setup.release();
			}

			const barrierKey = BigInt(
				`0x${randomBytes(7).toString("hex")}`,
			).toString();
			const probeWrites = [
				"INSERT INTO tokens VALUES ('probe-token', NULL)",
				"INSERT INTO oauth_refresh_tokens VALUES ('probe-refresh', 'probe-family', NULL)",
				"INSERT INTO grants VALUES ('probe-grant', NULL)",
				"INSERT INTO grant_packages VALUES ('probe-package')",
			];
			const probeIds = [
				["token", "probe-token"],
				["refresh", "probe-refresh"],
				["family", "probe-family"],
				["grant", "probe-grant"],
				["package", "probe-package"],
			] as const;
			const afterIds = [
				["token", "after-token"],
				["refresh", "after-refresh"],
				["family", "after-family"],
				["grant", "after-grant"],
				["package", "after-package"],
			] as const;
			let barrierHeld = false;
			let migrationPromise: Promise<void> | undefined;
			let linkedWriterForCleanup: PoolClient | undefined;
			const clients: PoolClient[] = [];
			const pendingWrites: Promise<unknown>[] = [];
			try {
				const barrier = await pool.connect();
				clients.push(barrier);
				const migration = await pool.connect();
				clients.push(migration);
				const observer = await pool.connect();
				clients.push(observer);
				const probes: PoolClient[] = [];
				for (let index = 0; index < 4; index += 1) {
					const probe = await pool.connect();
					probes.push(probe);
					clients.push(probe);
				}
				const linkedWriter = await pool.connect();
				clients.push(linkedWriter);
				linkedWriterForCleanup = linkedWriter;

				await barrier.query("SELECT pg_advisory_lock($1::bigint)", [
					barrierKey,
				]);
				barrierHeld = true;
				const migrationPid = Number(
					(await migration.query("SELECT pg_backend_pid() AS pid")).rows[0].pid,
				);
				await migration.query(
					"SELECT set_config('ri394.pause_key', $1, false)",
					[barrierKey],
				);
				migrationPromise = migratePostgresIssuanceCutover(migration);
				let migrationError: unknown;
				void migrationPromise.catch((error) => {
					migrationError = error;
				});

				await waitForPostgresState(
					"cutover to reach the test barrier before snapshot statements",
					async () => {
						if (migrationError) throw migrationError;
						const state = await observer.query(
							`SELECT a.wait_event_type,
                    EXISTS (SELECT 1 FROM pg_locks l WHERE l.pid = a.pid AND l.locktype = 'advisory' AND NOT l.granted) AS waiting_on_barrier
                   FROM pg_stat_activity a WHERE a.pid = $1`,
							[migrationPid],
						);
						return (
							state.rows[0]?.waiting_on_barrier === true &&
							state.rows[0]?.wait_event_type === "Lock"
						);
					},
				);

				const writeStates = probes.map((client, index) => {
					assert.ok(client);
					const write = probeWrites[index];
					assert.ok(write);
					let settled = false;
					let writeError: unknown;
					const pidPromise = client.query("SELECT pg_backend_pid() AS pid");
					const queryPromise = pidPromise.then(async ({ rows }) => {
						const pid = Number(rows[0].pid);
						try {
							const result = await client.query(write);
							settled = true;
							return { pid, result };
						} catch (error) {
							settled = true;
							writeError = error;
							throw error;
						}
					});
					void queryPromise.catch(() => undefined);
					pendingWrites.push(queryPromise);
					return {
						pidPromise,
						get settled() {
							return settled;
						},
						get writeError() {
							return writeError;
						},
					};
				});

				await waitForPostgresState(
					"each source-table writer to block on the cutover backend",
					async () => {
						const results = await Promise.all(
							writeStates.map(async (state) => {
								if (state.settled) {
									if (state.writeError) throw state.writeError;
									throw new Error(
										"a source writer completed before cutover released its lock",
									);
								}
								const { rows } = await state.pidPromise.then(
									({ rows: pidRows }) =>
										observer.query(
											`SELECT wait_event_type, pg_blocking_pids(pid) AS blockers
                       FROM pg_stat_activity WHERE pid = $1`,
											[pidRows[0].pid],
										),
									() => ({ rows: [] }),
								);
								return (
									rows[0]?.wait_event_type === "Lock" &&
									rows[0]?.blockers.includes(migrationPid)
								);
							}),
						);
						return results.every(Boolean);
					},
				);

				await linkedWriter.query("BEGIN");
				const linkedPid = Number(
					(await linkedWriter.query("SELECT pg_backend_pid() AS pid")).rows[0]
						.pid,
				);
				const linkedWrite = linkedWriter
					.query(`INSERT INTO tokens VALUES ('after-token', NULL);
              INSERT INTO oauth_refresh_tokens VALUES ('after-refresh', 'after-family', NULL);
              INSERT INTO grants VALUES ('after-grant', NULL);
              INSERT INTO grant_packages VALUES ('after-package');
              COMMIT`)
					.catch(async (error: unknown) => {
						await linkedWriter.query("ROLLBACK").catch(() => undefined);
						throw error;
					});
				void linkedWrite.catch(() => undefined);
				pendingWrites.push(linkedWrite);
				await waitForPostgresState(
					"the linked issuance writer to block on the cutover backend",
					async () => {
						const { rows } = await observer.query(
							`SELECT wait_event_type, pg_blocking_pids(pid) AS blockers
                   FROM pg_stat_activity WHERE pid = $1`,
							[linkedPid],
						);
						return (
							rows[0]?.wait_event_type === "Lock" &&
							rows[0]?.blockers.includes(migrationPid)
						);
					},
				);

				assert.equal(
					(
						await barrier.query(
							"SELECT pg_advisory_unlock($1::bigint) AS unlocked",
							[barrierKey],
						)
					).rows[0].unlocked,
					true,
				);
				barrierHeld = false;
				await migrationPromise;
				await Promise.all(pendingWrites);

				const cohort = (await observer.query(READ)).rows.map((row) => [
					row.kind,
					row.row_id,
				]);
				assert.deepEqual(cohort, [
					["family", "before-family"],
					["grant", "before-grant"],
					["package", "before-package"],
					["refresh", "before-refresh"],
					["token", "before-token"],
				]);
				for (const [kind, id] of [...probeIds, ...afterIds]) {
					assert.equal(
						cohort.some(
							([cohortKind, cohortId]) =>
								cohortKind === kind && cohortId === id,
						),
						false,
						`${kind} ${id} was issued after cutover began and must stay outside its cohort`,
					);
				}
				assert.deepEqual(
					(await observer.query(SOURCE_ROWS)).rows.map((row) => [
						row.kind,
						row.row_id,
					]),
					[
						["grant", "after-grant"],
						["grant", "before-grant"],
						["grant", "probe-grant"],
						["package", "after-package"],
						["package", "before-package"],
						["package", "probe-package"],
						["refresh", "after-refresh"],
						["refresh", "before-refresh"],
						["refresh", "probe-refresh"],
						["token", "after-token"],
						["token", "before-token"],
						["token", "probe-token"],
					],
				);
				assert.deepEqual(
					(
						await observer.query(
							"SELECT family_id FROM oauth_refresh_tokens WHERE family_id IS NOT NULL ORDER BY family_id",
						)
					).rows.map((row) => row.family_id),
					["after-family", "before-family", "probe-family"],
				);
			} finally {
				if (barrierHeld) {
					await clients[0]
						?.query("SELECT pg_advisory_unlock($1::bigint)", [barrierKey])
						.catch(() => undefined);
				}
				if (migrationPromise) await migrationPromise.catch(() => undefined);
				await Promise.all(
					pendingWrites.map((write) => write.catch(() => undefined)),
				);
				await linkedWriterForCleanup?.query("ROLLBACK").catch(() => undefined);
				for (const client of clients) client.release();
			}
		},
	);
});

async function waitForPostgresState(
	description: string,
	probe: () => Promise<boolean>,
): Promise<void> {
	const deadline = Date.now() + 8_000;
	while (Date.now() < deadline) {
		if (await probe()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`timed out waiting for PostgreSQL state: ${description}`);
}
