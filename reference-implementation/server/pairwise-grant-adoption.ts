// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { getDb } from "./db.ts";
import type { PairwiseInstanceBinding } from "./pairwise-identity.ts";
import {
	getPostgresPool,
	isPostgresStorageBackend,
	postgresQuery,
} from "./postgres-storage.ts";
import { snapshotSourceDeclaration } from "./source-declaration.ts";

const VERSION = "legacy_expiry_v1";
const DDL = `
CREATE TABLE IF NOT EXISTS pairwise_as_grant_adoption_receipts (
  issuer TEXT NOT NULL,
  grant_id TEXT NOT NULL PRIMARY KEY,
  client_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  tuple_count INTEGER NOT NULL CHECK (tuple_count > 0),
  tuple_sha256 TEXT NOT NULL,
  completed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pairwise_as_grant_instance_adoptions (
  issuer TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  stream TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  rs_instance TEXT NOT NULL,
  declaration_version TEXT NOT NULL,
  PRIMARY KEY (issuer, grant_id, source_id, stream, instance_id),
  FOREIGN KEY (grant_id) REFERENCES pairwise_as_grant_adoption_receipts(grant_id)
);
CREATE INDEX IF NOT EXISTS idx_pairwise_as_grant_instance_adoptions_scope
  ON pairwise_as_grant_instance_adoptions(issuer, client_id, subject_id, grant_id);
`;

const SQLITE_IMMUTABILITY = `
CREATE TRIGGER IF NOT EXISTS pairwise_as_grant_adoptions_no_update
BEFORE UPDATE ON pairwise_as_grant_instance_adoptions
BEGIN SELECT RAISE(ABORT, 'pairwise grant adoption is immutable'); END;
CREATE TRIGGER IF NOT EXISTS pairwise_as_grant_adoptions_no_delete
BEFORE DELETE ON pairwise_as_grant_instance_adoptions
BEGIN SELECT RAISE(ABORT, 'pairwise grant adoption is immutable'); END;
CREATE TRIGGER IF NOT EXISTS pairwise_as_grant_receipts_no_update
BEFORE UPDATE ON pairwise_as_grant_adoption_receipts
BEGIN SELECT RAISE(ABORT, 'pairwise grant adoption receipt is immutable'); END;
CREATE TRIGGER IF NOT EXISTS pairwise_as_grant_receipts_no_delete
BEFORE DELETE ON pairwise_as_grant_adoption_receipts
BEGIN SELECT RAISE(ABORT, 'pairwise grant adoption receipt is immutable'); END;
`;

type SqlRow = Record<string, unknown>;
type Tuple = {
	declaration_version: string;
	instance_id: string;
	rs_instance: string;
	source_id: string;
	stream: string;
};
type GrantRow = {
	client_id: string;
	grant_id: string;
	grant_json: string;
	public_subject_id: string | null;
	storage_binding_json: string | null;
	subject_id: string;
};

function json(value: unknown, label: string): Record<string, unknown> {
	let parsed = value;
	if (typeof value === "string") {
		try {
			parsed = JSON.parse(value);
		} catch {
			throw new Error(`Pairwise grant adoption has invalid ${label}`);
		}
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`Pairwise grant adoption has invalid ${label}`);
	}
	return parsed as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`Pairwise grant adoption has invalid ${label}`);
	}
	return value;
}

function grantRecord(row: GrantRow): Record<string, unknown> {
	return json(row.grant_json, "persisted grant");
}

function bindingConnectorId(value: unknown): string {
	const binding = json(value, "storage binding");
	return text(binding.connector_id, "storage connector");
}

function stringList(value: unknown, label: string): string[] {
	let parsed = value;
	if (typeof parsed === "string") {
		try {
			parsed = JSON.parse(parsed);
		} catch {
			throw new Error(`Pairwise grant adoption has invalid ${label}`);
		}
	}
	if (
		!Array.isArray(parsed) ||
		parsed.some((item) => typeof item !== "string" || item.length === 0)
	) {
		throw new Error(`Pairwise grant adoption has invalid ${label}`);
	}
	return parsed;
}

function retainedSourceMatches(
	instance: SqlRow,
	tuple: Omit<Tuple, "rs_instance">,
): boolean {
	if (instance.canonical_source_id === tuple.source_id) return true;
	return stringList(
		instance.accepted_legacy_source_aliases_json,
		"accepted source aliases",
	).includes(tuple.source_id);
}

function retainedHandleMatches(
	proof: SqlRow,
	row: GrantRow,
	requestedSector: unknown,
	ownerSector: unknown,
): boolean {
	const ledgerSector = proof.client_sector;
	const trustedSector =
		typeof requestedSector === "string" &&
		requestedSector.length > 0 &&
		typeof ledgerSector === "string" &&
		ledgerSector.length > 0 &&
		ledgerSector === requestedSector;
	const trustedPeerSector =
		typeof requestedSector === "string" &&
		requestedSector.length > 0 &&
		typeof ownerSector === "string" &&
		ownerSector.length > 0 &&
		ownerSector === requestedSector;
	const exactClient =
		proof.client_id === row.client_id &&
		(proof.scheme === "v1" ? trustedSector : !ledgerSector || trustedSector);
	return (
		exactClient ||
		(proof.scheme === "legacy" ? trustedPeerSector : trustedSector)
	);
}

