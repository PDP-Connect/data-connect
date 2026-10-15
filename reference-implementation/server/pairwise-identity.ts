// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { createHmac, randomBytes } from "node:crypto";
import { getDb } from "./db.ts";
import {
	isPostgresStorageBackend,
	type PostgresTransactionClient,
	withPostgresTransaction,
} from "./postgres-storage.ts";

const ROOT_KEY_HEX = /^[0-9a-f]{64}$/i;

const ROOT_KEY_VERSION = 1;
const ROOT_KEY_BYTES = 32;

export class PairwiseIdentityContextError extends Error {
	readonly code = "grant_invalid";

	constructor(message: string) {
		super(message);
		this.name = "PairwiseIdentityContextError";
	}
}

export class PairwiseIdentityDeploymentError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PairwiseIdentityDeploymentError";
	}
}

function requireNonEmptyString(
	value: unknown,
	name: string,
): asserts value is string {
	if (typeof value !== "string" || value.length === 0) {
		throw new PairwiseIdentityContextError(`Invalid ${name}`);
	}
}

function requireDeploymentString(
	value: unknown,
	name: string,
): asserts value is string {
	if (typeof value !== "string" || value.length === 0) {
		throw new PairwiseIdentityDeploymentError(`Invalid ${name}`);
	}
}

function validateScope(scope: PairwiseIdentityScope): void {
	if (!scope || typeof scope !== "object") {
		throw new PairwiseIdentityContextError("Invalid identity context");
	}
	requireNonEmptyString(scope.issuer, "issuer");
	requireNonEmptyString(scope.clientId, "client ID");
	requireNonEmptyString(scope.clientSector, "client sector");
	requireNonEmptyString(scope.subjectId, "subject ID");
}

function validateHandleInput(input: PairwiseHandleInput): void {
	validateScope(input);
	requireNonEmptyString(input.internalId, "internal ID");
	if (
		input.kind !== "subject" &&
		input.kind !== "grantor" &&
		input.kind !== "instance"
	) {
		throw new PairwiseIdentityContextError("Invalid identity kind");
	}
	if (input.sourceId !== undefined) {
		requireNonEmptyString(input.sourceId, "source ID");
	}
}

function validateMembershipInput(input: {
	clientId: unknown;
	clientSector: unknown;
	issuer: unknown;
}): void {
	requireDeploymentString(input.clientId, "client ID");
	requireDeploymentString(input.clientSector, "client sector");
	requireDeploymentString(input.issuer, "issuer");
}

function validateMigrationInput(input: {
	fromIssuer: unknown;
	toIssuer: unknown;
}): void {
	requireDeploymentString(input.fromIssuer, "migration source issuer");
	requireDeploymentString(input.toIssuer, "migration target issuer");
	if (input.fromIssuer === input.toIssuer) {
		throw new PairwiseIdentityDeploymentError(
			"Issuer migration requires distinct configured issuer strings",
		);
	}
}

export interface PairwiseIdentityScope {
	clientId: string;
	clientSector: string;
	issuer: string;
	subjectId: string;
}

export interface PairwiseHandleInput extends PairwiseIdentityScope {
	internalId: string;
	kind: "subject" | "grantor" | "instance";
	sourceId?: string;
}

function validRootKey(encoded: string | undefined): Buffer {
	if (!(encoded && ROOT_KEY_HEX.test(encoded))) {
		throw new Error(
			"Pairwise identity root key is missing, corrupt, or unavailable",
		);
	}
	return Buffer.from(encoded, "hex");
}

/** Explicit AS setup operation. Issuance never creates or replaces this key. */
export async function initializePairwiseIdentityRootKey(
	issuer: string,
): Promise<void> {
	requireDeploymentString(issuer, "issuer");
	const generated = randomBytes(ROOT_KEY_BYTES).toString("hex");
	if (isPostgresStorageBackend()) {
		await withPostgresTransaction(async (client) => {
			await client.query(
				"LOCK TABLE pairwise_identity_deployment IN EXCLUSIVE MODE",
			);
			const configured = await client.query<{ issuer: string }>(
				"SELECT issuer FROM pairwise_identity_deployment WHERE singleton_id=1",
			);
			if (configured.rows[0] && configured.rows[0].issuer !== issuer) {
				throw new PairwiseIdentityDeploymentError(
					"Configured issuer changed; record an issuer migration first",
				);
			}
			const existing = await client.query<{ issuer: string }>(
				`SELECT issuer FROM pairwise_identity_root_keys
           UNION SELECT issuer FROM pairwise_identity_handles
           UNION SELECT issuer FROM pairwise_trusted_client_sectors
           UNION SELECT issuer FROM pairwise_identity_legacy_backfills`,
			);
			if (existing.rows.some((row) => row.issuer !== issuer)) {
				throw new PairwiseIdentityDeploymentError(
					"Existing identity state requires an explicit issuer migration",
				);
			}
			if (!configured.rows[0]) {
				await client.query(
					"INSERT INTO pairwise_identity_deployment (singleton_id,issuer) VALUES (1,$1)",
					[issuer],
				);
			}
			const prior = await client.query<{ root_key_hex: string }>(
				"SELECT root_key_hex FROM pairwise_identity_root_keys WHERE issuer=$1",
				[issuer],
			);
			if (prior.rows.length) {
				validRootKey(prior.rows[0]?.root_key_hex);
				return;
			}
			const issued = await client.query<{ exists: boolean }>(
				"SELECT EXISTS (SELECT 1 FROM pairwise_identity_handles WHERE issuer=$1 AND scheme='v1') AS exists",
				[issuer],
			);
			if (issued.rows[0]?.exists)
				throw new Error(
					"Pairwise identity root key is missing after prior issuance",
				);
			await client.query(
				"INSERT INTO pairwise_identity_root_keys (issuer,key_version,root_key_hex,created_at) VALUES ($1,$2,$3,$4)",
				[issuer, ROOT_KEY_VERSION, generated, new Date().toISOString()],
			);
		});
		return;
	}

	const db = getDb();
	db.transaction(() => {
		const configured = db
			.prepare(
				"SELECT issuer FROM pairwise_identity_deployment WHERE singleton_id=1",
			)
			.get<{ issuer: string }>();
		if (configured && configured.issuer !== issuer) {
			throw new PairwiseIdentityDeploymentError(
				"Configured issuer changed; record an issuer migration first",
			);
		}
		const existing = db
			.prepare(
				`SELECT issuer FROM pairwise_identity_root_keys
         UNION SELECT issuer FROM pairwise_identity_handles
         UNION SELECT issuer FROM pairwise_trusted_client_sectors
         UNION SELECT issuer FROM pairwise_identity_legacy_backfills`,
			)
			.all<{ issuer: string }>();
		if (existing.some((row) => row.issuer !== issuer)) {
			throw new PairwiseIdentityDeploymentError(
				"Existing identity state requires an explicit issuer migration",
			);
		}
		if (!configured) {
			db.prepare(
				"INSERT INTO pairwise_identity_deployment (singleton_id,issuer) VALUES (1,?)",
			).run(issuer);
		}
		const prior = db
			.prepare(
				"SELECT root_key_hex FROM pairwise_identity_root_keys WHERE issuer=?",
			)
			.get<{ root_key_hex: string }>(issuer);
		if (prior) {
			validRootKey(prior.root_key_hex);
			return;
		}
		const issued = db
			.prepare(
				"SELECT 1 AS issued FROM pairwise_identity_handles WHERE issuer=? AND scheme='v1' LIMIT 1",
			)
			.get(issuer);
		if (issued) {
			throw new Error(
				"Pairwise identity root key is missing after prior issuance",
			);
		}
		db.prepare(
			"INSERT INTO pairwise_identity_root_keys (issuer,key_version,root_key_hex,created_at) VALUES (?,?,?,?)",
		).run(issuer, ROOT_KEY_VERSION, generated, new Date().toISOString());
	}).immediate();
}

