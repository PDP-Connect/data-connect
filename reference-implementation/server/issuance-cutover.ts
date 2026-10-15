// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/** Server-owned issuance provenance. Resource compatibility is deliberately separate. */
export const ISSUANCE_CUTOVER_VERSION = "legacy_expiry_v1";
const TABLES = ["as_issuance_cutover", "as_issuance_cohort"];
const DDL = `
 CREATE TABLE as_issuance_cutover (
   version TEXT PRIMARY KEY CHECK (version = 'legacy_expiry_v1'),
   completed_at TEXT NOT NULL
 );
 CREATE TABLE as_issuance_cohort (
   kind TEXT NOT NULL CHECK (kind IN ('token', 'refresh', 'family', 'grant', 'package')),
   row_id TEXT NOT NULL,
   version TEXT NOT NULL REFERENCES as_issuance_cutover(version),
   original_expires_at TEXT,
   enrollment TEXT NOT NULL CHECK (enrollment IN ('cutover', 'lineage')),
   PRIMARY KEY (kind, row_id)
 );`;
const SNAPSHOT = `
 INSERT INTO as_issuance_cohort(kind, row_id, version, original_expires_at, enrollment)
 SELECT 'token', token_id, 'legacy_expiry_v1', expires_at, 'cutover' FROM tokens;
 INSERT INTO as_issuance_cohort(kind, row_id, version, original_expires_at, enrollment)
 SELECT 'refresh', refresh_token_hash, 'legacy_expiry_v1', expires_at, 'cutover' FROM oauth_refresh_tokens;
 INSERT INTO as_issuance_cohort(kind, row_id, version, original_expires_at, enrollment)
 SELECT DISTINCT 'family', family_id, 'legacy_expiry_v1', expires_at, 'cutover'
 FROM oauth_refresh_tokens WHERE family_id IS NOT NULL;
 INSERT INTO as_issuance_cohort(kind, row_id, version, original_expires_at, enrollment)
 SELECT 'grant', grant_id, 'legacy_expiry_v1', expires_at, 'cutover' FROM grants;
 INSERT INTO as_issuance_cohort(kind, row_id, version, original_expires_at, enrollment)
 SELECT 'package', package_id, 'legacy_expiry_v1', NULL, 'cutover' FROM grant_packages;`;

interface SqliteCutoverDatabase {
	exec(sql: string): unknown;
	prepare(sql: string): {
		all(...params: unknown[]): unknown[];
		get(...params: unknown[]): unknown;
		run(...params: unknown[]): unknown;
	};
	transaction<T>(fn: () => T): { immediate(): T };
}
interface PostgresCutoverClient {
	query(
		sql: string,
		params?: unknown[],
	): Promise<{ rows: Record<string, unknown>[] }>;
}
function requireComplete(rows: unknown[]): void {
	if (
		rows.length !== 1 ||
		(rows[0] as { version?: unknown }).version !== ISSUANCE_CUTOVER_VERSION
	) {
		throw new Error(
			"Issuance cutover is incomplete; operator recovery required",
		);
	}
}

/** Atomic, serialized, once-only enrollment; never writes existing expiry values. */
export function migrateSqliteIssuanceCutover(db: SqliteCutoverDatabase): void {
	db.transaction(() => {
		const tables = db
			.prepare(
				"SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (?, ?)",
			)
			.all(...TABLES);
		if (tables.length) {
			if (tables.length !== 2)
				throw new Error("Issuance cutover tables are incomplete");
			requireComplete(
				db.prepare("SELECT version FROM as_issuance_cutover").all(),
			);
			return;
		}
		db.exec(DDL);
		db.prepare("INSERT INTO as_issuance_cutover VALUES (?, ?)").run(
			ISSUANCE_CUTOVER_VERSION,
			new Date().toISOString(),
		);
		db.exec(SNAPSHOT);
	}).immediate();
}

/** Called with the startup client; owns only this migration's transaction. */
export async function migratePostgresIssuanceCutover(
	client: PostgresCutoverClient,
): Promise<void> {
	await client.query("BEGIN");
	try {
		await client.query(
			"SELECT pg_advisory_xact_lock(hashtextextended('as_issuance_cutover_v1', 0))",
		);
		const tables = await client.query(
			"SELECT tablename FROM pg_tables WHERE schemaname = current_schema() AND tablename = ANY($1::text[])",
			[TABLES],
		);
		if (tables.rows.length) {
			if (tables.rows.length !== 2)
				throw new Error("Issuance cutover tables are incomplete");
			requireComplete(
				(await client.query("SELECT version FROM as_issuance_cutover")).rows,
			);
		} else {
			await client.query(
				"LOCK TABLE tokens, oauth_refresh_tokens, grants, grant_packages IN SHARE ROW EXCLUSIVE MODE",
			);
			await client.query(DDL);
			await client.query("INSERT INTO as_issuance_cutover VALUES ($1, $2)", [
				ISSUANCE_CUTOVER_VERSION,
				new Date().toISOString(),
			]);
			await client.query(SNAPSHOT);
		}
		await client.query("COMMIT");
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	}
}

export interface IssuanceProtection {
	original_expires_at: string | null;
}
export const READ_ISSUANCE_PROTECTION = `SELECT c.original_expires_at FROM as_issuance_cohort c
 JOIN as_issuance_cutover m ON m.version = c.version
 WHERE m.version = 'legacy_expiry_v1' AND c.kind = $1 AND c.row_id = $2`;

export function sqliteIssuanceProtection(
	db: SqliteCutoverDatabase,
	kind: string,
	id: string,
): IssuanceProtection | undefined {
	requireComplete(db.prepare("SELECT version FROM as_issuance_cutover").all());
	return db
		.prepare(READ_ISSUANCE_PROTECTION.replace(/\$\d/g, "?"))
		.get(kind, id) as IssuanceProtection | undefined;
}
export async function postgresIssuanceProtection(
	client: PostgresCutoverClient,
	kind: string,
	id: string,
): Promise<IssuanceProtection | undefined> {
	requireComplete(
		(await client.query("SELECT version FROM as_issuance_cutover")).rows,
	);
	return (await client.query(READ_ISSUANCE_PROTECTION, [kind, id]))
		.rows[0] as unknown as IssuanceProtection | undefined;
}