function sortedTuples(tuples: readonly Tuple[]): Tuple[] {
	return [...tuples].sort((a, b) => {
		const left = JSON.stringify(a);
		const right = JSON.stringify(b);
		return left < right ? -1 : left > right ? 1 : 0;
	});
}

function publicTupleKey(tuple: Omit<Tuple, "rs_instance">): string {
	return JSON.stringify([
		tuple.source_id,
		tuple.stream,
		tuple.instance_id,
		tuple.declaration_version,
	]);
}

function tupleHash(tuples: readonly Tuple[]): string {
	const canonical = tuples.map((tuple) => ({
		declaration_version: tuple.declaration_version,
		instance_id: tuple.instance_id,
		source_id: tuple.source_id,
		stream: tuple.stream,
		rs_instance: tuple.rs_instance,
	}));
	return createHash("sha256")
		.update(JSON.stringify(sortedTuples(canonical)))
		.digest("hex");
}

function expectedTuples(row: GrantRow): Omit<Tuple, "rs_instance">[] {
	const grant = grantRecord(row);
	const client = json(grant.client, "grant client");
	const subject = json(grant.subject, "grant subject");
	const source = json(grant.source, "grant source");
	const sourceDeclaration = json(
		grant.source_declaration,
		"grant source declaration",
	);
	if (
		grant.grant_id !== row.grant_id ||
		client.client_id !== row.client_id ||
		(row.public_subject_id !== null &&
			row.public_subject_id !== undefined &&
			row.public_subject_id !== subject.id)
	) {
		throw new Error("Pairwise grant adoption persisted grant binding mismatch");
	}
	const sourceId = text(source.id, "canonical source");
	const declarationVersion = text(
		sourceDeclaration.version,
		"pinned declaration version",
	);
	if (!Array.isArray(grant.streams) || grant.streams.length === 0) {
		throw new Error("Pairwise grant adoption has no streams");
	}
	const tuples: Omit<Tuple, "rs_instance">[] = [];
	const seen = new Set<string>();
	for (const rawStream of grant.streams) {
		const stream = json(rawStream, "grant stream");
		const streamName = text(stream.name, "stream");
		if (
			!Array.isArray(stream.instance_ids) ||
			stream.instance_ids.length === 0
		) {
			throw new Error(
				"Pairwise grant adoption has an empty stream instance set",
			);
		}
		for (const rawInstanceId of stream.instance_ids) {
			const instanceId = text(rawInstanceId, "public instance ID");
			const key = JSON.stringify([sourceId, streamName, instanceId]);
			if (seen.has(key))
				throw new Error(
					"Pairwise grant adoption has a duplicate approved tuple",
				);
			seen.add(key);
			tuples.push({
				declaration_version: declarationVersion,
				instance_id: instanceId,
				source_id: sourceId,
				stream: streamName,
			});
		}
	}
	return tuples.sort((a, b) => {
		const left = publicTupleKey(a);
		const right = publicTupleKey(b);
		return left < right ? -1 : left > right ? 1 : 0;
	});
}

async function rowsForGrant(
	grantId: string,
): Promise<{ grant: GrantRow | undefined; eligible: boolean }> {
	if (isPostgresStorageBackend()) {
		const [grant, cohort] = await Promise.all([
			postgresQuery<GrantRow>(
				"SELECT grant_id,subject_id,public_subject_id,client_id,storage_binding_json,grant_json FROM grants WHERE grant_id=$1",
				[grantId],
			),
			postgresQuery(
				"SELECT 1 FROM as_issuance_cohort c JOIN as_issuance_cutover m ON m.version=c.version WHERE m.version=$1 AND c.kind='grant' AND c.row_id=$2 AND c.enrollment='cutover'",
				[VERSION, grantId],
			),
		]);
		return { grant: grant.rows[0], eligible: cohort.rows.length === 1 };
	}
	const grant = getDb()
		.prepare(
			"SELECT grant_id,subject_id,public_subject_id,client_id,storage_binding_json,grant_json FROM grants WHERE grant_id=?",
		)
		.get<GrantRow>(grantId);
	const cohort = getDb()
		.prepare(
			"SELECT 1 FROM as_issuance_cohort c JOIN as_issuance_cutover m ON m.version=c.version WHERE m.version=? AND c.kind='grant' AND c.row_id=? AND c.enrollment='cutover'",
		)
		.all(VERSION, grantId);
	return { grant, eligible: cohort.length === 1 };
}

