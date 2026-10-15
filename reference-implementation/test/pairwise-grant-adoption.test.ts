// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeDb, getDb, initDb } from "../server/db.ts";
import {
	migratePostgresIssuanceCutover,
	migrateSqliteIssuanceCutover,
} from "../server/issuance-cutover.ts";
import {
	assertPairwiseGrantPackageMemberTokens,
	initializePairwiseGrantAdoption,
	readPairwiseGrantAdoption,
} from "../server/pairwise-grant-adoption.ts";
import {
	completePairwiseIdentityLegacyBackfill,
	getPairwiseV1Handle,
	initializePairwiseIdentityRootKey,
	recordTrustedClientSectorMembership,
} from "../server/pairwise-identity.ts";
import {
	closePostgresStorage,
	getPostgresPool,
	initPostgresStorage,
	isPostgresStorageBackend,
	postgresQuery,
} from "../server/postgres-storage.ts";
import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts";

const ISSUER = "https://as.adoption.test";
const SOURCE = "https://source.adoption.test/profile";
const SUBJECT = "private-owner";
const CLIENT_A = "old-client-a";
const CLIENT_B = "old-client-b";
const SHARED_HANDLE = "cin-shared-legacy-handle";
const RS_INSTANCE_A = "cin-shared-legacy-handle";
const RS_INSTANCE_B = "cin-second-legacy-handle";
const OPAQUE_HANDLE = "inst_legacy_opaque_handle";
const OPAQUE_INTERNAL_ID = "cin-opaque-internal";
const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;
const UPGRADE_GRANTS = ["upgrade-grant-finite", "upgrade-grant-null"] as const;

function grantJson(input: {
	clientId: string;
	grantId: string;
	instanceIds: string[];
}): string {
	return JSON.stringify({
		client: { client_id: input.clientId },
		grant_id: input.grantId,
		source: { id: SOURCE },
		source_declaration: { version: "declaration-pinned-1" },
		streams: [{ instance_ids: input.instanceIds, name: "profile" }],
		subject: { id: "sub_public_preserved" },
		version: "0.1.0",
	});
}

async function seedPublicSubjectUpgradeRows(): Promise<void> {
	for (const [grantId, expiresAt] of [
		[UPGRADE_GRANTS[0], "2030-01-01T00:00:00.000Z"],
		[UPGRADE_GRANTS[1], null],
	] as const) {
		await exec(
			"INSERT INTO grants(grant_id,subject_id,client_id,storage_binding_json,grant_json,access_mode,status,issued_at,expires_at) VALUES($1,$2,$3,$4,$5,'read','active','2026-01-01',$6)",
			[
				grantId,
				SUBJECT,
				CLIENT_A,
				JSON.stringify({ connector_id: "connector-a", storage_key: grantId }),
				grantJson({
					clientId: CLIENT_A,
					grantId,
					instanceIds: [SHARED_HANDLE],
				}),
				expiresAt,
			],
		);
	}
	await exec(
		"INSERT INTO grant_packages(package_id,subject_id,client_id,status,package_json,created_at,approved_at) VALUES($1,$2,$3,'active',$4,'2026-01-01','2026-01-01')",
		[
			"upgrade-package",
			SUBJECT,
			CLIENT_A,
			JSON.stringify({ package: "preserve" }),
		],
	);
	for (const [tokenId, familyId, expiresAt] of [
		[
			"upgrade-token-finite",
			"upgrade-family-finite",
			"2030-02-01T00:00:00.000Z",
		],
		["upgrade-token-null", "upgrade-family-null", null],
	] as const) {
		await exec(
			"INSERT INTO tokens(token_id,grant_id,refresh_family_id,subject_id,client_id,token_kind,expires_at) VALUES($1,$2,$3,$4,$5,'client',$6)",
			[tokenId, UPGRADE_GRANTS[0], familyId, SUBJECT, CLIENT_A, expiresAt],
		);
		await exec(
			"INSERT INTO oauth_refresh_tokens(refresh_token_hash,family_id,generation,client_id,grant_id,subject_id,status,created_at,expires_at) VALUES($1,$2,0,$3,$4,$5,'active','2026-01-01',$6)",
			[
				`refresh-${tokenId}`,
				familyId,
				CLIENT_A,
				UPGRADE_GRANTS[0],
				SUBJECT,
				expiresAt,
			],
		);
	}
}

async function exec(sql: string, params: unknown[] = []): Promise<void> {
	if (isPostgresStorageBackend()) await postgresQuery(sql, params);
	else
		getDb()
			.prepare(sql.replace(/\$\d/g, "?"))
			.run(...params);
}

async function queryRows(sql: string): Promise<Record<string, unknown>[]> {
	return isPostgresStorageBackend()
		? (await postgresQuery<Record<string, unknown>>(sql)).rows
		: getDb().prepare(sql).all<Record<string, unknown>>();
}

async function publicSubjectUpgradeSnapshot(): Promise<
	Record<string, unknown>
> {
	return {
		grants: await queryRows(
			"SELECT grant_id,subject_id,public_subject_id,storage_binding_json,grant_json,expires_at FROM grants WHERE grant_id LIKE 'upgrade-grant-%' ORDER BY grant_id",
		),
		packages: await queryRows(
			"SELECT package_id,subject_id,public_subject_id,package_json FROM grant_packages WHERE package_id='upgrade-package'",
		),
		tokens: await queryRows(
			"SELECT token_id,refresh_family_id,expires_at FROM tokens WHERE token_id LIKE 'upgrade-token-%' ORDER BY token_id",
		),
		refreshFamilies: await queryRows(
			"SELECT family_id,expires_at FROM oauth_refresh_tokens WHERE refresh_token_hash LIKE 'refresh-upgrade-token-%' ORDER BY family_id",
		),
		cutover: await queryRows(
			"SELECT kind,row_id,original_expires_at FROM as_issuance_cohort WHERE row_id LIKE 'upgrade-%' ORDER BY kind,row_id",
		),
	};
}