/** Completes the required legacy-client sector backfill before v1 issuance. */
export async function completePairwiseIdentityLegacyBackfill(
	issuer: string,
): Promise<void> {
	requireDeploymentString(issuer, "issuer");
	const now = new Date().toISOString();
	if (isPostgresStorageBackend()) {
		await withPostgresTransaction(async (client) => {
			await client.query(
				"LOCK TABLE pairwise_identity_deployment IN SHARE MODE",
			);
			const configured = await client.query<{ issuer: string }>(
				"SELECT issuer FROM pairwise_identity_deployment WHERE singleton_id=1",
			);
			if (configured.rows[0]?.issuer !== issuer)
				throw new PairwiseIdentityDeploymentError(
					"Configured issuer changed; record an issuer migration first",
				);
			const foreign = await client.query(
				`SELECT 1 FROM pairwise_identity_root_keys WHERE issuer<>$1
				 UNION ALL SELECT 1 FROM pairwise_identity_handles WHERE issuer<>$1
				 UNION ALL SELECT 1 FROM pairwise_trusted_client_sectors WHERE issuer<>$1
				 UNION ALL SELECT 1 FROM pairwise_identity_legacy_backfills WHERE issuer<>$1 LIMIT 1`,
				[issuer],
			);
			if (foreign.rowCount)
				throw new PairwiseIdentityDeploymentError(
					"Identity state exists outside the configured issuer",
				);
			await client.query(
				"LOCK TABLE pairwise_identity_handles, pairwise_trusted_client_sectors IN SHARE ROW EXCLUSIVE MODE",
			);
			const completed = await client.query(
				"SELECT 1 FROM pairwise_identity_legacy_backfills WHERE issuer=$1",
				[issuer],
			);
			if (completed.rowCount) return;
			const missing = await client.query(
				`SELECT 1 FROM pairwise_identity_handles h
          LEFT JOIN pairwise_trusted_client_sectors m ON m.issuer=h.issuer AND m.client_id=h.client_id
         WHERE h.issuer=$1 AND h.scheme='legacy' AND m.client_id IS NULL LIMIT 1`,
				[issuer],
			);
			if (missing.rowCount)
				throw new PairwiseIdentityDeploymentError(
					"Legacy client-sector backfill is incomplete",
				);
			await client.query(
				"INSERT INTO pairwise_identity_legacy_backfills (issuer,completed_at) VALUES ($1,$2) ON CONFLICT (issuer) DO NOTHING",
				[issuer, now],
			);
		});
		return;
	}
	const db = getDb();
	db.transaction(() => {
		assertConfiguredIssuerSqlite(db, issuer);
		if (
			db
				.prepare(
					"SELECT 1 FROM pairwise_identity_legacy_backfills WHERE issuer=?",
				)
				.get(issuer)
		)
			return;
		const missing = db
			.prepare(
				`SELECT 1 FROM pairwise_identity_handles h
        LEFT JOIN pairwise_trusted_client_sectors m ON m.issuer=h.issuer AND m.client_id=h.client_id
       WHERE h.issuer=? AND h.scheme='legacy' AND m.client_id IS NULL LIMIT 1`,
			)
			.get(issuer);
		if (missing)
			throw new PairwiseIdentityDeploymentError(
				"Legacy client-sector backfill is incomplete",
			);
		db.prepare(
			"INSERT INTO pairwise_identity_legacy_backfills (issuer,completed_at) VALUES (?,?) ON CONFLICT (issuer) DO NOTHING",
		).run(issuer, now);
	}).immediate();
}