async function validateAuthority(
	issuer: string,
	row: GrantRow,
	tuple: Omit<Tuple, "rs_instance">,
	query: <T extends SqlRow = SqlRow>(
		sql: string,
		params?: unknown[],
	) => Promise<T[]>,
): Promise<string> {
	const connectorId = bindingConnectorId(row.storage_binding_json);
	let internalId = tuple.instance_id;
	let instance: SqlRow | undefined;
	if (isPostgresStorageBackend()) {
		const ledger = await query<SqlRow>(
			`SELECT h.client_id,h.client_sector,h.source_id,h.internal_id,h.scheme,
			        s.client_sector AS requested_client_sector, o.client_sector AS owner_client_sector
			   FROM pairwise_identity_handles h
			   LEFT JOIN pairwise_trusted_client_sectors s ON s.issuer=h.issuer AND s.client_id=$2
			LEFT JOIN pairwise_trusted_client_sectors o ON o.issuer=h.issuer AND o.client_id=h.client_id
			  WHERE h.issuer=$1 AND h.subject_id=$3 AND h.kind='instance' AND h.handle=$4`,
			[issuer, row.client_id, row.subject_id, tuple.instance_id],
		);
		if (ledger.length > 1)
			throw new Error("Pairwise grant adoption handle is ambiguous");
		if (ledger[0]) {
			const proof = ledger[0];
			const sourceMatches =
				proof.source_id === tuple.source_id ||
				(proof.scheme === "v1" && proof.source_id === "");
			if (
				!sourceMatches ||
				!retainedHandleMatches(
					proof,
					row,
					proof.requested_client_sector,
					proof.owner_client_sector,
				)
			)
				throw new Error(
					"Pairwise grant adoption retained handle scope conflicts with grant",
				);
			internalId = text(proof.internal_id, "retained internal instance ID");
		}
		const result = await query<SqlRow>(
			`SELECT i.connector_instance_id, i.owner_subject_id, i.connector_id, i.source_binding_key,
			        i.source_binding_json, c.manifest,
			        a.canonical_source_id, a.declaration_version,
			        a.accepted_legacy_source_aliases_json::text AS accepted_legacy_source_aliases_json,
			        EXISTS (SELECT 1 FROM pairwise_as_instance_authority_versions ax
			                 WHERE ax.subject_id=i.owner_subject_id
			                   AND ax.internal_instance_id=i.connector_instance_id) AS has_authority_versions
			   FROM connector_instances i JOIN connectors c ON c.connector_id=i.connector_id
			   LEFT JOIN pairwise_as_instance_authority_versions a
			     ON a.subject_id=i.owner_subject_id AND a.internal_instance_id=i.connector_instance_id
			    AND a.declaration_version=$4
			  WHERE i.connector_instance_id=$1 AND i.owner_subject_id=$2 AND i.connector_id=$3`,
			[internalId, row.subject_id, connectorId, tuple.declaration_version],
		);
		instance = result[0];
	} else {
		const ledger = getDb()
			.prepare(
				`SELECT h.client_id,h.client_sector,h.source_id,h.internal_id,h.scheme,
			        s.client_sector AS requested_client_sector, o.client_sector AS owner_client_sector
			   FROM pairwise_identity_handles h
			   LEFT JOIN pairwise_trusted_client_sectors s ON s.issuer=h.issuer AND s.client_id=?
			   LEFT JOIN pairwise_trusted_client_sectors o ON o.issuer=h.issuer AND o.client_id=h.client_id
			  WHERE h.issuer=? AND h.subject_id=? AND h.kind='instance' AND h.handle=?`,
			)
			.all<SqlRow>(row.client_id, issuer, row.subject_id, tuple.instance_id);
		if (ledger.length > 1)
			throw new Error("Pairwise grant adoption handle is ambiguous");
		if (ledger[0]) {
			const proof = ledger[0];
			const sourceMatches =
				proof.source_id === tuple.source_id ||
				(proof.scheme === "v1" && proof.source_id === "");
			if (
				!sourceMatches ||
				!retainedHandleMatches(
					proof,
					row,
					proof.requested_client_sector,
					proof.owner_client_sector,
				)
			)
				throw new Error(
					"Pairwise grant adoption retained handle scope conflicts with grant",
				);
			internalId = text(proof.internal_id, "retained internal instance ID");
		}
		instance = getDb()
			.prepare(
				`SELECT i.connector_instance_id, i.owner_subject_id, i.connector_id, i.source_binding_key,
			        i.source_binding_json, c.manifest,
				        a.canonical_source_id, a.declaration_version,
				        a.accepted_legacy_source_aliases_json
			   FROM connector_instances i JOIN connectors c ON c.connector_id=i.connector_id
			   LEFT JOIN pairwise_as_instance_authority_versions a
			     ON a.subject_id=i.owner_subject_id AND a.internal_instance_id=i.connector_instance_id
			    AND a.declaration_version=?
			  WHERE i.connector_instance_id=? AND i.owner_subject_id=? AND i.connector_id=?`,
			)
			.get<SqlRow>(
				tuple.declaration_version,
				internalId,
				row.subject_id,
				connectorId,
			);
	}
	if (
		!instance ||
		instance.connector_id !== connectorId ||
		!instance.source_binding_key
	) {
		throw new Error(
			"Pairwise grant adoption lacks exact retained instance authority",
		);
	}
	json(instance.source_binding_json, "connector storage binding");
	if (
		instance.declaration_version !== null &&
		instance.declaration_version !== undefined
	) {
		if (
			!retainedSourceMatches(instance, tuple) ||
			instance.declaration_version !== tuple.declaration_version
		)
			throw new Error(
				"Pairwise grant adoption retained source authority conflicts with pinned declaration",
			);
		return internalId;
	}
	if (
		instance.has_authority_versions === true ||
		instance.has_authority_versions === 1
	) {
		throw new Error(
			"Pairwise grant adoption has a retained source authority version that differs from the pinned declaration",
		);
	}
	const manifest = json(instance.manifest, "stored connector manifest");
	if (!manifest.source_declaration) {
		throw new Error(
			"Pairwise grant adoption lacks the pinned stored source declaration",
		);
	}
	const declaration = snapshotSourceDeclaration(manifest.source_declaration);
	if (
		declaration.source.kind !== "connector" ||
		declaration.source.id !== tuple.source_id ||
		declaration.declaration_version !== tuple.declaration_version
	) {
		throw new Error(
			"Pairwise grant adoption stored declaration does not match pinned authority",
		);
	}
	return internalId;
}