async function seedBase(
	input: { includeBadGrant?: boolean } = {},
): Promise<void> {
	if (isPostgresStorageBackend()) {
		await migratePostgresIssuanceCutover(getPostgresPool());
	} else {
		migrateSqliteIssuanceCutover(getDb());
	}
	await exec("INSERT INTO connectors(connector_id,manifest) VALUES($1,$2)", [
		"connector-a",
		JSON.stringify({
			source_declaration: {
				declaration_version: "declaration-pinned-1",
				source: { id: SOURCE, kind: "connector" },
				streams: [
					{
						name: "profile",
						primary_key: ["id"],
						schema: { properties: { id: { type: "string" } }, type: "object" },
						selection: { fields: true, resources: true },
						semantics: "append_only",
					},
				],
				protocol_version: "0.1.0",
				publisher: { id: SOURCE },
				display: { name: "fixture" },
			},
		}),
	]);
	for (const [id, owner] of [
		[SHARED_HANDLE, SUBJECT],
		[RS_INSTANCE_B, SUBJECT],
	] as const) {
		await exec(
			"INSERT INTO connector_instances(connector_instance_id,owner_subject_id,connector_id,display_name,status,source_kind,source_binding_key,source_binding_json,created_at,updated_at) VALUES($1,$2,$3,$4,'active','account',$5,'{}','2026-01-01','2026-01-01')",
			[id, owner, "connector-a", "fixture", `binding-${id}`],
		);
		await exec(
			"INSERT INTO pairwise_as_instance_authority_versions(subject_id,internal_instance_id,canonical_source_id,declaration_version,accepted_legacy_source_aliases_json) VALUES($1,$2,$3,$4,'[]')",
			[SUBJECT, id, SOURCE, "declaration-pinned-1"],
		);
	}
	const grants = [
		{
			id: "old-grant-a",
			client: CLIENT_A,
			instances: [SHARED_HANDLE, RS_INSTANCE_B],
			expires: null,
		},
		{
			id: "old-grant-b",
			client: CLIENT_B,
			instances: [SHARED_HANDLE],
			expires: "2030-01-01T00:00:00.000Z",
		},
		...(input.includeBadGrant
			? [
					{
						id: "old-grant-invalid",
						client: "bad-client",
						instances: ["cin-unretained"],
					},
				]
			: []),
	];
	for (const grant of grants) {
		await exec(
			"INSERT INTO grants(grant_id,subject_id,client_id,storage_binding_json,grant_json,access_mode,status,issued_at,expires_at) VALUES($1,$2,$3,$4,$5,'read','active','2026-01-01',$6)",
			[
				grant.id,
				SUBJECT,
				grant.client,
				JSON.stringify({ connector_id: "connector-a" }),
				grantJson({
					clientId: grant.client,
					grantId: grant.id,
					instanceIds: grant.instances,
				}),
				"expires" in grant ? grant.expires : null,
			],
		);
	}
	await exec(
		"INSERT INTO as_issuance_cutover(version,completed_at) VALUES('legacy_expiry_v1','2026-01-01') ON CONFLICT DO NOTHING",
	);
	await exec(
		"INSERT INTO as_issuance_cohort(kind,row_id,version,original_expires_at,enrollment) SELECT 'grant',grant_id,'legacy_expiry_v1',expires_at,'cutover' FROM grants WHERE true ON CONFLICT DO NOTHING",
	);
}

async function addCutoverGrant(
	grantId: string,
	clientId: string,
	instanceIds: string[],
): Promise<void> {
	await exec(
		"INSERT INTO grants(grant_id,subject_id,client_id,storage_binding_json,grant_json,access_mode,status,issued_at,expires_at) VALUES($1,$2,$3,$4,$5,'read','active','2026-01-01',NULL)",
		[
			grantId,
			SUBJECT,
			clientId,
			JSON.stringify({ connector_id: "connector-a" }),
			grantJson({ clientId, grantId, instanceIds }),
		],
	);
	await exec(
		"INSERT INTO as_issuance_cohort(kind,row_id,version,original_expires_at,enrollment) VALUES('grant',$1,'legacy_expiry_v1',NULL,'cutover')",
		[grantId],
	);
}

async function seedNullSectorLegacyPeer(input: {
	ownerSector?: string;
	requesterSector: string;
}): Promise<void> {
	await exec(
		"INSERT INTO pairwise_identity_handles(issuer,subject_id,client_id,kind,source_id,internal_id,client_sector,scheme,handle) VALUES($1,$2,$3,'instance',$4,$5,NULL,'legacy',$6)",
		[ISSUER, SUBJECT, CLIENT_A, SOURCE, SHARED_HANDLE, SHARED_HANDLE],
	);
	if (input.ownerSector) {
		await exec(
			"INSERT INTO pairwise_trusted_client_sectors(issuer,client_id,client_sector) VALUES($1,$2,$3)",
			[ISSUER, CLIENT_A, input.ownerSector],
		);
	}
	await exec(
		"INSERT INTO pairwise_trusted_client_sectors(issuer,client_id,client_sector) VALUES($1,$2,$3)",
		[ISSUER, CLIENT_B, input.requesterSector],
	);
}

async function setManifestDeclarationVersion(version: string): Promise<void> {
	const row = isPostgresStorageBackend()
		? (
				await postgresQuery<{ manifest: unknown }>(
					"SELECT manifest FROM connectors WHERE connector_id='connector-a'",
				)
			).rows[0]
		: getDb()
				.prepare(
					"SELECT manifest FROM connectors WHERE connector_id='connector-a'",
				)
				.get<{ manifest: unknown }>();
	const manifest =
		typeof row?.manifest === "string"
			? JSON.parse(row.manifest)
			: structuredClone(row?.manifest);
	manifest.source_declaration.declaration_version = version;
	await exec(
		"UPDATE connectors SET manifest=$1 WHERE connector_id='connector-a'",
		[JSON.stringify(manifest)],
	);
}

async function addPackageMember(input: {
	childClientId: string;
	childGrantId: string;
	childSubjectId: string;
	grantId: string;
	packageId: string;
	status?: string;
	tokenId: string;
	withToken?: boolean;
}): Promise<void> {
	await exec(
		"INSERT INTO grant_packages(package_id,subject_id,public_subject_id,client_id,status,package_json,created_at,approved_at) VALUES($1,$2,'sub_package_public',$3,'active','{}','2026-01-01','2026-01-01')",
		[input.packageId, SUBJECT, CLIENT_A],
	);
	if (input.withToken !== false) {
		await exec(
			"INSERT INTO tokens(token_id,grant_id,package_id,subject_id,client_id,token_kind,expires_at) VALUES($1,$2,NULL,$3,$4,'client','2020-01-01')",
			[
				input.tokenId,
				input.childGrantId,
				input.childSubjectId,
				input.childClientId,
			],
		);
	}
	await exec(
		"INSERT INTO grant_package_members(package_id,grant_id,token_id,source_json,status,added_at,revoked_at) VALUES($1,$2,$3,'{}',$4,'2026-01-01',$5)",
		[
			input.packageId,
			input.grantId,
			input.tokenId,
			input.status ?? "active",
			input.status === "revoked" ? "2026-01-02" : null,
		],
	);
}