/** Explicitly changes an issuer namespace while preserving every stored handle. */
export async function migratePairwiseIdentityIssuer(input: {
	fromIssuer: string;
	toIssuer: string;
}): Promise<void> {
	validateMigrationInput(input);
	const now = new Date().toISOString();
	if (isPostgresStorageBackend()) {
		await withPostgresTransaction(async (client) => {
			await client.query(
				"LOCK TABLE pairwise_identity_deployment IN EXCLUSIVE MODE",
			);
			await client.query(
				"LOCK TABLE pairwise_identity_handles, pairwise_identity_root_keys, pairwise_trusted_client_sectors, pairwise_identity_legacy_backfills IN EXCLUSIVE MODE",
			);
			const configured = await client.query<{ issuer: string }>(
				"SELECT issuer FROM pairwise_identity_deployment WHERE singleton_id=1",
			);
			if (
				configured.rows[0] &&
				configured.rows[0].issuer !== input.fromIssuer
			) {
				throw new PairwiseIdentityDeploymentError(
					"Issuer migration source does not match the configured deployment issuer",
				);
			}
			const prior = await client.query(
				"SELECT 1 FROM pairwise_identity_issuer_migrations WHERE from_issuer=$1 AND to_issuer=$2",
				[input.fromIssuer, input.toIssuer],
			);
			if (prior.rowCount)
				throw new PairwiseIdentityDeploymentError(
					"Issuer migration was already recorded",
				);
			const target = await client.query(
				`SELECT 1 FROM pairwise_identity_handles WHERE issuer=$1
         UNION ALL SELECT 1 FROM pairwise_trusted_client_sectors WHERE issuer=$1
         UNION ALL SELECT 1 FROM pairwise_identity_root_keys WHERE issuer=$1
         UNION ALL SELECT 1 FROM pairwise_identity_legacy_backfills WHERE issuer=$1 LIMIT 1`,
				[input.toIssuer],
			);
			if (target.rowCount)
				throw new PairwiseIdentityDeploymentError(
					"Issuer migration target already has identity state",
				);
			const foreign = await client.query(
				`SELECT 1 FROM pairwise_identity_handles WHERE issuer<>$1
				 UNION ALL SELECT 1 FROM pairwise_trusted_client_sectors WHERE issuer<>$1
				 UNION ALL SELECT 1 FROM pairwise_identity_root_keys WHERE issuer<>$1
				 UNION ALL SELECT 1 FROM pairwise_identity_legacy_backfills WHERE issuer<>$1 LIMIT 1`,
				[input.fromIssuer],
			);
			if (foreign.rowCount)
				throw new PairwiseIdentityDeploymentError(
					"Identity state exists outside the migration source issuer",
				);
			const source = await client.query(
				`SELECT 1 FROM pairwise_identity_handles WHERE issuer=$1
				 UNION ALL SELECT 1 FROM pairwise_trusted_client_sectors WHERE issuer=$1
				 UNION ALL SELECT 1 FROM pairwise_identity_root_keys WHERE issuer=$1
				 UNION ALL SELECT 1 FROM pairwise_identity_legacy_backfills WHERE issuer=$1 LIMIT 1`,
				[input.fromIssuer],
			);
			if (!source.rowCount)
				throw new PairwiseIdentityDeploymentError(
					"Issuer migration source has no identity state",
				);
			await client.query(
				"UPDATE pairwise_identity_handles SET issuer=$2 WHERE issuer=$1",
				[input.fromIssuer, input.toIssuer],
			);
			await client.query(
				"UPDATE pairwise_trusted_client_sectors SET issuer=$2 WHERE issuer=$1",
				[input.fromIssuer, input.toIssuer],
			);
			await client.query(
				"UPDATE pairwise_identity_root_keys SET issuer=$2 WHERE issuer=$1",
				[input.fromIssuer, input.toIssuer],
			);
			await client.query(
				"UPDATE pairwise_identity_legacy_backfills SET issuer=$2 WHERE issuer=$1",
				[input.fromIssuer, input.toIssuer],
			);
			await client.query(
				`INSERT INTO pairwise_identity_deployment (singleton_id,issuer) VALUES (1,$1)
         ON CONFLICT (singleton_id) DO UPDATE SET issuer=EXCLUDED.issuer`,
				[input.toIssuer],
			);
			await client.query(
				"INSERT INTO pairwise_identity_issuer_migrations (from_issuer,to_issuer,migrated_at) VALUES ($1,$2,$3)",
				[input.fromIssuer, input.toIssuer, now],
			);
		});
		return;
	}
	const db = getDb();
	db.transaction(() => {
		const configured = db
			.prepare(
				"SELECT issuer FROM pairwise_identity_deployment WHERE singleton_id=1",
			)
			.get<{ issuer: string }>();
		if (configured && configured.issuer !== input.fromIssuer) {
			throw new PairwiseIdentityDeploymentError(
				"Issuer migration source does not match the configured deployment issuer",
			);
		}
		if (
			db
				.prepare(
					"SELECT 1 FROM pairwise_identity_issuer_migrations WHERE from_issuer=? AND to_issuer=?",
				)
				.get(input.fromIssuer, input.toIssuer)
		)
			throw new PairwiseIdentityDeploymentError(
				"Issuer migration was already recorded",
			);
		const target = db
			.prepare(
				`SELECT 1 FROM pairwise_identity_handles WHERE issuer=?
       UNION ALL SELECT 1 FROM pairwise_trusted_client_sectors WHERE issuer=?
       UNION ALL SELECT 1 FROM pairwise_identity_root_keys WHERE issuer=?
       UNION ALL SELECT 1 FROM pairwise_identity_legacy_backfills WHERE issuer=? LIMIT 1`,
			)
			.get(input.toIssuer, input.toIssuer, input.toIssuer, input.toIssuer);
		if (target)
			throw new PairwiseIdentityDeploymentError(
				"Issuer migration target already has identity state",
			);
		const foreign = db
			.prepare(
				`SELECT 1 FROM pairwise_identity_handles WHERE issuer<>?
				 UNION ALL SELECT 1 FROM pairwise_trusted_client_sectors WHERE issuer<>?
				 UNION ALL SELECT 1 FROM pairwise_identity_root_keys WHERE issuer<>?
				 UNION ALL SELECT 1 FROM pairwise_identity_legacy_backfills WHERE issuer<>? LIMIT 1`,
			)
			.get(
				input.fromIssuer,
				input.fromIssuer,
				input.fromIssuer,
				input.fromIssuer,
			);
		if (foreign)
			throw new PairwiseIdentityDeploymentError(
				"Identity state exists outside the migration source issuer",
			);
		const source = db
			.prepare(
				`SELECT 1 FROM pairwise_identity_handles WHERE issuer=?
				 UNION ALL SELECT 1 FROM pairwise_trusted_client_sectors WHERE issuer=?
				 UNION ALL SELECT 1 FROM pairwise_identity_root_keys WHERE issuer=?
				 UNION ALL SELECT 1 FROM pairwise_identity_legacy_backfills WHERE issuer=? LIMIT 1`,
			)
			.get(
				input.fromIssuer,
				input.fromIssuer,
				input.fromIssuer,
				input.fromIssuer,
			);
		if (!source)
			throw new PairwiseIdentityDeploymentError(
				"Issuer migration source has no identity state",
			);
		db.prepare(
			"UPDATE pairwise_identity_handles SET issuer=? WHERE issuer=?",
		).run(input.toIssuer, input.fromIssuer);
		db.prepare(
			"UPDATE pairwise_trusted_client_sectors SET issuer=? WHERE issuer=?",
		).run(input.toIssuer, input.fromIssuer);
		db.prepare(
			"UPDATE pairwise_identity_root_keys SET issuer=? WHERE issuer=?",
		).run(input.toIssuer, input.fromIssuer);
		db.prepare(
			"UPDATE pairwise_identity_legacy_backfills SET issuer=? WHERE issuer=?",
		).run(input.toIssuer, input.fromIssuer);
		db.prepare(
			`INSERT INTO pairwise_identity_deployment (singleton_id,issuer) VALUES (1,?)
       ON CONFLICT (singleton_id) DO UPDATE SET issuer=excluded.issuer`,
		).run(input.toIssuer);
		db.prepare(
			"INSERT INTO pairwise_identity_issuer_migrations (from_issuer,to_issuer,migrated_at) VALUES (?,?,?)",
		).run(input.fromIssuer, input.toIssuer, now);
	}).immediate();
}

/**
 * Records a trusted AS sector assignment once. The caller must resolve verified
 * registration metadata into a disjoint, tagged sector namespace first; this
 * storage layer does not inspect client registration metadata.
 */
export async function recordTrustedClientSectorMembership(input: {
	clientId: string;
	clientSector: string;
	issuer: string;
}): Promise<void> {
	return persistTrustedClientSectorMembership(input, false);
}

/**
 * Imports authoritative AS registration facts during backfill. The importer must
 * cover every legacy client_id, including @owner when owner bindings use this API.
 */
export async function backfillTrustedClientSectorMembership(input: {
	clientId: string;
	clientSector: string;
	issuer: string;
}): Promise<void> {
	return persistTrustedClientSectorMembership(input, true);
}