function validateSqliteAuthority(
	issuer: string,
	row: GrantRow,
	tuple: Omit<Tuple, "rs_instance">,
): string {
	const db = getDb();
	const connectorId = bindingConnectorId(row.storage_binding_json);
	const ledger = db
		.prepare(
			`SELECT h.client_id,h.client_sector,h.source_id,h.internal_id,h.scheme,
			        s.client_sector AS requested_client_sector, o.client_sector AS owner_client_sector
		   FROM pairwise_identity_handles h
		   LEFT JOIN pairwise_trusted_client_sectors s ON s.issuer=h.issuer AND s.client_id=?
			   LEFT JOIN pairwise_trusted_client_sectors o ON o.issuer=h.issuer AND o.client_id=h.client_id
		  WHERE h.issuer=? AND h.subject_id=? AND h.kind='instance' AND h.handle=?`,
		)
		.all<SqlRow>(row.client_id, issuer, row.subject_id, tuple.instance_id);
	if (ledger.length > 1)
		throw new Error("Pairwise grant adoption handle is ambiguous");
	let internalId = tuple.instance_id;
	if (ledger[0]) {
		const proof = ledger[0];
		const sourceMatches =
			proof.source_id === tuple.source_id ||
			(proof.scheme === "v1" && proof.source_id === "");
		if (
			!sourceMatches ||
			!retainedHandleMatches(
				proof,
				row,
				proof.requested_client_sector,
				proof.owner_client_sector,
			)
		)
			throw new Error(
				"Pairwise grant adoption retained handle scope conflicts with grant",
			);
		internalId = text(proof.internal_id, "retained internal instance ID");
	}
	const instance = db
		.prepare(
			`SELECT i.source_binding_key,i.source_binding_json,c.manifest,a.canonical_source_id,a.declaration_version,
		        a.accepted_legacy_source_aliases_json,
		        EXISTS (SELECT 1 FROM pairwise_as_instance_authority_versions ax
		                 WHERE ax.subject_id=i.owner_subject_id
		                   AND ax.internal_instance_id=i.connector_instance_id) AS has_authority_versions
		   FROM connector_instances i JOIN connectors c ON c.connector_id=i.connector_id
		   LEFT JOIN pairwise_as_instance_authority_versions a
		     ON a.subject_id=i.owner_subject_id AND a.internal_instance_id=i.connector_instance_id AND a.declaration_version=?
		  WHERE i.connector_instance_id=? AND i.owner_subject_id=? AND i.connector_id=?`,
		)
		.get<SqlRow>(
			tuple.declaration_version,
			internalId,
			row.subject_id,
			connectorId,
		);
	if (!instance?.source_binding_key)
		throw new Error(
			"Pairwise grant adoption lacks exact retained instance authority",
		);
	json(instance.source_binding_json, "connector storage binding");
	if (
		instance.declaration_version !== null &&
		instance.declaration_version !== undefined
	) {
		if (
			!retainedSourceMatches(instance, tuple) ||
			instance.declaration_version !== tuple.declaration_version
		)
			throw new Error(
				"Pairwise grant adoption retained source authority conflicts with pinned declaration",
			);
		return internalId;
	}
	if (
		instance.has_authority_versions === true ||
		instance.has_authority_versions === 1
	)
		throw new Error(
			"Pairwise grant adoption has a retained source authority version that differs from the pinned declaration",
		);
	const manifest = json(instance.manifest, "stored connector manifest");
	if (!manifest.source_declaration)
		throw new Error(
			"Pairwise grant adoption lacks the pinned stored source declaration",
		);
	const declaration = snapshotSourceDeclaration(manifest.source_declaration);
	if (
		declaration.source.kind !== "connector" ||
		declaration.source.id !== tuple.source_id ||
		declaration.declaration_version !== tuple.declaration_version
	)
		throw new Error(
			"Pairwise grant adoption stored declaration does not match pinned authority",
		);
	return internalId;
}