async function withPostgresFixture(
	name: string,
	work: () => Promise<void>,
): Promise<void> {
	assert.ok(POSTGRES_URL);
	await withTemporaryPostgresDatabase(
		{
			closeConnections: closePostgresStorage,
			connectionString: POSTGRES_URL,
			databaseName: `pdpp_adoption_r2_${name}_${process.pid}`,
			templateName: null,
		},
		async (databaseUrl) => {
			await initPostgresStorage({ backend: "postgres", databaseUrl });
			try {
				await seedBase();
				await work();
			} finally {
				await closePostgresStorage();
				closeDb();
			}
		},
	);
}

test("SQLite startup adopts complete per-grant tuples and scopes shared raw handles", async () => {
	initDb(":memory:");
	try {
		await seedBase();
		await initializePairwiseGrantAdoption(ISSUER);
		const a = await readPairwiseGrantAdoption({
			issuer: ISSUER,
			clientId: CLIENT_A,
			subjectId: SUBJECT,
			grantId: "old-grant-a",
		});
		const b = await readPairwiseGrantAdoption({
			issuer: ISSUER,
			clientId: CLIENT_B,
			subjectId: SUBJECT,
			grantId: "old-grant-b",
		});
		assert.equal(a.status, "adopted");
		assert.equal(b.status, "adopted");
		if (a.status !== "adopted" || b.status !== "adopted") return;
		assert.deepEqual(
			a.bindings.map(({ source_id, stream, instance_id, rs_instance }) => ({
				source_id,
				stream,
				instance_id,
				rs_instance,
			})),
			[
				{
					source_id: SOURCE,
					stream: "profile",
					instance_id: RS_INSTANCE_B,
					rs_instance: RS_INSTANCE_B,
				},
				{
					source_id: SOURCE,
					stream: "profile",
					instance_id: SHARED_HANDLE,
					rs_instance: RS_INSTANCE_A,
				},
			],
		);
		assert.deepEqual(
			b.bindings.map(({ instance_id, rs_instance }) => ({
				instance_id,
				rs_instance,
			})),
			[{ instance_id: SHARED_HANDLE, rs_instance: RS_INSTANCE_A }],
		);
		await assert.rejects(
			readPairwiseGrantAdoption({
				issuer: ISSUER,
				clientId: CLIENT_B,
				subjectId: SUBJECT,
				grantId: "old-grant-a",
			}),
		);
		await assert.rejects(
			readPairwiseGrantAdoption({
				issuer: ISSUER,
				clientId: CLIENT_A,
				subjectId: "wrong-subject",
				grantId: "old-grant-a",
			}),
		);
		await assert.rejects(
			readPairwiseGrantAdoption({
				issuer: "https://wrong-issuer.test",
				clientId: CLIENT_A,
				subjectId: SUBJECT,
				grantId: "old-grant-a",
			}),
		);
		await assert.rejects(
			readPairwiseGrantAdoption({
				issuer: ISSUER,
				clientId: CLIENT_A,
				subjectId: SUBJECT,
				grantId: "missing-grant",
			}),
		);
		await exec(
			"INSERT INTO grants(grant_id,subject_id,client_id,storage_binding_json,grant_json,access_mode,status,issued_at,expires_at) VALUES($1,$2,$3,$4,$5,'read','active','2026-01-01',NULL)",
			[
				"new-grant",
				SUBJECT,
				CLIENT_A,
				JSON.stringify({ connector_id: "connector-a" }),
				grantJson({
					clientId: CLIENT_A,
					grantId: "new-grant",
					instanceIds: [SHARED_HANDLE],
				}),
			],
		);
		assert.deepEqual(
			await readPairwiseGrantAdoption({
				issuer: ISSUER,
				clientId: CLIENT_A,
				subjectId: SUBJECT,
				grantId: "new-grant",
			}),
			{ status: "not-adopted" },
		);
		await exec(
			"INSERT INTO grant_packages(package_id,subject_id,public_subject_id,client_id,status,package_json,created_at,approved_at) VALUES('package-null-child', $1, 'sub_package_public', $2, 'active', '{}', '2026-01-01', '2026-01-01')",
			[SUBJECT, CLIENT_A],
		);
		await exec(
			"INSERT INTO tokens(token_id,grant_id,package_id,subject_id,client_id,token_kind,expires_at) VALUES('child-token-null-package','old-grant-a',NULL,$1,$2,'client',NULL)",
			[SUBJECT, CLIENT_A],
		);
		await exec(
			"INSERT INTO grant_package_members(package_id,grant_id,token_id,source_json,added_at) VALUES('package-null-child','old-grant-a','child-token-null-package','{}','2026-01-01')",
		);
		const packageRead = await readPairwiseGrantAdoption({
			issuer: ISSUER,
			clientId: CLIENT_A,
			subjectId: SUBJECT,
			grantId: "old-grant-a",
			packageId: "package-null-child",
		});
		assert.equal(packageRead.status, "adopted");
		if (packageRead.status === "adopted") {
			assert.equal(packageRead.bindings.length, 2);
			assert.ok(
				packageRead.bindings.every(
					(binding) => binding.grant_id === "old-grant-a",
				),
			);
		}
		await exec(
			"INSERT INTO grants(grant_id,subject_id,client_id,storage_binding_json,grant_json,access_mode,status,issued_at,expires_at) VALUES($1,$2,$3,$4,$5,'read','active','2026-01-01',NULL)",
			[
				"eligible-but-unreceipted",
				SUBJECT,
				CLIENT_A,
				JSON.stringify({ connector_id: "connector-a" }),
				grantJson({
					clientId: CLIENT_A,
					grantId: "eligible-but-unreceipted",
					instanceIds: [SHARED_HANDLE],
				}),
			],
		);
		await exec(
			"INSERT INTO as_issuance_cohort(kind,row_id,version,original_expires_at,enrollment) VALUES('grant','eligible-but-unreceipted','legacy_expiry_v1',NULL,'cutover')",
		);
		await assert.rejects(
			readPairwiseGrantAdoption({
				issuer: ISSUER,
				clientId: CLIENT_A,
				subjectId: SUBJECT,
				grantId: "eligible-but-unreceipted",
			}),
			/missing or incomplete/,
		);
		const before = getDb()
			.prepare("SELECT grant_json,expires_at FROM grants ORDER BY grant_id")
			.all();
		await initializePairwiseGrantAdoption(ISSUER);
		assert.deepEqual(
			getDb()
				.prepare("SELECT grant_json,expires_at FROM grants ORDER BY grant_id")
				.all(),
			before,
		);
		assert.equal(
			getDb()
				.prepare(
					"SELECT count(*) AS count FROM pairwise_as_grant_instance_adoptions WHERE grant_id='old-grant-a'",
				)
				.get<{ count: number }>()?.count,
			2,
		);
	} finally {
		closeDb();
	}
});