async function persistTrustedClientSectorMembership(
	input: { clientId: string; clientSector: string; issuer: string },
	allowExistingAliasConflict: boolean,
): Promise<void> {
	validateMembershipInput(input);
	if (isPostgresStorageBackend()) {
		await withPostgresTransaction(async (client) => {
			await client.query(
				"LOCK TABLE pairwise_identity_deployment IN SHARE MODE",
			);
			const configured = await client.query<{ issuer: string }>(
				"SELECT issuer FROM pairwise_identity_deployment WHERE singleton_id=1",
			);
			if (configured.rows[0]?.issuer !== input.issuer)
				throw new PairwiseIdentityDeploymentError(
					"Configured issuer changed; record an issuer migration first",
				);
			const foreign = await client.query(
				`SELECT 1 FROM pairwise_identity_root_keys WHERE issuer<>$1
				 UNION ALL SELECT 1 FROM pairwise_identity_handles WHERE issuer<>$1
				 UNION ALL SELECT 1 FROM pairwise_trusted_client_sectors WHERE issuer<>$1
				 UNION ALL SELECT 1 FROM pairwise_identity_legacy_backfills WHERE issuer<>$1 LIMIT 1`,
				[input.issuer],
			);
			if (foreign.rowCount)
				throw new PairwiseIdentityDeploymentError(
					"Identity state exists outside the configured issuer",
				);
			await client.query(
				"LOCK TABLE pairwise_identity_handles, pairwise_trusted_client_sectors IN SHARE ROW EXCLUSIVE MODE",
			);
			const assigned = await client.query<{ client_sector: string }>(
				"SELECT client_sector FROM pairwise_trusted_client_sectors WHERE issuer=$1 AND client_id=$2",
				[input.issuer, input.clientId],
			);
			if (assigned.rows[0]) {
				if (assigned.rows[0].client_sector !== input.clientSector) {
					throw new PairwiseIdentityDeploymentError(
						"Trusted client sector assignment is immutable",
					);
				}
				return;
			}
			const backfill = await client.query(
				"SELECT 1 FROM pairwise_identity_legacy_backfills WHERE issuer=$1",
				[input.issuer],
			);
			const legacy = await client.query<{
				kind: string;
				subject_id: string;
				internal_id: string;
				handle: string;
			}>(
				"SELECT kind,subject_id,internal_id,handle FROM pairwise_identity_handles WHERE issuer=$1 AND client_id=$2 AND scheme='legacy'",
				[input.issuer, input.clientId],
			);
			if (backfill.rowCount && legacy.rowCount) {
				throw new PairwiseIdentityDeploymentError(
					"Legacy membership cannot be assigned after backfill completion",
				);
			}
			const peers = await client.query<{
				client_id: string;
				kind: string;
				subject_id: string;
				internal_id: string;
				handle: string;
			}>(
				`SELECT h.client_id,h.kind,h.subject_id,h.internal_id,h.handle FROM pairwise_identity_handles h
          JOIN pairwise_trusted_client_sectors m ON m.issuer=h.issuer AND m.client_id=h.client_id
         WHERE h.issuer=$1 AND m.client_sector=$2 AND h.scheme='legacy'`,
				[input.issuer, input.clientSector],
			);
			if (!allowExistingAliasConflict) {
				assertNoLegacyConflict(legacy.rows, peers.rows);
			}
			await client.query(
				`INSERT INTO pairwise_trusted_client_sectors (issuer,client_id,client_sector) VALUES ($1,$2,$3)`,
				[input.issuer, input.clientId, input.clientSector],
			);
		});
		return;
	}
	const db = getDb();
	db.transaction(() => {
		assertConfiguredIssuerSqlite(db, input.issuer);
		const assigned = db
			.prepare(
				"SELECT client_sector FROM pairwise_trusted_client_sectors WHERE issuer=? AND client_id=?",
			)
			.get<{ client_sector: string }>(input.issuer, input.clientId);
		if (assigned) {
			if (assigned.client_sector !== input.clientSector)
				throw new PairwiseIdentityDeploymentError(
					"Trusted client sector assignment is immutable",
				);
			return;
		}
		const backfill = db
			.prepare(
				"SELECT 1 FROM pairwise_identity_legacy_backfills WHERE issuer=?",
			)
			.get(input.issuer);
		const legacy = db
			.prepare(
				"SELECT kind,subject_id,internal_id,handle FROM pairwise_identity_handles WHERE issuer=? AND client_id=? AND scheme='legacy'",
			)
			.all<{
				kind: string;
				subject_id: string;
				internal_id: string;
				handle: string;
			}>(input.issuer, input.clientId);
		if (backfill && legacy.length)
			throw new PairwiseIdentityDeploymentError(
				"Legacy membership cannot be assigned after backfill completion",
			);
		const peers = db
			.prepare(
				`SELECT h.client_id,h.kind,h.subject_id,h.internal_id,h.handle FROM pairwise_identity_handles h
        JOIN pairwise_trusted_client_sectors m ON m.issuer=h.issuer AND m.client_id=h.client_id
       WHERE h.issuer=? AND m.client_sector=? AND h.scheme='legacy'`,
			)
			.all<{
				client_id: string;
				kind: string;
				subject_id: string;
				internal_id: string;
				handle: string;
			}>(input.issuer, input.clientSector);
		if (!allowExistingAliasConflict) {
			assertNoLegacyConflict(legacy, peers);
		}
		db.prepare(
			"INSERT INTO pairwise_trusted_client_sectors (issuer,client_id,client_sector) VALUES (?,?,?)",
		).run(input.issuer, input.clientId, input.clientSector);
	}).immediate();
}

function assertConfiguredIssuerSqlite(
	db: ReturnType<typeof getDb>,
	issuer: string,
): void {
	const configured = db
		.prepare(
			"SELECT issuer FROM pairwise_identity_deployment WHERE singleton_id=1",
		)
		.get<{ issuer: string }>();
	if (!configured || configured.issuer !== issuer) {
		throw new PairwiseIdentityDeploymentError(
			"Configured issuer changed; record an issuer migration first",
		);
	}
	const foreign = db
		.prepare(
			`SELECT 1 FROM pairwise_identity_root_keys WHERE issuer<>?
			 UNION ALL SELECT 1 FROM pairwise_identity_handles WHERE issuer<>?
			 UNION ALL SELECT 1 FROM pairwise_trusted_client_sectors WHERE issuer<>?
			 UNION ALL SELECT 1 FROM pairwise_identity_legacy_backfills WHERE issuer<>? LIMIT 1`,
		)
		.get(issuer, issuer, issuer, issuer);
	if (foreign)
		throw new PairwiseIdentityDeploymentError(
			"Identity state exists outside the configured issuer",
		);
}

function legacyIdentities(
	rows: readonly {
		kind: string;
		subject_id: string;
		internal_id: string;
		handle: string;
	}[],
): Map<string, Set<string>> {
	const identities = new Map<string, Set<string>>();
	for (const row of rows) {
		const key =
			row.kind === "instance"
				? JSON.stringify(["instance", row.subject_id, row.internal_id])
				: JSON.stringify(["person", row.internal_id]);
		const handles = identities.get(key) ?? new Set<string>();
		handles.add(row.handle);
		identities.set(key, handles);
	}
	return identities;
}

function assertNoLegacyConflict(
	candidateRows: readonly {
		kind: string;
		subject_id: string;
		internal_id: string;
		handle: string;
	}[],
	peerRows: readonly {
		kind: string;
		subject_id: string;
		internal_id: string;
		handle: string;
	}[],
): void {
	const candidate = legacyIdentities(candidateRows);
	const peers = legacyIdentities(peerRows);
	for (const [identity, handles] of candidate) {
		const peerHandles = peers.get(identity) ?? new Set<string>();
		if (handles.size > 1 || new Set([...handles, ...peerHandles]).size > 1) {
			throw new PairwiseIdentityDeploymentError(
				"Ambiguous legacy pairwise identity mapping",
			);
		}
	}
}

function semanticIdentity(input: PairwiseHandleInput): {
	kind: "person" | "instance";
	subjectId: string;
} {
	return input.kind === "instance"
		? { kind: "instance", subjectId: input.subjectId }
		: { kind: "person", subjectId: input.internalId };
}