function createSchemaSqlite(): void {
	const db = getDb();
	const names = db
		.prepare(
			"SELECT name FROM sqlite_master WHERE type='table' AND name IN ('pairwise_as_grant_adoption_receipts','pairwise_as_grant_instance_adoptions')",
		)
		.all<{ name: string }>();
	if (names.length !== 0 && names.length !== 2)
		throw new Error("Pairwise grant adoption schema is incomplete");
	db.exec(DDL);
	db.exec(SQLITE_IMMUTABILITY);
}

async function createSchemaPostgres(client: {
	query(sql: string, params?: unknown[]): Promise<{ rows: SqlRow[] }>;
}): Promise<void> {
	const tables = await client.query(
		"SELECT tablename FROM pg_tables WHERE schemaname=current_schema() AND tablename=ANY($1::text[])",
		[
			[
				"pairwise_as_grant_adoption_receipts",
				"pairwise_as_grant_instance_adoptions",
			],
		],
	);
	if (tables.rows.length !== 0 && tables.rows.length !== 2)
		throw new Error("Pairwise grant adoption schema is incomplete");
	await client.query(DDL);
	await client.query(
		`CREATE OR REPLACE FUNCTION reject_pairwise_as_grant_adoption_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'pairwise grant adoption is immutable'; END $$`,
	);
	await client.query(
		"DROP TRIGGER IF EXISTS pairwise_as_grant_adoptions_immutable ON pairwise_as_grant_instance_adoptions",
	);
	await client.query(
		"CREATE TRIGGER pairwise_as_grant_adoptions_immutable BEFORE UPDATE OR DELETE ON pairwise_as_grant_instance_adoptions FOR EACH ROW EXECUTE FUNCTION reject_pairwise_as_grant_adoption_mutation()",
	);
	await client.query(
		"DROP TRIGGER IF EXISTS pairwise_as_grant_receipts_immutable ON pairwise_as_grant_adoption_receipts",
	);
	await client.query(
		"CREATE TRIGGER pairwise_as_grant_receipts_immutable BEFORE UPDATE OR DELETE ON pairwise_as_grant_adoption_receipts FOR EACH ROW EXECUTE FUNCTION reject_pairwise_as_grant_adoption_mutation()",
	);
}