test("SQLite legacy NULL-sector peers require matching owner and requester memberships", async () => {
	const cases = [
		{
			name: "same sector",
			ownerSector: "sector-q",
			requesterSector: "sector-q",
			accepted: true,
		},
		{
			name: "wrong peer sector",
			ownerSector: "sector-q",
			requesterSector: "sector-r",
			accepted: false,
		},
		{
			name: "missing owner membership",
			requesterSector: "sector-q",
			accepted: false,
		},
	];
	for (const scenario of cases) {
		initDb(":memory:");
		try {
			await seedBase();
			await seedNullSectorLegacyPeer(scenario);
			if (scenario.accepted) {
				await initializePairwiseGrantAdoption(ISSUER);
				const read = await readPairwiseGrantAdoption({
					issuer: ISSUER,
					clientId: CLIENT_B,
					subjectId: SUBJECT,
					grantId: "old-grant-b",
				});
				assert.equal(read.status, "adopted", scenario.name);
			} else {
				await assert.rejects(initializePairwiseGrantAdoption(ISSUER));
			}
		} finally {
			closeDb();
		}
	}
});

test("SQLite startup rolls back the whole adoption batch when one approved tuple lacks authority", async () => {
	initDb(":memory:");
	try {
		await seedBase({ includeBadGrant: true });
		await assert.rejects(
			initializePairwiseGrantAdoption(ISSUER),
			/exact retained instance authority/,
		);
		const tables = getDb()
			.prepare(
				"SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'pairwise_as_grant_adoption_%'",
			)
			.all();
		assert.equal(tables.length, 0);
	} finally {
		closeDb();
	}
});

test("SQLite startup rejects a conflicting or absent pinned authority version", async () => {
	const cases = [
		{
			name: "wrong version",
			change: () =>
				getDb()
					.prepare(
						"UPDATE pairwise_as_instance_authority_versions SET declaration_version='different-version' WHERE internal_instance_id=?",
					)
					.run(SHARED_HANDLE),
		},
		{
			name: "wrong source",
			change: () =>
				getDb()
					.prepare(
						"UPDATE pairwise_as_instance_authority_versions SET canonical_source_id='https://wrong-source.test' WHERE internal_instance_id=?",
					)
					.run(SHARED_HANDLE),
		},
		{
			name: "wrong owner",
			change: () =>
				getDb()
					.prepare(
						"UPDATE connector_instances SET owner_subject_id='different-owner' WHERE connector_instance_id=?",
					)
					.run(SHARED_HANDLE),
		},
		{
			name: "missing history with mismatched manifest",
			change: () => {
				getDb()
					.prepare(
						"DELETE FROM pairwise_as_instance_authority_versions WHERE internal_instance_id=?",
					)
					.run(SHARED_HANDLE);
				getDb()
					.prepare(
						"UPDATE connectors SET manifest=? WHERE connector_id='connector-a'",
					)
					.run(
						JSON.stringify({
							source_declaration: {
								declaration_version: "different-version",
								source: { id: SOURCE, kind: "connector" },
								streams: [
									{
										name: "profile",
										primary_key: ["id"],
										schema: {
											properties: { id: { type: "string" } },
											type: "object",
										},
										selection: { fields: true, resources: true },
										semantics: "append_only",
									},
								],
								protocol_version: "0.1.0",
								publisher: { id: SOURCE },
								display: { name: "fixture" },
							},
						}),
					);
			},
		},
	];
	for (const scenario of cases) {
		initDb(":memory:");
		try {
			await seedBase();
			scenario.change();
			await assert.rejects(initializePairwiseGrantAdoption(ISSUER));
		} finally {
			closeDb();
		}
	}
});

test("SQLite startup accepts an exact pinned declaration from the retained manifest when version history is absent", async () => {
	initDb(":memory:");
	try {
		await seedBase();
		getDb()
			.prepare("DELETE FROM pairwise_as_instance_authority_versions")
			.run();
		await initializePairwiseGrantAdoption(ISSUER);
		const adopted = await readPairwiseGrantAdoption({
			issuer: ISSUER,
			clientId: CLIENT_A,
			subjectId: SUBJECT,
			grantId: "old-grant-a",
		});
		assert.equal(adopted.status, "adopted");
	} finally {
		closeDb();
	}
});

test("SQLite startup and reads reject partial persisted adoption receipts", async () => {
	initDb(":memory:");
	try {
		await seedBase();
		await initializePairwiseGrantAdoption(ISSUER);
		await exec(
			"INSERT INTO grants(grant_id,subject_id,client_id,storage_binding_json,grant_json,access_mode,status,issued_at,expires_at) VALUES($1,$2,$3,$4,$5,'read','active','2026-01-01',NULL)",
			[
				"partial-old-grant",
				SUBJECT,
				CLIENT_A,
				JSON.stringify({ connector_id: "connector-a" }),
				grantJson({
					clientId: CLIENT_A,
					grantId: "partial-old-grant",
					instanceIds: [SHARED_HANDLE, RS_INSTANCE_B],
				}),
			],
		);
		await exec(
			"INSERT INTO as_issuance_cohort(kind,row_id,version,original_expires_at,enrollment) VALUES('grant','partial-old-grant','legacy_expiry_v1',NULL,'cutover')",
		);
		const tupleRows = [
			{
				declaration_version: "declaration-pinned-1",
				instance_id: RS_INSTANCE_B,
				source_id: SOURCE,
				stream: "profile",
				rs_instance: RS_INSTANCE_B,
			},
			{
				declaration_version: "declaration-pinned-1",
				instance_id: SHARED_HANDLE,
				source_id: SOURCE,
				stream: "profile",
				rs_instance: RS_INSTANCE_A,
			},
		];
		const hash = await import("node:crypto").then(({ createHash }) =>
			createHash("sha256").update(JSON.stringify(tupleRows)).digest("hex"),
		);
		await exec(
			"INSERT INTO pairwise_as_grant_adoption_receipts(issuer,grant_id,client_id,subject_id,tuple_count,tuple_sha256,completed_at) VALUES($1,'partial-old-grant',$2,$3,2,$4,'2026-01-01')",
			[ISSUER, CLIENT_A, SUBJECT, hash],
		);
		await exec(
			"INSERT INTO pairwise_as_grant_instance_adoptions(issuer,grant_id,client_id,subject_id,source_id,stream,instance_id,rs_instance,declaration_version) VALUES($1,'partial-old-grant',$2,$3,$4,'profile',$5,$6,'declaration-pinned-1')",
			[ISSUER, CLIENT_A, SUBJECT, SOURCE, SHARED_HANDLE, RS_INSTANCE_A],
		);
		await assert.rejects(
			readPairwiseGrantAdoption({
				issuer: ISSUER,
				clientId: CLIENT_A,
				subjectId: SUBJECT,
				grantId: "partial-old-grant",
			}),
			/missing or incomplete/,
		);
		await assert.rejects(initializePairwiseGrantAdoption(ISSUER), /partial/);
	} finally {
		closeDb();
	}
});