function deterministicHandle(
	input: PairwiseHandleInput,
	rootKey: Buffer,
): string {
	const identity = semanticIdentity(input);
	const message = JSON.stringify(
		identity.kind === "instance"
			? [
					"pdpp-pairwise",
					"v1",
					identity.kind,
					input.issuer,
					input.clientSector,
					input.subjectId,
					input.internalId,
				]
			: [
					"pdpp-pairwise",
					"v1",
					identity.kind,
					input.issuer,
					input.clientSector,
					input.internalId,
				],
	);
	const digest = createHmac("sha256", rootKey)
		.update(message, "utf8")
		.digest("base64url");
	return `${identity.kind === "instance" ? "inst" : "sub"}_v1_${digest}`;
}

function rootKeyForIssuerSync(issuer: string): Buffer {
	const row = getDb()
		.prepare(
			"SELECT key_version,root_key_hex FROM pairwise_identity_root_keys WHERE issuer=?",
		)
		.get<{ key_version: number; root_key_hex: string }>(issuer);
	if (row?.key_version !== ROOT_KEY_VERSION) {
		throw new Error("Pairwise identity root key is missing or unavailable");
	}
	return validRootKey(row.root_key_hex);
}

/**
 * Legacy ambiguity checks precede canonical v1 and legacy lookup. New mappings
 * use issuer, trusted sector, and semantic identity; aliases and streams are omitted.
 */
export async function getPairwiseHandle(
	input: PairwiseHandleInput,
): Promise<string> {
	return await resolvePairwiseHandle(input, "legacy-compatible");
}

/**
 * HMAC-only lookup or issuance for grants created under the v1 generation.
 * Legacy rows are never read, returned, or checked for ambiguity, so an old
 * raw value for the same client and identity cannot leak into a new grant.
 */
export async function getPairwiseV1Handle(
	input: PairwiseHandleInput,
): Promise<string> {
	return await resolvePairwiseHandle(input, "v1");
}

async function resolvePairwiseHandle(
	input: PairwiseHandleInput,
	generation: "legacy-compatible" | "v1",
): Promise<string> {
	validateHandleInput(input);
	const identity = semanticIdentity(input);
	const legacySubject =
		input.kind === "instance" ? input.subjectId : input.internalId;
	const legacyKind = input.kind === "instance" ? "instance" : "subject";
	const legacyFilter =
		input.kind === "instance"
			? "h.kind='instance' AND h.subject_id=$3 AND h.internal_id=$4"
			: "((h.kind='subject' AND h.subject_id=$3 AND h.internal_id=$4) OR (h.kind='grantor' AND h.internal_id=$4))";

	if (isPostgresStorageBackend()) {
		return withPostgresTransaction(async (client) => {
			await client.query(
				"LOCK TABLE pairwise_identity_deployment IN SHARE MODE",
			);
			const configured = await client.query<{ issuer: string }>(
				"SELECT issuer FROM pairwise_identity_deployment WHERE singleton_id=1",
			);
			if (configured.rows[0]?.issuer !== input.issuer) {
				throw new PairwiseIdentityDeploymentError(
					"Configured issuer changed; record an issuer migration first",
				);
			}
			const foreign = await client.query(
				`SELECT 1 FROM pairwise_identity_root_keys WHERE issuer<>$1
				 UNION ALL SELECT 1 FROM pairwise_identity_handles WHERE issuer<>$1
				 UNION ALL SELECT 1 FROM pairwise_trusted_client_sectors WHERE issuer<>$1
				 UNION ALL SELECT 1 FROM pairwise_identity_legacy_backfills WHERE issuer<>$1 LIMIT 1`,
				[input.issuer],
			);
			if (foreign.rowCount)
				throw new PairwiseIdentityDeploymentError(
					"Identity state exists outside the configured issuer",
				);
			await client.query(
				"LOCK TABLE pairwise_identity_handles, pairwise_trusted_client_sectors IN SHARE ROW EXCLUSIVE MODE",
			);
			const member = await client.query<{ client_sector: string }>(
				"SELECT client_sector FROM pairwise_trusted_client_sectors WHERE issuer=$1 AND client_id=$2",
				[input.issuer, input.clientId],
			);
			if (member.rows[0]?.client_sector !== input.clientSector) {
				throw new PairwiseIdentityContextError(
					"Trusted client sector membership is missing or mismatched",
				);
			}
			const backfill = await client.query(
				"SELECT 1 FROM pairwise_identity_legacy_backfills WHERE issuer=$1",
				[input.issuer],
			);
			if (!backfill.rowCount) {
				const missing = await client.query(
					`SELECT 1 FROM pairwise_identity_handles h LEFT JOIN pairwise_trusted_client_sectors m
             ON m.issuer=h.issuer AND m.client_id=h.client_id
           WHERE h.issuer=$1 AND h.scheme='legacy' AND m.client_id IS NULL LIMIT 1`,
					[input.issuer],
				);
				if (missing.rowCount)
					throw new PairwiseIdentityDeploymentError(
						"Legacy client-sector backfill is incomplete",
					);
				await client.query(
					"INSERT INTO pairwise_identity_legacy_backfills (issuer,completed_at) VALUES ($1,$2)",
					[input.issuer, new Date().toISOString()],
				);
			}
			const legacyRows =
				generation === "v1"
					? []
					: (
							await client.query<{ handle: string }>(
								`SELECT DISTINCT h.handle FROM pairwise_identity_handles h
          JOIN pairwise_trusted_client_sectors m ON m.issuer=h.issuer AND m.client_id=h.client_id
         WHERE h.issuer=$1 AND m.client_sector=$2 AND ${legacyFilter} AND h.scheme='legacy'`,
								[
									input.issuer,
									input.clientSector,
									legacySubject,
									input.internalId,
								],
							)
						).rows;
			const legacyHandles = [...new Set(legacyRows.map((row) => row.handle))];
			if (legacyHandles.length > 1)
				throw new PairwiseIdentityContextError(
					"Ambiguous legacy pairwise identity mapping",
				);
			const canonical = await client.query<{ handle: string }>(
				`SELECT handle FROM pairwise_identity_handles
          WHERE issuer=$1 AND client_sector=$2 AND kind=$3 AND subject_id=$4 AND internal_id=$5 AND scheme='v1'`,
				[
					input.issuer,
					input.clientSector,
					legacyKind,
					identity.subjectId,
					input.internalId,
				],
			);
			if (canonical.rows[0]?.handle) {
				const key = await client.query<{
					key_version: number;
					root_key_hex: string;
				}>(
					"SELECT key_version,root_key_hex FROM pairwise_identity_root_keys WHERE issuer=$1",
					[input.issuer],
				);
				if (key.rows[0]?.key_version !== ROOT_KEY_VERSION)
					throw new Error(
						"Pairwise identity root key is missing or unavailable",
					);
				validRootKey(key.rows[0]?.root_key_hex);
				return canonical.rows[0].handle;
			}
			if (legacyHandles.length) return legacyHandles[0] as string;
			const keyRow = await client.query<{
				key_version: number;
				root_key_hex: string;
			}>(
				"SELECT key_version,root_key_hex FROM pairwise_identity_root_keys WHERE issuer=$1",
				[input.issuer],
			);
			if (keyRow.rows[0]?.key_version !== ROOT_KEY_VERSION)
				throw new Error("Pairwise identity root key is missing or unavailable");
			const handle = deterministicHandle(
				input,
				validRootKey(keyRow.rows[0]?.root_key_hex),
			);
			await client.query(
				`INSERT INTO pairwise_identity_handles
          (issuer,subject_id,client_id,kind,source_id,internal_id,client_sector,scheme,handle)
         VALUES ($1,$2,$3,$4,'',$5,$6,'v1',$7) ON CONFLICT DO NOTHING`,
				[
					input.issuer,
					identity.subjectId,
					input.clientId,
					legacyKind,
					input.internalId,
					input.clientSector,
					handle,
				],
			);
			const stored = await client.query<{ handle: string }>(
				`SELECT handle FROM pairwise_identity_handles
          WHERE issuer=$1 AND client_sector=$2 AND kind=$3 AND subject_id=$4 AND internal_id=$5 AND scheme='v1'`,
				[
					input.issuer,
					input.clientSector,
					legacyKind,
					identity.subjectId,
					input.internalId,
				],
			);
			if (!stored.rows[0]?.handle)
				throw new Error("Pairwise identity persistence failed");
			return stored.rows[0].handle;
		});
	}

	const db = getDb();
	return db
		.transaction(() => {
			assertConfiguredIssuerSqlite(db, input.issuer);
			const member = db
				.prepare(
					"SELECT client_sector FROM pairwise_trusted_client_sectors WHERE issuer=? AND client_id=?",
				)
				.get<{ client_sector: string }>(input.issuer, input.clientId);
			if (member?.client_sector !== input.clientSector) {
				throw new PairwiseIdentityContextError(
					"Trusted client sector membership is missing or mismatched",
				);
			}
			const backfill = db
				.prepare(
					"SELECT 1 FROM pairwise_identity_legacy_backfills WHERE issuer=?",
				)
				.get(input.issuer);
			if (!backfill) {
				const missing = db
					.prepare(
						`SELECT 1 FROM pairwise_identity_handles h LEFT JOIN pairwise_trusted_client_sectors m
           ON m.issuer=h.issuer AND m.client_id=h.client_id
         WHERE h.issuer=? AND h.scheme='legacy' AND m.client_id IS NULL LIMIT 1`,
					)
					.get(input.issuer);
				if (missing)
					throw new PairwiseIdentityDeploymentError(
						"Legacy client-sector backfill is incomplete",
					);
				db.prepare(
					"INSERT INTO pairwise_identity_legacy_backfills (issuer,completed_at) VALUES (?,?)",
				).run(input.issuer, new Date().toISOString());
			}
			const legacyRows =
				generation === "v1"
					? []
					: db
							.prepare(
								`SELECT DISTINCT h.handle FROM pairwise_identity_handles h
        JOIN pairwise_trusted_client_sectors m ON m.issuer=h.issuer AND m.client_id=h.client_id
					WHERE h.issuer=? AND m.client_sector=? AND ${input.kind === "instance" ? "h.kind='instance' AND h.subject_id=? AND h.internal_id=?" : "((h.kind='subject' AND h.subject_id=? AND h.internal_id=?) OR (h.kind='grantor' AND h.internal_id=?))"} AND h.scheme='legacy'`,
							)
							.all<{ handle: string }>(
								input.issuer,
								input.clientSector,
								legacySubject,
								input.internalId,
								...(input.kind === "instance" ? [] : [input.internalId]),
							);
			const legacyHandles = [...new Set(legacyRows.map((row) => row.handle))];
			if (legacyHandles.length > 1)
				throw new PairwiseIdentityContextError(
					"Ambiguous legacy pairwise identity mapping",
				);
			const canonical = db
				.prepare(
					`SELECT handle FROM pairwise_identity_handles
        WHERE issuer=? AND client_sector=? AND kind=? AND subject_id=? AND internal_id=? AND scheme='v1'`,
				)
				.get<{ handle: string }>(
					input.issuer,
					input.clientSector,
					legacyKind,
					identity.subjectId,
					input.internalId,
				);
			if (canonical?.handle) {
				rootKeyForIssuerSync(input.issuer);
				return canonical.handle;
			}
			if (legacyHandles.length) return legacyHandles[0] as string;
			const rootKey = rootKeyForIssuerSync(input.issuer);
			const handle = deterministicHandle(input, rootKey);
			db.prepare(
				`INSERT INTO pairwise_identity_handles
        (issuer,subject_id,client_id,kind,source_id,internal_id,client_sector,scheme,handle)
       VALUES (?,?,?,?,?,?,?,'v1',?) ON CONFLICT DO NOTHING`,
			).run(
				input.issuer,
				identity.subjectId,
				input.clientId,
				legacyKind,
				"",
				input.internalId,
				input.clientSector,
				handle,
			);
			const stored = db
				.prepare(
					`SELECT handle FROM pairwise_identity_handles
        WHERE issuer=? AND client_sector=? AND kind=? AND subject_id=? AND internal_id=? AND scheme='v1'`,
				)
				.get<{ handle: string }>(
					input.issuer,
					input.clientSector,
					legacyKind,
					identity.subjectId,
					input.internalId,
				);
			if (!stored?.handle)
				throw new Error("Pairwise identity persistence failed");
			return stored.handle;
		})
		.immediate();
}