async function enroll(
	issuer: string,
	client?: {
		query(sql: string, params?: unknown[]): Promise<{ rows: SqlRow[] }>;
	},
): Promise<void> {
	const query = async <T extends SqlRow = SqlRow>(
		sql: string,
		params: unknown[] = [],
	): Promise<T[]> => {
		if (client) return (await client.query(sql, params)).rows as T[];
		return getDb()
			.prepare(sql.replace(/\$\d/g, "?"))
			.all(...params) as T[];
	};
	const insert = async (sql: string, params: unknown[]): Promise<void> => {
		if (client) await client.query(sql, params);
		else
			getDb()
				.prepare(sql.replace(/\$\d/g, "?"))
				.run(...params);
	};
	const authorityQuery = async <T extends SqlRow = SqlRow>(
		sql: string,
		params: unknown[] = [],
	): Promise<T[]> => {
		if (!client)
			throw new Error(
				"Pairwise grant adoption needs its migration transaction client",
			);
		return (await client.query(sql, params)).rows as T[];
	};
	const candidates = await query<GrantRow>(
		`SELECT g.grant_id,g.subject_id,g.public_subject_id,g.client_id,g.storage_binding_json,g.grant_json
		   FROM grants g JOIN as_issuance_cohort c ON c.kind='grant' AND c.row_id=g.grant_id
		   JOIN as_issuance_cutover m ON m.version=c.version
		  WHERE m.version=$1 AND c.enrollment='cutover' ORDER BY g.grant_id`,
		[VERSION],
	);
	for (const row of candidates) {
		const expected = expectedTuples(row);
		const existing = await query<SqlRow>(
			"SELECT issuer,client_id,subject_id,tuple_count,tuple_sha256 FROM pairwise_as_grant_adoption_receipts WHERE grant_id=$1",
			[row.grant_id],
		);
		if (existing.length) {
			if (
				existing[0]?.issuer !== issuer ||
				existing[0]?.client_id !== row.client_id ||
				existing[0]?.subject_id !== row.subject_id ||
				Number(existing[0]?.tuple_count) !== expected.length
			) {
				throw new Error(
					"Pairwise grant adoption receipt contradicts persisted grant",
				);
			}
			const complete = await query<SqlRow>(
				"SELECT issuer,client_id,subject_id,source_id,stream,instance_id,rs_instance,declaration_version FROM pairwise_as_grant_instance_adoptions WHERE grant_id=$1 ORDER BY source_id,stream,instance_id",
				[row.grant_id],
			);
			if (
				!sameTupleRows(
					complete,
					issuer,
					row,
					expected,
					String(existing[0]?.tuple_sha256),
				)
			) {
				throw new Error(
					"Pairwise grant adoption receipt is partial or contradictory",
				);
			}
			continue;
		}
		if (
			(
				await query<SqlRow>(
					"SELECT 1 FROM pairwise_as_grant_instance_adoptions WHERE grant_id=$1",
					[row.grant_id],
				)
			).length > 0
		)
			throw new Error(
				"Pairwise grant adoption mappings have no completion receipt",
			);
		const tuples: Tuple[] = [];
		for (const tuple of expected) {
			tuples.push({
				...tuple,
				rs_instance: await validateAuthority(
					issuer,
					row,
					tuple,
					authorityQuery,
				),
			});
		}
		const hash = tupleHash(tuples);
		await insert(
			"INSERT INTO pairwise_as_grant_adoption_receipts(issuer,grant_id,client_id,subject_id,tuple_count,tuple_sha256,completed_at) VALUES($1,$2,$3,$4,$5,$6,$7)",
			[
				issuer,
				row.grant_id,
				row.client_id,
				row.subject_id,
				tuples.length,
				hash,
				new Date().toISOString(),
			],
		);
		for (const tuple of tuples) {
			await insert(
				`INSERT INTO pairwise_as_grant_instance_adoptions(issuer,grant_id,client_id,subject_id,source_id,stream,instance_id,rs_instance,declaration_version)
				 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,
				[
					issuer,
					row.grant_id,
					row.client_id,
					row.subject_id,
					tuple.source_id,
					tuple.stream,
					tuple.instance_id,
					tuple.rs_instance,
					tuple.declaration_version,
				],
			);
		}
		const actual = await query<SqlRow>(
			"SELECT issuer,client_id,subject_id,source_id,stream,instance_id,rs_instance,declaration_version FROM pairwise_as_grant_instance_adoptions WHERE grant_id=$1 ORDER BY source_id,stream,instance_id",
			[row.grant_id],
		);
		if (!sameTupleRows(actual, issuer, row, expected, hash)) {
			throw new Error(
				"Pairwise grant adoption tuple set is incomplete or contradictory",
			);
		}
	}
}

function sameTupleRows(
	rows: readonly SqlRow[],
	issuer: string,
	grant: GrantRow,
	expected: readonly Omit<Tuple, "rs_instance">[],
	hash: string,
): boolean {
	if (
		rows.length !== expected.length ||
		rows.some(
			(row) =>
				row.issuer !== issuer ||
				row.client_id !== grant.client_id ||
				row.subject_id !== grant.subject_id,
		)
	)
		return false;
	const actual = rows.map((row) => ({
		declaration_version: String(row.declaration_version),
		instance_id: String(row.instance_id),
		rs_instance: String(row.rs_instance),
		source_id: String(row.source_id),
		stream: String(row.stream),
	}));
	const expectedKeys = new Set(expected.map(publicTupleKey));
	const actualKeys = actual.map(publicTupleKey);
	return (
		actualKeys.length === expectedKeys.size &&
		new Set(actualKeys).size === actualKeys.length &&
		actualKeys.every((key) => expectedKeys.has(key)) &&
		tupleHash(actual) === hash
	);
}

function enrollSqlite(issuer: string): void {
	const db = getDb();
	const candidates = db
		.prepare(
			`SELECT g.grant_id,g.subject_id,g.public_subject_id,g.client_id,g.storage_binding_json,g.grant_json
		   FROM grants g JOIN as_issuance_cohort c ON c.kind='grant' AND c.row_id=g.grant_id
		   JOIN as_issuance_cutover m ON m.version=c.version
		  WHERE m.version=? AND c.enrollment='cutover' ORDER BY g.grant_id`,
		)
		.all<GrantRow>(VERSION);
	for (const row of candidates) {
		const expected = expectedTuples(row);
		const prior = db
			.prepare(
				"SELECT issuer,client_id,subject_id,tuple_count,tuple_sha256 FROM pairwise_as_grant_adoption_receipts WHERE grant_id=?",
			)
			.get<SqlRow>(row.grant_id);
		if (
			prior &&
			(prior.issuer !== issuer ||
				prior.client_id !== row.client_id ||
				prior.subject_id !== row.subject_id ||
				Number(prior.tuple_count) !== expected.length)
		) {
			throw new Error(
				"Pairwise grant adoption receipt contradicts persisted grant",
			);
		}
		if (prior) {
			const complete = db
				.prepare(
					"SELECT issuer,client_id,subject_id,source_id,stream,instance_id,rs_instance,declaration_version FROM pairwise_as_grant_instance_adoptions WHERE grant_id=? ORDER BY source_id,stream,instance_id",
				)
				.all<SqlRow>(row.grant_id);
			if (
				!sameTupleRows(
					complete,
					issuer,
					row,
					expected,
					String(prior.tuple_sha256),
				)
			)
				throw new Error(
					"Pairwise grant adoption receipt is partial or contradictory",
				);
			continue;
		}
		if (
			db
				.prepare(
					"SELECT 1 FROM pairwise_as_grant_instance_adoptions WHERE grant_id=?",
				)
				.all(row.grant_id).length > 0
		)
			throw new Error(
				"Pairwise grant adoption mappings have no completion receipt",
			);
		const tuples = expected.map((tuple) => ({
			...tuple,
			rs_instance: validateSqliteAuthority(issuer, row, tuple),
		}));
		const hash = tupleHash(tuples);
		db.prepare(
			"INSERT INTO pairwise_as_grant_adoption_receipts(issuer,grant_id,client_id,subject_id,tuple_count,tuple_sha256,completed_at) VALUES(?,?,?,?,?,?,?)",
		).run(
			issuer,
			row.grant_id,
			row.client_id,
			row.subject_id,
			tuples.length,
			hash,
			new Date().toISOString(),
		);
		const add = db.prepare(
			"INSERT INTO pairwise_as_grant_instance_adoptions(issuer,grant_id,client_id,subject_id,source_id,stream,instance_id,rs_instance,declaration_version) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING",
		);
		for (const tuple of tuples)
			add.run(
				issuer,
				row.grant_id,
				row.client_id,
				row.subject_id,
				tuple.source_id,
				tuple.stream,
				tuple.instance_id,
				tuple.rs_instance,
				tuple.declaration_version,
			);
		const actualRows = db
			.prepare(
				"SELECT issuer,client_id,subject_id,source_id,stream,instance_id,rs_instance,declaration_version FROM pairwise_as_grant_instance_adoptions WHERE grant_id=? ORDER BY source_id,stream,instance_id",
			)
			.all<SqlRow>(row.grant_id);
		if (
			actualRows.some(
				(item) =>
					item.issuer !== issuer ||
					item.client_id !== row.client_id ||
					item.subject_id !== row.subject_id,
			)
		)
			throw new Error(
				"Pairwise grant adoption tuple scope contradicts persisted grant",
			);
		if (!sameTupleRows(actualRows, issuer, row, expected, hash))
			throw new Error(
				"Pairwise grant adoption tuple set is incomplete or contradictory",
			);
	}
}

/** Enroll every exact legacy-expiry grant as one restart-safe startup transaction. */
export async function initializePairwiseGrantAdoption(
	issuer: string,
): Promise<void> {
	text(issuer, "issuer");
	if (isPostgresStorageBackend()) {
		const client = await getPostgresPool().connect();
		let lockHeld = false;
		let transactionOpen = false;
		let failure: unknown;
		try {
			await client.query(
				"SELECT pg_advisory_lock(hashtextextended('pairwise_as_grant_adoption_v1',0))",
			);
			lockHeld = true;
			await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
			transactionOpen = true;
			await createSchemaPostgres(client);
			await enroll(issuer, client);
			await client.query("COMMIT");
			transactionOpen = false;
		} catch (error) {
			if (transactionOpen) {
				try {
					await client.query("ROLLBACK");
				} catch {
					// Preserve the adoption failure while closing the owned transaction.
				}
			}
			failure = error;
		}
		if (lockHeld) {
			try {
				await client.query(
					"SELECT pg_advisory_unlock(hashtextextended('pairwise_as_grant_adoption_v1',0))",
				);
			} catch (error) {
				client.release(error as Error);
				throw failure ?? error;
			}
		}
		client.release();
		if (failure) throw failure;
		return;
	}
	const db = getDb();
	db.transaction(() => {
		createSchemaSqlite();
		enrollSqlite(issuer);
	}).immediate();
}

export type PairwiseGrantAdoptionRead =
	| { status: "not-adopted" }
	| { bindings: readonly PairwiseInstanceBinding[]; status: "adopted" };

type PackageMemberProof = {
	child_client_id: string | null;
	child_grant_id: string | null;
	child_package_id: string | null;
	child_subject_id: string | null;
	child_token_id: string | null;
	child_token_kind: string | null;
	grant_client_id: string | null;
	grant_id: string | null;
	grant_subject_id: string | null;
	member_token_id: string | null;
	package_client_id: string;
	package_subject_id: string;
};

async function packageMemberProofs(
	packageId: string,
	grantId?: string,
): Promise<PackageMemberProof[]> {
	const pg = isPostgresStorageBackend();
	const sql = `SELECT p.client_id AS package_client_id,p.subject_id AS package_subject_id,
	                    m.grant_id,m.token_id AS member_token_id,
	                    g.client_id AS grant_client_id,g.subject_id AS grant_subject_id,
	                    t.token_id AS child_token_id,t.grant_id AS child_grant_id,
	                    t.client_id AS child_client_id,t.subject_id AS child_subject_id,
	                    t.package_id AS child_package_id,t.token_kind AS child_token_kind
	               FROM grant_packages p
	               LEFT JOIN grant_package_members m ON m.package_id=p.package_id
	               LEFT JOIN grants g ON g.grant_id=m.grant_id
	               LEFT JOIN tokens t ON t.token_id=m.token_id
	              WHERE p.package_id=$1${grantId ? " AND m.grant_id=$2" : ""}`;
	if (pg) {
		return (
			await postgresQuery<PackageMemberProof>(
				sql,
				grantId ? [packageId, grantId] : [packageId],
			)
		).rows;
	}
	return getDb()
		.prepare(sql.replace(/\$\d/g, "?"))
		.all<PackageMemberProof>(...(grantId ? [packageId, grantId] : [packageId]));
}

function validPackageMemberProof(
	proof: PackageMemberProof,
	input: { clientId: string; packageId: string; subjectId: string },
): boolean {
	if (
		proof.package_client_id !== input.clientId ||
		proof.package_subject_id !== input.subjectId
	) {
		return false;
	}
	if (proof.grant_id === null) return true;
	return (
		proof.member_token_id !== null &&
		proof.child_token_id === proof.member_token_id &&
		proof.grant_client_id === input.clientId &&
		proof.grant_subject_id === input.subjectId &&
		proof.child_grant_id === proof.grant_id &&
		proof.child_client_id === input.clientId &&
		proof.child_subject_id === input.subjectId &&
		proof.child_token_kind === "client" &&
		(proof.child_package_id === null ||
			proof.child_package_id === input.packageId)
	);
}

/** Verify every package child token once, before the inner-join member read. */
export async function assertPairwiseGrantPackageMemberTokens(input: {
	clientId: string;
	packageId: string;
	subjectId: string;
}): Promise<void> {
	const proofs = await packageMemberProofs(input.packageId);
	if (
		proofs.length === 0 ||
		proofs.some((proof) => !validPackageMemberProof(proof, input))
	) {
		throw new Error("Pairwise grant adoption package child token mismatch");
	}
}

/** Read an exact persisted grant adoption. Package reads also prove actual membership. */
export async function readPairwiseGrantAdoption(input: {
	clientId: string;
	grantId: string;
	issuer: string;
	packageId?: string;
	subjectId: string;
}): Promise<PairwiseGrantAdoptionRead> {
	const { grant, eligible } = await rowsForGrant(input.grantId);
	if (
		!grant ||
		grant.client_id !== input.clientId ||
		grant.subject_id !== input.subjectId
	) {
		throw new Error("Pairwise grant adoption authenticated binding mismatch");
	}
	if (!eligible) return { status: "not-adopted" };
	if (input.packageId) {
		const proofs = await packageMemberProofs(input.packageId, input.grantId);
		if (
			proofs.length !== 1 ||
			!validPackageMemberProof(proofs[0] as PackageMemberProof, {
				clientId: input.clientId,
				packageId: input.packageId,
				subjectId: input.subjectId,
			})
		)
			throw new Error("Pairwise grant adoption package membership mismatch");
	}
	const expected = expectedTuples(grant);
	const [receipt, rows] = isPostgresStorageBackend()
		? await Promise.all([
				postgresQuery<SqlRow>(
					"SELECT issuer,client_id,subject_id,tuple_count,tuple_sha256 FROM pairwise_as_grant_adoption_receipts WHERE issuer=$1 AND grant_id=$2",
					[input.issuer, input.grantId],
				),
				postgresQuery<SqlRow>(
					"SELECT source_id,stream,instance_id,rs_instance,declaration_version FROM pairwise_as_grant_instance_adoptions WHERE issuer=$1 AND client_id=$2 AND subject_id=$3 AND grant_id=$4 ORDER BY source_id,stream,instance_id",
					[input.issuer, input.clientId, input.subjectId, input.grantId],
				),
			])
		: [
				{
					rows: getDb()
						.prepare(
							"SELECT issuer,client_id,subject_id,tuple_count,tuple_sha256 FROM pairwise_as_grant_adoption_receipts WHERE issuer=? AND grant_id=?",
						)
						.all(input.issuer, input.grantId),
				},
				{
					rows: getDb()
						.prepare(
							"SELECT source_id,stream,instance_id,rs_instance,declaration_version FROM pairwise_as_grant_instance_adoptions WHERE issuer=? AND client_id=? AND subject_id=? AND grant_id=? ORDER BY source_id,stream,instance_id",
						)
						.all(input.issuer, input.clientId, input.subjectId, input.grantId),
				},
			];
	const header = receipt.rows[0];
	const actual = sortedTuples(
		rows.rows.map((row) => ({
			declaration_version: String(row.declaration_version),
			instance_id: String(row.instance_id),
			rs_instance: String(row.rs_instance),
			source_id: String(row.source_id),
			stream: String(row.stream),
		})),
	);
	const expectedKeys = new Set(expected.map(publicTupleKey));
	const actualKeys = actual.map(publicTupleKey);
	if (
		!header ||
		header.issuer !== input.issuer ||
		header.client_id !== input.clientId ||
		header.subject_id !== input.subjectId ||
		Number(header.tuple_count) !== expected.length ||
		actual.length !== expected.length ||
		new Set(actualKeys).size !== actualKeys.length ||
		header.tuple_sha256 !== tupleHash(actual) ||
		actualKeys.some((key) => !expectedKeys.has(key))
	) {
		throw new Error("Pairwise grant adoption is missing or incomplete");
	}
	return {
		status: "adopted",
		bindings: actual.map((tuple) => ({
			...(input.packageId ? { grant_id: input.grantId } : {}),
			instance_id: tuple.instance_id,
			rs_instance: tuple.rs_instance,
			source_id: tuple.source_id,
			stream: tuple.stream,
		})),
	};
}