test("SQLite startup adopts an opaque old handle only through its exact retained ledger proof", async () => {
	initDb(":memory:");
	try {
		await seedBase();
		await exec(
			"INSERT INTO connector_instances(connector_instance_id,owner_subject_id,connector_id,display_name,status,source_kind,source_binding_key,source_binding_json,created_at,updated_at) VALUES($1,$2,'connector-a','fixture','active','account','binding-opaque','{}','2026-01-01','2026-01-01')",
			[OPAQUE_INTERNAL_ID, SUBJECT],
		);
		await exec(
			"INSERT INTO pairwise_as_instance_authority_versions(subject_id,internal_instance_id,canonical_source_id,declaration_version,accepted_legacy_source_aliases_json) VALUES($1,$2,$3,'declaration-pinned-1','[]')",
			[SUBJECT, OPAQUE_INTERNAL_ID, SOURCE],
		);
		await exec(
			"INSERT INTO grants(grant_id,subject_id,client_id,storage_binding_json,grant_json,access_mode,status,issued_at,expires_at) VALUES($1,$2,$3,$4,$5,'read','active','2026-01-01',NULL)",
			[
				"opaque-old-grant",
				SUBJECT,
				CLIENT_A,
				JSON.stringify({ connector_id: "connector-a" }),
				grantJson({
					clientId: CLIENT_A,
					grantId: "opaque-old-grant",
					instanceIds: [OPAQUE_HANDLE],
				}),
			],
		);
		await exec(
			"INSERT INTO as_issuance_cohort(kind,row_id,version,original_expires_at,enrollment) VALUES('grant','opaque-old-grant','legacy_expiry_v1',NULL,'cutover')",
		);
		await exec(
			"INSERT INTO pairwise_identity_handles(issuer,subject_id,client_id,kind,source_id,internal_id,handle) VALUES($1,$2,$3,'instance',$4,$5,$6)",
			[ISSUER, SUBJECT, CLIENT_A, SOURCE, OPAQUE_INTERNAL_ID, OPAQUE_HANDLE],
		);
		await initializePairwiseGrantAdoption(ISSUER);
		const read = await readPairwiseGrantAdoption({
			issuer: ISSUER,
			clientId: CLIENT_A,
			subjectId: SUBJECT,
			grantId: "opaque-old-grant",
		});
		assert.equal(read.status, "adopted");
		if (read.status === "adopted") {
			assert.deepEqual(
				read.bindings.map(({ instance_id, rs_instance }) => ({
					instance_id,
					rs_instance,
				})),
				[{ instance_id: OPAQUE_HANDLE, rs_instance: OPAQUE_INTERNAL_ID }],
			);
		}
	} finally {
		closeDb();
	}
});

test("SQLite completed adoption survives a later accepted manifest version", async () => {
	initDb(":memory:");
	try {
		await seedBase();
		getDb()
			.prepare("DELETE FROM pairwise_as_instance_authority_versions")
			.run();
		await initializePairwiseGrantAdoption(ISSUER);
		const before = await readPairwiseGrantAdoption({
			issuer: ISSUER,
			clientId: CLIENT_A,
			subjectId: SUBJECT,
			grantId: "old-grant-a",
		});
		await setManifestDeclarationVersion("declaration-accepted-next");
		await initializePairwiseGrantAdoption(ISSUER);
		assert.deepEqual(
			await readPairwiseGrantAdoption({
				issuer: ISSUER,
				clientId: CLIENT_A,
				subjectId: SUBJECT,
				grantId: "old-grant-a",
			}),
			before,
		);
	} finally {
		closeDb();
	}
});

test("SQLite adoption accepts the real v1 sourceless ledger row through pinned authority", async () => {
	initDb(":memory:");
	try {
		await seedBase();
		await initializePairwiseIdentityRootKey(ISSUER);
		const clientSector = `oauth-client:${CLIENT_A}`;
		await recordTrustedClientSectorMembership({
			issuer: ISSUER,
			clientId: CLIENT_A,
			clientSector,
		});
		await completePairwiseIdentityLegacyBackfill(ISSUER);
		const handle = await getPairwiseV1Handle({
			issuer: ISSUER,
			clientId: CLIENT_A,
			clientSector,
			subjectId: SUBJECT,
			kind: "instance",
			internalId: SHARED_HANDLE,
			sourceId: SOURCE,
		});
		assert.equal(
			getDb()
				.prepare(
					"SELECT source_id FROM pairwise_identity_handles WHERE handle=?",
				)
				.get<{ source_id: string }>(handle)?.source_id,
			"",
		);
		await exec("UPDATE grants SET grant_json=$1 WHERE grant_id='old-grant-a'", [
			grantJson({
				clientId: CLIENT_A,
				grantId: "old-grant-a",
				instanceIds: [handle, RS_INSTANCE_B],
			}),
		]);
		await initializePairwiseGrantAdoption(ISSUER);
		const adopted = await readPairwiseGrantAdoption({
			issuer: ISSUER,
			clientId: CLIENT_A,
			subjectId: SUBJECT,
			grantId: "old-grant-a",
		});
		assert.equal(adopted.status, "adopted");
		if (adopted.status === "adopted") {
			assert.ok(
				adopted.bindings.some(
					(binding) =>
						binding.instance_id === handle &&
						binding.rs_instance === SHARED_HANDLE &&
						binding.source_id === SOURCE,
				),
			);
		}
	} finally {
		closeDb();
	}
});