export interface PairwiseInstanceHandleLookupInput {
	clientId: string;
	clientSector: string;
	instanceHandle: string;
	issuer: string;
	subjectId: string;
}

export interface PairwiseInstanceHandleLookupResult {
	internalId: string;
	retainedSourceId: string;
}

/** Resolves only an already-issued handle; a miss never derives or persists one. */
export async function lookupPairwiseInstanceMapping(
	input: PairwiseInstanceHandleLookupInput,
): Promise<PairwiseInstanceHandleLookupResult | null> {
	requireNonEmptyString(input.clientId, "client ID");
	requireNonEmptyString(input.clientSector, "client sector");
	requireNonEmptyString(input.instanceHandle, "instance handle");
	requireNonEmptyString(input.issuer, "issuer");
	requireNonEmptyString(input.subjectId, "subject ID");

	if (isPostgresStorageBackend()) {
		return withPostgresTransaction(async (client) => {
			await client.query(
				"LOCK TABLE pairwise_identity_deployment IN SHARE MODE",
			);
			const configured = await client.query<{ issuer: string }>(
				"SELECT issuer FROM pairwise_identity_deployment WHERE singleton_id=1",
			);
			if (configured.rows[0]?.issuer !== input.issuer) {
				throw new PairwiseIdentityDeploymentError(
					"Configured issuer changed; record an issuer migration first",
				);
			}
			const foreign = await client.query(
				`SELECT 1 FROM pairwise_identity_root_keys WHERE issuer<>$1
				 UNION ALL SELECT 1 FROM pairwise_identity_handles WHERE issuer<>$1
				 UNION ALL SELECT 1 FROM pairwise_trusted_client_sectors WHERE issuer<>$1
				 UNION ALL SELECT 1 FROM pairwise_identity_legacy_backfills WHERE issuer<>$1 LIMIT 1`,
				[input.issuer],
			);
			if (foreign.rowCount) {
				throw new PairwiseIdentityDeploymentError(
					"Identity state exists outside the configured issuer",
				);
			}
			await assertPairwiseLookupMembership(client, input);
			const match = await client.query<{
				internal_id: string;
				source_id: string;
				scheme: string;
			}>(
				`SELECT h.internal_id,h.source_id,h.scheme FROM pairwise_identity_handles h
				 LEFT JOIN pairwise_trusted_client_sectors m
				   ON m.issuer=h.issuer AND m.client_id=h.client_id
				WHERE h.issuer=$1 AND h.kind='instance' AND h.subject_id=$2
				  AND h.handle=$3 AND (
				    (h.scheme='v1' AND h.client_sector=$4) OR
				    (h.scheme='legacy' AND m.client_sector=$4)
				  )`,
				[
					input.issuer,
					input.subjectId,
					input.instanceHandle,
					input.clientSector,
				],
			);
			const row = match.rows[0];
			if (!row) return null;
			if (row.scheme === "v1") {
				const key = await client.query<{
					key_version: number;
					root_key_hex: string;
				}>(
					"SELECT key_version,root_key_hex FROM pairwise_identity_root_keys WHERE issuer=$1",
					[input.issuer],
				);
				if (key.rows[0]?.key_version !== ROOT_KEY_VERSION) {
					throw new Error(
						"Pairwise identity root key is missing or unavailable",
					);
				}
				validRootKey(key.rows[0].root_key_hex);
			}
			if (row.scheme === "legacy") {
				await assertUnambiguousLegacyLookup(client, input, row);
			}
			return {
				internalId: row.internal_id,
				retainedSourceId: row.source_id,
			};
		});
	}

	const db = getDb();
	return db
		.transaction(() => {
			assertConfiguredIssuerSqlite(db, input.issuer);
			const member = db
				.prepare(
					"SELECT client_sector FROM pairwise_trusted_client_sectors WHERE issuer=? AND client_id=?",
				)
				.get<{ client_sector: string }>(input.issuer, input.clientId);
			if (member?.client_sector !== input.clientSector) {
				throw new PairwiseIdentityContextError(
					"Trusted client sector membership is missing or mismatched",
				);
			}
			assertCompletePairwiseLookupBackfillSqlite(db, input.issuer);
			const row = db
				.prepare(
					`SELECT h.internal_id,h.source_id,h.scheme FROM pairwise_identity_handles h
				 LEFT JOIN pairwise_trusted_client_sectors m
				   ON m.issuer=h.issuer AND m.client_id=h.client_id
				WHERE h.issuer=? AND h.kind='instance' AND h.subject_id=?
				  AND h.handle=? AND (
				    (h.scheme='v1' AND h.client_sector=?) OR
				    (h.scheme='legacy' AND m.client_sector=?)
				  )`,
				)
				.get<{ internal_id: string; source_id: string; scheme: string }>(
					input.issuer,
					input.subjectId,
					input.instanceHandle,
					input.clientSector,
					input.clientSector,
				);
			if (!row) return null;
			if (row.scheme === "v1") rootKeyForIssuerSync(input.issuer);
			if (row.scheme === "legacy") {
				assertUnambiguousLegacyLookupSqlite(db, input, row);
			}
			return {
				internalId: row.internal_id,
				retainedSourceId: row.source_id,
			};
		})
		.immediate();
}

async function assertPairwiseLookupMembership(
	client: PostgresTransactionClient,
	input: PairwiseInstanceHandleLookupInput,
): Promise<void> {
	const member = await client.query<{ client_sector: string }>(
		"SELECT client_sector FROM pairwise_trusted_client_sectors WHERE issuer=$1 AND client_id=$2",
		[input.issuer, input.clientId],
	);
	if (member.rows[0]?.client_sector !== input.clientSector) {
		throw new PairwiseIdentityContextError(
			"Trusted client sector membership is missing or mismatched",
		);
	}
	const marker = await client.query(
		"SELECT 1 FROM pairwise_identity_legacy_backfills WHERE issuer=$1",
		[input.issuer],
	);
	if (marker.rowCount) return;
	const missing = await client.query(
		`SELECT 1 FROM pairwise_identity_handles h LEFT JOIN pairwise_trusted_client_sectors m
		   ON m.issuer=h.issuer AND m.client_id=h.client_id
		 WHERE h.issuer=$1 AND h.scheme='legacy' AND m.client_id IS NULL LIMIT 1`,
		[input.issuer],
	);
	if (missing.rowCount) {
		throw new PairwiseIdentityDeploymentError(
			"Legacy client-sector backfill is incomplete",
		);
	}
}

async function assertUnambiguousLegacyLookup(
	client: PostgresTransactionClient,
	input: PairwiseInstanceHandleLookupInput,
	row: { internal_id: string; scheme: string },
): Promise<void> {
	const aliases = await client.query(
		`SELECT 1 FROM pairwise_identity_handles h
		 JOIN pairwise_trusted_client_sectors m ON m.issuer=h.issuer AND m.client_id=h.client_id
		 WHERE h.issuer=$1 AND m.client_sector=$2 AND h.kind='instance'
		   AND h.subject_id=$3 AND h.internal_id=$4 AND h.scheme='legacy'
		 GROUP BY h.internal_id HAVING count(DISTINCT h.handle)>1 LIMIT 1`,
		[input.issuer, input.clientSector, input.subjectId, row.internal_id],
	);
	if (aliases.rowCount) {
		throw new PairwiseIdentityContextError(
			"Ambiguous legacy pairwise identity mapping",
		);
	}
}

function assertCompletePairwiseLookupBackfillSqlite(
	db: ReturnType<typeof getDb>,
	issuer: string,
): void {
	const marker = db
		.prepare("SELECT 1 FROM pairwise_identity_legacy_backfills WHERE issuer=?")
		.get(issuer);
	if (marker) return;
	const missing = db
		.prepare(
			`SELECT 1 FROM pairwise_identity_handles h LEFT JOIN pairwise_trusted_client_sectors m
			   ON m.issuer=h.issuer AND m.client_id=h.client_id
			 WHERE h.issuer=? AND h.scheme='legacy' AND m.client_id IS NULL LIMIT 1`,
		)
		.get(issuer);
	if (missing) {
		throw new PairwiseIdentityDeploymentError(
			"Legacy client-sector backfill is incomplete",
		);
	}
}

function assertUnambiguousLegacyLookupSqlite(
	db: ReturnType<typeof getDb>,
	input: PairwiseInstanceHandleLookupInput,
	row: { internal_id: string; scheme: string },
): void {
	const aliases = db
		.prepare(
			`SELECT 1 FROM pairwise_identity_handles h
			 JOIN pairwise_trusted_client_sectors m ON m.issuer=h.issuer AND m.client_id=h.client_id
			 WHERE h.issuer=? AND m.client_sector=? AND h.kind='instance'
			   AND h.subject_id=? AND h.internal_id=? AND h.scheme='legacy'
			 GROUP BY h.internal_id HAVING count(DISTINCT h.handle)>1 LIMIT 1`,
		)
		.get(input.issuer, input.clientSector, input.subjectId, row.internal_id);
	if (aliases) {
		throw new PairwiseIdentityContextError(
			"Ambiguous legacy pairwise identity mapping",
		);
	}
}