test("SQLite adoption compares complete mixed-case handles as an exact set", async () => {
	initDb(":memory:");
	try {
		await seedBase();
		const handles = ["inst_Z", "inst_a"];
		for (const [handle, internalId] of [
			[handles[0], SHARED_HANDLE],
			[handles[1], RS_INSTANCE_B],
		]) {
			await exec(
				"INSERT INTO pairwise_identity_handles(issuer,subject_id,client_id,kind,source_id,internal_id,handle) VALUES($1,$2,$3,'instance',$4,$5,$6)",
				[ISSUER, SUBJECT, CLIENT_A, SOURCE, internalId, handle],
			);
		}
		await exec("UPDATE grants SET grant_json=$1 WHERE grant_id='old-grant-a'", [
			grantJson({
				clientId: CLIENT_A,
				grantId: "old-grant-a",
				instanceIds: handles,
			}),
		]);
		await initializePairwiseGrantAdoption(ISSUER);
		const adopted = await readPairwiseGrantAdoption({
			issuer: ISSUER,
			clientId: CLIENT_A,
			subjectId: SUBJECT,
			grantId: "old-grant-a",
		});
		assert.equal(adopted.status, "adopted");
		if (adopted.status === "adopted") {
			assert.deepEqual(
				new Set(
					adopted.bindings.map(({ instance_id, rs_instance }) =>
						JSON.stringify([instance_id, rs_instance]),
					),
				),
				new Set([
					JSON.stringify([handles[0], SHARED_HANDLE]),
					JSON.stringify([handles[1], RS_INSTANCE_B]),
				]),
			);
		}
	} finally {
		closeDb();
	}
});

test("SQLite package child-token proof preserves inactive and NULL-package members and rejects swapped or missing tokens", async () => {
	initDb(":memory:");
	try {
		await seedBase();
		await initializePairwiseGrantAdoption(ISSUER);
		await addPackageMember({
			childClientId: CLIENT_A,
			childGrantId: "old-grant-a",
			childSubjectId: SUBJECT,
			grantId: "old-grant-a",
			packageId: "package-inactive-null-child",
			status: "revoked",
			tokenId: "child-token-inactive-null-package",
		});
		await assert.doesNotReject(
			assertPairwiseGrantPackageMemberTokens({
				clientId: CLIENT_A,
				packageId: "package-inactive-null-child",
				subjectId: SUBJECT,
			}),
		);
		const included = await readPairwiseGrantAdoption({
			issuer: ISSUER,
			clientId: CLIENT_A,
			subjectId: SUBJECT,
			grantId: "old-grant-a",
			packageId: "package-inactive-null-child",
		});
		assert.equal(included.status, "adopted");

		const cases = [
			{
				name: "wrong grant and client",
				childGrantId: "old-grant-b",
				childClientId: CLIENT_B,
				childSubjectId: SUBJECT,
				withToken: true,
			},
			{
				name: "wrong client",
				childGrantId: "old-grant-a",
				childClientId: CLIENT_B,
				childSubjectId: SUBJECT,
				withToken: true,
			},
			{
				name: "wrong owner",
				childGrantId: "old-grant-a",
				childClientId: CLIENT_A,
				childSubjectId: "foreign-owner",
				withToken: true,
			},
			{
				name: "missing token",
				childGrantId: "old-grant-a",
				childClientId: CLIENT_A,
				childSubjectId: SUBJECT,
				withToken: false,
			},
		];
		for (const scenario of cases) {
			const packageId = `package-${scenario.name.replaceAll(" ", "-")}`;
			const tokenId = `child-${scenario.name.replaceAll(" ", "-")}`;
			await addPackageMember({
				...scenario,
				grantId: "old-grant-a",
				packageId,
				tokenId,
			});
			await assert.rejects(
				assertPairwiseGrantPackageMemberTokens({
					clientId: CLIENT_A,
					packageId,
					subjectId: SUBJECT,
				}),
			);
			await assert.rejects(
				readPairwiseGrantAdoption({
					issuer: ISSUER,
					clientId: CLIENT_A,
					subjectId: SUBJECT,
					grantId: "old-grant-a",
					packageId,
				}),
			);
		}
	} finally {
		closeDb();
	}
});

if (POSTGRES_URL) {
	test("PostgreSQL legacy NULL-sector peers require matching owner and requester memberships", async () => {
		for (const scenario of [
			{
				name: "same sector",
				ownerSector: "sector-q",
				requesterSector: "sector-q",
				accepted: true,
			},
			{
				name: "wrong peer sector",
				ownerSector: "sector-q",
				requesterSector: "sector-r",
				accepted: false,
			},
			{
				name: "missing owner membership",
				requesterSector: "sector-q",
				accepted: false,
			},
		]) {
			await withPostgresFixture(
				`null-peer-${scenario.name.replaceAll(" ", "-")}`,
				async () => {
					await seedNullSectorLegacyPeer(scenario);
					if (scenario.accepted) {
						await initializePairwiseGrantAdoption(ISSUER);
					} else {
						await assert.rejects(initializePairwiseGrantAdoption(ISSUER));
					}
					if (scenario.accepted) {
						const read = await readPairwiseGrantAdoption({
							issuer: ISSUER,
							clientId: CLIENT_B,
							subjectId: SUBJECT,
							grantId: "old-grant-b",
						});
						assert.equal(read.status, "adopted", scenario.name);
					}
				},
			);
		}
	});

	test("PostgreSQL sealed, v1, and mixed-case adoption lifecycle controls", async () => {
		await withPostgresFixture("lifecycle", async () => {
			await exec("DELETE FROM pairwise_as_instance_authority_versions");
			await initializePairwiseGrantAdoption(ISSUER);
			const before = await readPairwiseGrantAdoption({
				issuer: ISSUER,
				clientId: CLIENT_A,
				subjectId: SUBJECT,
				grantId: "old-grant-a",
			});
			await setManifestDeclarationVersion("declaration-accepted-next");
			await initializePairwiseGrantAdoption(ISSUER);
			assert.deepEqual(
				await readPairwiseGrantAdoption({
					issuer: ISSUER,
					clientId: CLIENT_A,
					subjectId: SUBJECT,
					grantId: "old-grant-a",
				}),
				before,
			);

			await initializePairwiseIdentityRootKey(ISSUER);
			const clientSector = `oauth-client:${CLIENT_A}`;
			await recordTrustedClientSectorMembership({
				issuer: ISSUER,
				clientId: CLIENT_A,
				clientSector,
			});
			await completePairwiseIdentityLegacyBackfill(ISSUER);
			for (const internalId of [SHARED_HANDLE, RS_INSTANCE_B]) {
				await exec(
					"INSERT INTO pairwise_as_instance_authority_versions(subject_id,internal_instance_id,canonical_source_id,declaration_version,accepted_legacy_source_aliases_json) VALUES($1,$2,$3,'declaration-pinned-1','[]')",
					[SUBJECT, internalId, SOURCE],
				);
			}
			const v1Handle = await getPairwiseV1Handle({
				issuer: ISSUER,
				clientId: CLIENT_A,
				clientSector,
				subjectId: SUBJECT,
				kind: "instance",
				internalId: SHARED_HANDLE,
				sourceId: SOURCE,
			});
			await addCutoverGrant("v1-sourceless-grant", CLIENT_A, [v1Handle]);
			await initializePairwiseGrantAdoption(ISSUER);
			const v1Read = await readPairwiseGrantAdoption({
				issuer: ISSUER,
				clientId: CLIENT_A,
				subjectId: SUBJECT,
				grantId: "v1-sourceless-grant",
			});
			assert.equal(v1Read.status, "adopted");
			if (v1Read.status === "adopted") {
				assert.ok(
					v1Read.bindings.some(
						(binding) =>
							binding.instance_id === v1Handle &&
							binding.rs_instance === SHARED_HANDLE &&
							binding.source_id === SOURCE,
					),
				);
			}

			const handles = ["inst_Z", "inst_a"];
			for (const [handle, internalId] of [
				[handles[0], SHARED_HANDLE],
				[handles[1], RS_INSTANCE_B],
			]) {
				await exec(
					"INSERT INTO pairwise_identity_handles(issuer,subject_id,client_id,kind,source_id,internal_id,handle) VALUES($1,$2,$3,'instance',$4,$5,$6)",
					[ISSUER, SUBJECT, CLIENT_A, SOURCE, internalId, handle],
				);
			}
			await addCutoverGrant("mixed-case-grant", CLIENT_A, handles);
			await initializePairwiseGrantAdoption(ISSUER);
			const mixedRead = await readPairwiseGrantAdoption({
				issuer: ISSUER,
				clientId: CLIENT_A,
				subjectId: SUBJECT,
				grantId: "mixed-case-grant",
			});
			assert.equal(mixedRead.status, "adopted");
			if (mixedRead.status === "adopted") {
				assert.deepEqual(
					new Set(
						mixedRead.bindings.map(({ instance_id, rs_instance }) =>
							JSON.stringify([instance_id, rs_instance]),
						),
					),
					new Set([
						JSON.stringify([handles[0], SHARED_HANDLE]),
						JSON.stringify([handles[1], RS_INSTANCE_B]),
					]),
				);
			}
		});
	});

	test("PostgreSQL package child-token proof preserves inactive NULL-package members and rejects mismatches", async () => {
		await withPostgresFixture("package-proof", async () => {
			await initializePairwiseGrantAdoption(ISSUER);
			await addPackageMember({
				childClientId: CLIENT_A,
				childGrantId: "old-grant-a",
				childSubjectId: SUBJECT,
				grantId: "old-grant-a",
				packageId: "pg-package-inactive-null-child",
				status: "revoked",
				tokenId: "pg-child-inactive-null-package",
			});
			await assert.doesNotReject(
				assertPairwiseGrantPackageMemberTokens({
					clientId: CLIENT_A,
					packageId: "pg-package-inactive-null-child",
					subjectId: SUBJECT,
				}),
			);
			const included = await readPairwiseGrantAdoption({
				issuer: ISSUER,
				clientId: CLIENT_A,
				subjectId: SUBJECT,
				grantId: "old-grant-a",
				packageId: "pg-package-inactive-null-child",
			});
			assert.equal(included.status, "adopted");

			for (const scenario of [
				{
					name: "grant-client",
					childGrantId: "old-grant-b",
					childClientId: CLIENT_B,
					childSubjectId: SUBJECT,
					withToken: true,
				},
				{
					name: "client",
					childGrantId: "old-grant-a",
					childClientId: CLIENT_B,
					childSubjectId: SUBJECT,
					withToken: true,
				},
				{
					name: "owner",
					childGrantId: "old-grant-a",
					childClientId: CLIENT_A,
					childSubjectId: "foreign-owner",
					withToken: true,
				},
				{
					name: "missing-token",
					childGrantId: "old-grant-a",
					childClientId: CLIENT_A,
					childSubjectId: SUBJECT,
					withToken: false,
				},
			]) {
				const packageId = `pg-package-${scenario.name}`;
				const tokenId = `pg-child-${scenario.name}`;
				await addPackageMember({
					...scenario,
					grantId: "old-grant-a",
					packageId,
					tokenId,
				});
				await assert.rejects(
					assertPairwiseGrantPackageMemberTokens({
						clientId: CLIENT_A,
						packageId,
						subjectId: SUBJECT,
					}),
				);
				await assert.rejects(
					readPairwiseGrantAdoption({
						issuer: ISSUER,
						clientId: CLIENT_A,
						subjectId: SUBJECT,
						grantId: "old-grant-a",
						packageId,
					}),
				);
			}
		});
	});

	test("PostgreSQL initializers serialize before taking their source proof snapshot", async () => {
		await withPostgresFixture("concurrent-initializers", async () => {
			const poolMax = (
				getPostgresPool() as unknown as { options: { max: number } }
			).options.max;
			assert.ok(poolMax >= 2 && poolMax <= 16);
			const results = await Promise.allSettled(
				Array.from({ length: poolMax }, () =>
					initializePairwiseGrantAdoption(ISSUER),
				),
			);
			assert.ok(results.every((result) => result.status === "fulfilled"));
		});
	});

	test("PostgreSQL concurrent source change yields a sealed proof or aborts enrollment", async () => {
		await withPostgresFixture("source-change", async () => {
			await exec("DELETE FROM pairwise_as_instance_authority_versions");
			const [migration, sourceChange] = await Promise.allSettled([
				initializePairwiseGrantAdoption(ISSUER),
				setManifestDeclarationVersion("declaration-accepted-next"),
			]);
			assert.equal(sourceChange.status, "fulfilled");
			if (migration.status === "fulfilled") {
				assert.equal(
					(
						await readPairwiseGrantAdoption({
							issuer: ISSUER,
							clientId: CLIENT_A,
							subjectId: SUBJECT,
							grantId: "old-grant-a",
						})
					).status,
					"adopted",
				);
			} else {
				const error = migration.reason as { code?: string; message?: string };
				assert.ok(
					error.code === "40001" ||
						error.message?.includes("does not match pinned authority"),
				);
				const receipts = await postgresQuery<{ count: string }>(
					"SELECT count(*)::text AS count FROM pairwise_as_grant_adoption_receipts",
				);
				assert.equal(receipts.rows[0]?.count, "0");
			}
		});
	});

	test("PostgreSQL startup adopts and reads complete grant-scoped mappings", async () => {
		await withTemporaryPostgresDatabase(
			{
				closeConnections: closePostgresStorage,
				connectionString: POSTGRES_URL,
				databaseName: `pdpp_grant_adoption_${process.pid}`,
				templateName: null,
			},
			async (databaseUrl) => {
				await initPostgresStorage({ backend: "postgres", databaseUrl });
				try {
					await seedBase();
					await initializePairwiseGrantAdoption(ISSUER);
					const first = await readPairwiseGrantAdoption({
						issuer: ISSUER,
						clientId: CLIENT_A,
						subjectId: SUBJECT,
						grantId: "old-grant-a",
					});
					const second = await readPairwiseGrantAdoption({
						issuer: ISSUER,
						clientId: CLIENT_B,
						subjectId: SUBJECT,
						grantId: "old-grant-b",
					});
					assert.equal(first.status, "adopted");
					assert.equal(second.status, "adopted");
					if (first.status === "adopted" && second.status === "adopted") {
						assert.equal(first.bindings.length, 2);
						assert.equal(second.bindings.length, 1);
						assert.equal(second.bindings[0]?.instance_id, SHARED_HANDLE);
					}
				} finally {
					await closePostgresStorage();
					closeDb();
				}
			},
		);
	});

	test("PostgreSQL adds public subject columns to existing rows without changing grant, storage, or expiry values", async () => {
		await withTemporaryPostgresDatabase(
			{
				closeConnections: closePostgresStorage,
				connectionString: POSTGRES_URL,
				databaseName: `pdpp_adoption_schema_upgrade_${process.pid}`,
				templateName: null,
			},
			async (databaseUrl) => {
				await initPostgresStorage({ backend: "postgres", databaseUrl });
				try {
					await seedPublicSubjectUpgradeRows();
					await migratePostgresIssuanceCutover(getPostgresPool());
					const beforeUpgrade = await publicSubjectUpgradeSnapshot();
					await exec("ALTER TABLE grants DROP COLUMN public_subject_id");
					await exec(
						"ALTER TABLE grant_packages DROP COLUMN public_subject_id",
					);
					await closePostgresStorage();

					await initPostgresStorage({ backend: "postgres", databaseUrl });
					const columns = await postgresQuery<{
						table_name: string;
						column_name: string;
					}>(
						"SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public' AND column_name='public_subject_id' AND table_name IN ('grants','grant_packages') ORDER BY table_name",
					);
					assert.deepEqual(
						columns.rows.map(({ table_name, column_name }) => [
							table_name,
							column_name,
						]),
						[
							["grant_packages", "public_subject_id"],
							["grants", "public_subject_id"],
						],
					);
					assert.deepEqual(await publicSubjectUpgradeSnapshot(), beforeUpgrade);
					await exec(
						"UPDATE grants SET public_subject_id='sub_upgrade_grant' WHERE grant_id=$1",
						[UPGRADE_GRANTS[0]],
					);
					await exec(
						"UPDATE grant_packages SET public_subject_id='sub_upgrade_package' WHERE package_id='upgrade-package'",
					);
					const beforeRepeat = await publicSubjectUpgradeSnapshot();
					await closePostgresStorage();
					await initPostgresStorage({ backend: "postgres", databaseUrl });
					assert.deepEqual(await publicSubjectUpgradeSnapshot(), beforeRepeat);
				} finally {
					await closePostgresStorage();
					closeDb();
				}
			},
		);
	});
}