export interface PairwiseGrant {
	client: { client_id: string };
	grantors?: { capacity: string; id: string }[];
	source: { id: string };
	streams: { instance_ids?: string[]; name: string }[];
	subject: { id: string };
}

export interface PairwiseGrantIdentityContext {
	issuer: string;
	resolveClientSector(clientId: string): string;
}

/**
 * MCP contract: grant + internal subject ID + trusted AS issuer/sector resolver.
 * New grants use v1 identifiers; old grants retain their persisted public values.
 */
export async function projectPairwiseGrant<T extends PairwiseGrant>(
	grant: T,
	internalSubjectId: string,
	context: PairwiseGrantIdentityContext,
): Promise<T> {
	const projected = structuredClone(grant);
	const scope = {
		clientId: grant.client.client_id,
		clientSector: context.resolveClientSector(grant.client.client_id),
		issuer: context.issuer,
		subjectId: internalSubjectId,
	};
	projected.subject.id = await getPairwiseV1Handle({
		...scope,
		internalId: internalSubjectId,
		kind: "subject",
	});
	if (projected.grantors) {
		await Promise.all(
			projected.grantors.map(async (grantor) => {
				grantor.id = await getPairwiseV1Handle({
					...scope,
					internalId: grantor.id,
					kind: "grantor",
				});
			}),
		);
	}
	await Promise.all(
		projected.streams.map(async (stream) => {
			if (!stream.instance_ids) {
				return;
			}
			stream.instance_ids = await Promise.all(
				stream.instance_ids.map((internalId) =>
					getPairwiseV1Handle({
						...scope,
						internalId,
						kind: "instance",
						sourceId: grant.source.id,
					}),
				),
			);
		}),
	);
	return projected;
}

export interface PairwiseInstanceBinding {
	grant_id?: string;
	instance_id: string;
	rs_instance: string;
	source_id: string;
	stream?: string;
}

const VALIDATED_BINDINGS = Symbol("validated pairwise instance bindings");
export type ValidatedPairwiseInstanceBindings =
	readonly PairwiseInstanceBinding[] & {
		readonly [VALIDATED_BINDINGS]: true;
	};

/** Validates and copies the AS-authenticated binding array for RS-only translation. */
export function validatePairwiseInstanceBindings(
	bindings: readonly PairwiseInstanceBinding[],
): ValidatedPairwiseInstanceBindings {
	if (!Array.isArray(bindings)) {
		throw new PairwiseIdentityContextError("Invalid instance bindings");
	}
	const handleSources = new Map<string, string>();
	const sourceInstances = new Map<string, string>();
	const instanceHandles = new Map<string, string>();
	const contexts = new Map<string, string>();
	let hasGrantId: boolean | undefined;
	for (const candidate of bindings as readonly unknown[]) {
		if (!candidate || typeof candidate !== "object") {
			throw new PairwiseIdentityContextError("Invalid instance binding");
		}
		const binding = candidate as PairwiseInstanceBinding;
		const bindingHasGrantId = "grant_id" in binding;
		if (hasGrantId !== undefined && hasGrantId !== bindingHasGrantId) {
			throw new PairwiseIdentityContextError(
				"Mixed Core and package instance bindings",
			);
		}
		hasGrantId = bindingHasGrantId;
		if (
			typeof binding.source_id !== "string" ||
			binding.source_id.length === 0 ||
			typeof binding.instance_id !== "string" ||
			binding.instance_id.length === 0 ||
			typeof binding.rs_instance !== "string" ||
			binding.rs_instance.length === 0 ||
			("stream" in binding &&
				(typeof binding.stream !== "string" || binding.stream.length === 0)) ||
			("grant_id" in binding &&
				(typeof binding.grant_id !== "string" || binding.grant_id.length === 0))
		) {
			throw new PairwiseIdentityContextError("Invalid instance binding");
		}
		const priorSource = handleSources.get(binding.instance_id);
		if (priorSource && priorSource !== binding.source_id) {
			throw new PairwiseIdentityContextError(
				"Conflicting cross-source instance binding",
			);
		}
		handleSources.set(binding.instance_id, binding.source_id);
		const sourceInstance = JSON.stringify([
			binding.source_id,
			binding.instance_id,
		]);
		const priorRsInstance = sourceInstances.get(sourceInstance);
		if (priorRsInstance && priorRsInstance !== binding.rs_instance) {
			throw new PairwiseIdentityContextError("Conflicting instance binding");
		}
		sourceInstances.set(sourceInstance, binding.rs_instance);
		const instanceHandleKey = JSON.stringify([
			binding.source_id,
			binding.rs_instance,
		]);
		const priorHandle = instanceHandles.get(instanceHandleKey);
		if (priorHandle && priorHandle !== binding.instance_id) {
			throw new PairwiseIdentityContextError("Conflicting instance binding");
		}
		instanceHandles.set(instanceHandleKey, binding.instance_id);
		const key = JSON.stringify([
			binding.grant_id ?? "",
			binding.source_id,
			binding.stream ?? "",
			binding.instance_id,
		]);
		if (contexts.has(key)) {
			throw new PairwiseIdentityContextError("Duplicate instance binding");
		}
		contexts.set(key, binding.rs_instance);
	}
	const copied = bindings.map((binding) =>
		Object.freeze({ ...binding }),
	) as PairwiseInstanceBinding[] & {
		[VALIDATED_BINDINGS]: true;
	};
	Object.defineProperty(copied, VALIDATED_BINDINGS, { value: true });
	return Object.freeze(copied);
}

function validatedBindings(
	bindings: readonly PairwiseInstanceBinding[],
): ValidatedPairwiseInstanceBindings {
	return bindings != null &&
		(bindings as ValidatedPairwiseInstanceBindings)[VALIDATED_BINDINGS] === true
		? (bindings as ValidatedPairwiseInstanceBindings)
		: validatePairwiseInstanceBindings(bindings);
}

export function clientVisibleInstanceId(
	rsInstance: string,
	bindings: readonly PairwiseInstanceBinding[],
	sourceId: string,
	stream: string,
): string {
	requireNonEmptyString(stream, "stream");
	const safeBindings = validatedBindings(bindings);
	const matches = safeBindings.filter(
		(binding) =>
			binding.rs_instance === rsInstance &&
			binding.source_id === sourceId &&
			binding.stream === stream,
	);
	const visibleIds = [
		...new Set(matches.map((binding) => binding.instance_id)),
	];
	if (visibleIds.length !== 1) {
		throw new PairwiseIdentityContextError(
			"Instance has no unique authenticated client binding",
		);
	}
	return visibleIds[0] as string;
}

export function resolveInternalInstanceId(
	clientVisibleId: string,
	bindings: readonly PairwiseInstanceBinding[],
	sourceId: string,
	stream: string,
): string {
	requireNonEmptyString(stream, "stream");
	const safeBindings = validatedBindings(bindings);
	const matches = safeBindings.filter(
		(binding) =>
			binding.instance_id === clientVisibleId &&
			binding.source_id === sourceId &&
			binding.stream === stream,
	);
	const rsInstances = [
		...new Set(matches.map((binding) => binding.rs_instance)),
	];
	if (rsInstances.length !== 1) {
		throw new PairwiseIdentityContextError(
			"Instance handle has no unique authenticated binding",
		);
	}
	return rsInstances[0] as string;
}