test("SQLite adds public subject columns to existing rows without changing grant, storage, or expiry values", async () => {
	const directory = mkdtempSync(
		join(tmpdir(), "pdpp-adoption-schema-upgrade-"),
	);
	const databasePath = join(directory, "existing.sqlite");
	initDb(databasePath);
	try {
		await seedPublicSubjectUpgradeRows();
		migrateSqliteIssuanceCutover(getDb());
		const beforeUpgrade = await publicSubjectUpgradeSnapshot();
		getDb().exec("ALTER TABLE grants DROP COLUMN public_subject_id");
		getDb().exec("ALTER TABLE grant_packages DROP COLUMN public_subject_id");
		closeDb();

		initDb(databasePath);
		const grantColumns = getDb()
			.prepare("PRAGMA table_info(grants)")
			.all<{ name: string }>();
		const packageColumns = getDb()
			.prepare("PRAGMA table_info(grant_packages)")
			.all<{ name: string }>();
		assert.ok(grantColumns.some(({ name }) => name === "public_subject_id"));
		assert.ok(packageColumns.some(({ name }) => name === "public_subject_id"));
		assert.deepEqual(await publicSubjectUpgradeSnapshot(), {
			...beforeUpgrade,
			grants: (beforeUpgrade.grants as Array<Record<string, unknown>>).map(
				(row) => ({
					...row,
					public_subject_id: null,
				}),
			),
			packages: (beforeUpgrade.packages as Array<Record<string, unknown>>).map(
				(row) => ({
					...row,
					public_subject_id: null,
				}),
			),
		});
		await exec(
			"UPDATE grants SET public_subject_id='sub_upgrade_grant' WHERE grant_id=$1",
			[UPGRADE_GRANTS[0]],
		);
		await exec(
			"UPDATE grant_packages SET public_subject_id='sub_upgrade_package' WHERE package_id='upgrade-package'",
		);
		const beforeRepeat = await publicSubjectUpgradeSnapshot();
		closeDb();
		initDb(databasePath);
		assert.deepEqual(await publicSubjectUpgradeSnapshot(), beforeRepeat);
	} finally {
		closeDb();
		rmSync(directory, { force: true, recursive: true });
	}
});
