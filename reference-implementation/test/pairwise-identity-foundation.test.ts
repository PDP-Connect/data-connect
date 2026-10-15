// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import pg from "pg";
import { BACKUP_TABLE_INVENTORY } from "../server/backup-table-policy.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import {
	backfillTrustedClientSectorMembership,
	clientVisibleInstanceId,
	completePairwiseIdentityLegacyBackfill,
	getPairwiseHandle,
	initializePairwiseIdentityRootKey,
	lookupPairwiseInstanceMapping,
	migratePairwiseIdentityIssuer,
	type PairwiseHandleInput,
	PairwiseIdentityContextError,
	PairwiseIdentityDeploymentError,
	projectPairwiseGrant,
	recordTrustedClientSectorMembership,
	resolveInternalInstanceId,
	validatePairwiseInstanceBindings,
} from "../server/pairwise-identity.ts";
import {
	closePostgresStorage,
	getPostgresPool,
	initPostgresStorage,
	postgresQuery,
} from "../server/postgres-storage.ts";
import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts";

const HMAC_INSTANCE_HANDLE = /^inst_v1_[A-Za-z0-9_-]{43}$/;
const HMAC_SUBJECT_HANDLE = /^sub_v1_[A-Za-z0-9_-]{43}$/;
const VERSIONED_INSTANCE_HANDLE = /^inst_v1_/;
const IMMUTABLE_SECTOR = /immutable/i;
const UNAVAILABLE_KEY = /key|unavailable/i;
const LOST_ISSUER_KEY = /missing after prior issuance/i;
const CORRUPT_KEY = /corrupt/i;
const UNAVAILABLE_IDENTITY_STORE = /no such table|persistence/i;
const MISSING_BINDING = /authenticated binding/i;
const CROSS_SOURCE_BINDING = /cross-source/i;
const CONFLICTING_BINDING = /conflicting/i;

const TEST_KEY = Buffer.from("0123456789abcdef0123456789abcdef");
const { Pool } = pg;
const ISSUER = "https://as.example";
const SECTOR = "https://sector.example/applications.json";
const OTHER_SECTOR = "https://other.example/sector.json";
const baseInput: PairwiseHandleInput = {
	clientId: "client-a",
	clientSector: SECTOR,
	internalId: "cin_stable-17",
	issuer: ISSUER,
	kind: "instance",
	sourceId: "source-primary",
	subjectId: "person-4",
};

function expectedHandle(
	input: PairwiseHandleInput,
	semanticKind: "person" | "instance" = "instance",
): string {
	const parts =
		semanticKind === "instance"
			? [
					"pdpp-pairwise",
					"v1",
					semanticKind,
					input.issuer,
					input.clientSector,
					input.subjectId,
					input.internalId,
				]
			: [
					"pdpp-pairwise",
					"v1",
					semanticKind,
					input.issuer,
					input.clientSector,
					input.internalId,
				];
	const digest = createHmac("sha256", TEST_KEY)
		.update(JSON.stringify(parts))
		.digest("base64url");
	return `${semanticKind === "instance" ? "inst" : "sub"}_v1_${digest}`;
}

async function seedSqliteFixture(): Promise<void> {
	initDb(":memory:");
	await initializePairwiseIdentityRootKey(ISSUER);
	getDb()
		.prepare(
			"UPDATE pairwise_identity_root_keys SET root_key_hex=? WHERE issuer=?",
		)
		.run(TEST_KEY.toString("hex"), ISSUER);
	await recordTrustedClientSectorMembership({
		clientId: "client-a",
		clientSector: SECTOR,
		issuer: ISSUER,
	});
	await recordTrustedClientSectorMembership({
		clientId: "client-b",
		clientSector: SECTOR,
		issuer: ISSUER,
	});
}

test("new instance handles use deterministic versioned HMAC-SHA256", async () => {
	await seedSqliteFixture();
	try {
		const handle = await getPairwiseHandle(baseInput);
		assert.equal(handle, expectedHandle(baseInput));
		assert.match(handle, HMAC_INSTANCE_HANDLE);
	} finally {
		closeDb();
	}
});

test("default handles and reverse lookup never adopt legacy mappings", async () => {
	await seedSqliteFixture();
	try {
		const insert = getDb().prepare(
			`INSERT INTO pairwise_identity_handles
			 (issuer,subject_id,client_id,kind,source_id,internal_id,handle)
			 VALUES (?,?,?,?,?,?,?)`,
		);
		insert.run(
			ISSUER,
			"person-4",
			"client-a",
			"subject",
			"",
			"person-4",
			"sub_raw-person",
		);
		insert.run(
			ISSUER,
			"person-4",
			"client-a",
			"instance",
			"source-primary",
			"cin_stable-17",
			"inst_raw-instance",
		);

		const subjectInput = {
			...baseInput,
			internalId: "person-4",
			kind: "subject" as const,
		};
		const sameClientLookup = await lookupPairwiseInstanceMapping({
			...baseInput,
			instanceHandle: "inst_raw-instance",
		});
		const otherClientLookup = await lookupPairwiseInstanceMapping({
			...baseInput,
			clientId: "client-b",
			instanceHandle: "inst_raw-instance",
		});
		assert.deepEqual(
			{
				instanceHandle: await getPairwiseHandle(baseInput),
				otherClientLookup,
				personHandle: await getPairwiseHandle(subjectInput),
				sameClientLookup,
			},
			{
				instanceHandle: expectedHandle(baseInput),
				otherClientLookup: null,
				personHandle: expectedHandle(subjectInput, "person"),
				sameClientLookup: null,
			},
		);
	} finally {
		closeDb();
	}
});

test("canonical JSON HMAC encoding separates embedded separators", async () => {
	await seedSqliteFixture();
	try {
		const left = {
			...baseInput,
			clientSector: "x",
			internalId: "subject\u0000instance",
			issuer: ISSUER,
		};
		const right = {
			...baseInput,
			clientSector: "sector\u0000x",
			internalId: "subject\u0000instance",
			issuer: ISSUER,
		};
		await recordTrustedClientSectorMembership({
			clientId: "collision-a",
			clientSector: left.clientSector,
			issuer: left.issuer,
		});
		await recordTrustedClientSectorMembership({
			clientId: "collision-b",
			clientSector: right.clientSector,
			issuer: right.issuer,
		});
		const first = await getPairwiseHandle({ ...left, clientId: "collision-a" });
		const second = await getPairwiseHandle({
			...right,
			clientId: "collision-b",
		});
		assert.notEqual(first, second);
	} finally {
		closeDb();
	}
});

test("a trusted client sector shares identifiers across registrations and isolates other sectors", async () => {
	await seedSqliteFixture();
	try {
		const first = await getPairwiseHandle(baseInput);
		const sameSector = await getPairwiseHandle({
			...baseInput,
			clientId: "client-b",
		});
		await recordTrustedClientSectorMembership({
			clientId: "client-c",
			clientSector: OTHER_SECTOR,
			issuer: ISSUER,
		});
		const otherSector = await getPairwiseHandle({
			...baseInput,
			clientId: "client-c",
			clientSector: OTHER_SECTOR,
		});
		assert.equal(first, sameSector);
		assert.notEqual(first, otherSector);
		await assert.rejects(
			initializePairwiseIdentityRootKey("https://other-as.example"),
			/configured issuer/i,
		);
	} finally {
		closeDb();
	}
});

test("person handles ignore represented subject and remain distinct across sectors", async () => {
	await seedSqliteFixture();
	try {
		const personA = await getPairwiseHandle({
			...baseInput,
			internalId: "person-4",
			kind: "subject",
			subjectId: "represented-a",
		});
		const personB = await getPairwiseHandle({
			...baseInput,
			internalId: "person-4",
			kind: "grantor",
			subjectId: "represented-b",
		});
		await recordTrustedClientSectorMembership({
			clientId: "client-c",
			clientSector: OTHER_SECTOR,
			issuer: ISSUER,
		});
		const otherSector = await getPairwiseHandle({
			...baseInput,
			clientId: "client-c",
			clientSector: OTHER_SECTOR,
			internalId: "person-4",
			kind: "subject",
		});
		assert.equal(personA, personB);
		assert.notEqual(personA, otherSector);
	} finally {
		closeDb();
	}
});

test("one internal instance gets different handles for different internal subjects", async () => {
	await seedSqliteFixture();
	try {
		const first = await getPairwiseHandle(baseInput);
		const second = await getPairwiseHandle({
			...baseInput,
			subjectId: "person-5",
		});
		assert.notEqual(first, second);
	} finally {
		closeDb();
	}
});

test("a stable instance keeps one handle across source aliases and streams", async () => {
	await seedSqliteFixture();
	try {
		const first = await getPairwiseHandle(baseInput);
		const alias = await getPairwiseHandle({
			...baseInput,
			sourceId: "source-alias",
		});
		const context = { issuer: ISSUER, resolveClientSector: () => SECTOR };
		const acrossStreams = await projectPairwiseGrant(
			{
				client: { client_id: baseInput.clientId },
				source: { id: baseInput.sourceId ?? "" },
				streams: [
					{ instance_ids: [baseInput.internalId], name: "profile" },
					{ instance_ids: [baseInput.internalId], name: "activity" },
				],
				subject: { id: baseInput.subjectId },
			},
			baseInput.subjectId,
			context,
		);

		assert.equal(first, alias);
		assert.equal(
			acrossStreams.streams[0]?.instance_ids?.[0],
			acrossStreams.streams[1]?.instance_ids?.[0],
		);
		assert.equal(
			acrossStreams.subject.id,
			expectedHandle(
				{ ...baseInput, internalId: baseInput.subjectId },
				"person",
			),
		);
	} finally {
		closeDb();
	}
});

test("subject and grantor entries for one person share an identifier across represented subjects", async () => {
	await seedSqliteFixture();
	try {
		const grant = {
			client: { client_id: "client-a" },
			grantors: [
				{ capacity: "https://example.test/capacity/guardian", id: "person-4" },
			],
			source: { id: "source-primary" },
			streams: [{ instance_ids: ["cin_stable-17"], name: "profile" }],
			subject: { id: "private-represented-subject" },
		};
		const projected = await projectPairwiseGrant(grant, "person-4", {
			issuer: ISSUER,
			resolveClientSector: () => SECTOR,
		});
		assert.equal(projected.subject.id, projected.grantors?.[0]?.id);
	} finally {
		closeDb();
	}
});

test("legacy grantor-kind rows do not affect new person handles", async () => {
	await seedSqliteFixture();
	try {
		getDb()
			.prepare(
				"INSERT INTO pairwise_identity_handles (issuer,subject_id,client_id,kind,source_id,internal_id,handle) VALUES (?,?,?,?,?,?,?)",
			)
			.run(
				ISSUER,
				"person-4",
				"client-a",
				"grantor",
				"",
				"grantor-9",
				"sub_proto_grantor",
			);
		const input = {
			...baseInput,
			internalId: "grantor-9",
			kind: "grantor" as const,
		};
		assert.equal(await getPairwiseHandle(input), expectedHandle(input, "person"));
	} finally {
		closeDb();
	}
});

test("an existing random mapping does not replace its HMAC v1 handle", async () => {
	await seedSqliteFixture();
	try {
		const legacyHandle = "inst_existing-random-mapping";
		getDb()
			.prepare(
				`INSERT INTO pairwise_identity_handles
          (issuer,subject_id,client_id,kind,source_id,internal_id,handle)
         VALUES (?,?,?,?,?,?,?)`,
			)
			.run(
				ISSUER,
				baseInput.subjectId,
				baseInput.clientId,
				"instance",
				baseInput.sourceId,
				baseInput.internalId,
				legacyHandle,
			);
		assert.match(await getPairwiseHandle(baseInput), HMAC_INSTANCE_HANDLE);
		assert.notEqual(await getPairwiseHandle(baseInput), legacyHandle);
	} finally {
		closeDb();
	}
});

test("one legacy source alias does not change the issued HMAC handle", async () => {
	await seedSqliteFixture();
	try {
		getDb()
			.prepare(
				`INSERT INTO pairwise_identity_handles
          (issuer,subject_id,client_id,kind,source_id,internal_id,handle)
         VALUES (?,?,?,?,?,?,?)`,
			)
			.run(
				ISSUER,
				baseInput.subjectId,
				baseInput.clientId,
				"instance",
				"legacy-source-alias",
				baseInput.internalId,
				"inst_old-once",
			);
		assert.match(await getPairwiseHandle(baseInput), HMAC_INSTANCE_HANDLE);
	} finally {
		closeDb();
	}
});

test("conflicting legacy handles do not block HMAC issuance in a trusted sector", async () => {
	await seedSqliteFixture();
	try {
		await recordTrustedClientSectorMembership({
			clientId: "old-client-a",
			clientSector: SECTOR,
			issuer: ISSUER,
		});
		await recordTrustedClientSectorMembership({
			clientId: "old-client-b",
			clientSector: SECTOR,
			issuer: ISSUER,
		});
		await recordTrustedClientSectorMembership({
			clientId: "new-client",
			clientSector: SECTOR,
			issuer: ISSUER,
		});
		const insert = getDb().prepare(
			`INSERT INTO pairwise_identity_handles
        (issuer,subject_id,client_id,kind,source_id,internal_id,handle)
       VALUES (?,?,?,?,?,?,?)`,
		);
		insert.run(
			ISSUER,
			baseInput.subjectId,
			"old-client-a",
			"instance",
			"old-source-a",
			baseInput.internalId,
			"inst_legacy-a",
		);
		insert.run(
			ISSUER,
			baseInput.subjectId,
			"old-client-b",
			"instance",
			"old-source-b",
			baseInput.internalId,
			"inst_legacy-b",
		);
		assert.equal(
			await getPairwiseHandle({ ...baseInput, clientId: "new-client" }),
			expectedHandle(baseInput),
		);
	} finally {
		closeDb();
	}
});

test("unrelated clients with the same internal instance do not block issuance", async () => {
	await seedSqliteFixture();
	try {
		await recordTrustedClientSectorMembership({
			clientId: "unrelated-a",
			clientSector: OTHER_SECTOR,
			issuer: ISSUER,
		});
		await recordTrustedClientSectorMembership({
			clientId: "unrelated-b",
			clientSector: OTHER_SECTOR,
			issuer: ISSUER,
		});
		const insert = getDb().prepare(
			`INSERT INTO pairwise_identity_handles
        (issuer,subject_id,client_id,kind,source_id,internal_id,handle)
       VALUES (?,?,?,?,?,?,?)`,
		);
		insert.run(
			ISSUER,
			baseInput.subjectId,
			"unrelated-a",
			"instance",
			"source-primary",
			baseInput.internalId,
			"inst_unrelated-a",
		);
		insert.run(
			ISSUER,
			baseInput.subjectId,
			"unrelated-b",
			"instance",
			"source-primary",
			baseInput.internalId,
			"inst_unrelated-b",
		);
		assert.match(await getPairwiseHandle(baseInput), VERSIONED_INSTANCE_HANDLE);
	} finally {
		closeDb();
	}
});

test("a trusted client sector assignment cannot change after disclosure", async () => {
	await seedSqliteFixture();
	try {
		await assert.rejects(
			recordTrustedClientSectorMembership({
				clientId: "client-a",
				clientSector: OTHER_SECTOR,
				issuer: ISSUER,
			}),
			IMMUTABLE_SECTOR,
		);
	} finally {
		closeDb();
	}
});

test("an exact legacy row cannot bypass verified client-sector membership", async () => {
	await seedSqliteFixture();
	try {
		getDb()
			.prepare(
				"INSERT INTO pairwise_identity_handles (issuer,subject_id,client_id,kind,source_id,internal_id,handle) VALUES (?,?,?,?,?,?,?)",
			)
			.run(
				ISSUER,
				baseInput.subjectId,
				"unregistered-legacy-client",
				"instance",
				baseInput.sourceId,
				baseInput.internalId,
				"inst_legacy_unregistered",
			);
		await assert.rejects(
			getPairwiseHandle({
				...baseInput,
				clientId: "unregistered-legacy-client",
				clientSector: "https://attacker.example/sector",
			}),
			/membership|configured/i,
		);
	} finally {
		closeDb();
	}
});

test("missing, deleted, or corrupt persisted keys fail closed without request-supplied keys", async () => {
	await seedSqliteFixture();
	try {
		getDb()
			.prepare("DELETE FROM pairwise_identity_root_keys WHERE issuer=?")
			.run(ISSUER);
		await assert.rejects(getPairwiseHandle(baseInput), UNAVAILABLE_KEY);
		await initializePairwiseIdentityRootKey(ISSUER);
		await getPairwiseHandle(baseInput);
		getDb()
			.prepare("DELETE FROM pairwise_identity_root_keys WHERE issuer=?")
			.run(ISSUER);
		await assert.rejects(getPairwiseHandle(baseInput), UNAVAILABLE_KEY);
		await assert.rejects(
			getPairwiseHandle({ ...baseInput, internalId: "cin-new-after-loss" }),
			UNAVAILABLE_KEY,
		);
		await assert.rejects(
			initializePairwiseIdentityRootKey(ISSUER),
			LOST_ISSUER_KEY,
		);
		getDb()
			.prepare(
				"INSERT INTO pairwise_identity_root_keys (issuer,key_version,root_key_hex,created_at) VALUES (?,?,?,?)",
			)
			.run(ISSUER, 1, "broken", "2026-10-14T00:00:00.000Z");
		await assert.rejects(
			getPairwiseHandle({ ...baseInput, internalId: "cin-corrupt" }),
			CORRUPT_KEY,
		);
		await assert.rejects(
			initializePairwiseIdentityRootKey(ISSUER),
			CORRUPT_KEY,
		);
	} finally {
		closeDb();
	}
});

test("explicit root-key initialization is idempotent and key-version scoped", async () => {
	initDb(":memory:");
	try {
		await initializePairwiseIdentityRootKey(ISSUER);
		const first = getDb()
			.prepare(
				"SELECT root_key_hex FROM pairwise_identity_root_keys WHERE issuer=?",
			)
			.get<{ root_key_hex: string }>(ISSUER);
		await initializePairwiseIdentityRootKey(ISSUER);
		const second = getDb()
			.prepare(
				"SELECT root_key_hex FROM pairwise_identity_root_keys WHERE issuer=?",
			)
			.get<{ root_key_hex: string }>(ISSUER);
		assert.equal(first?.root_key_hex, second?.root_key_hex);
		await recordTrustedClientSectorMembership({
			clientId: "client-a",
			clientSector: SECTOR,
			issuer: ISSUER,
		});
		const handle = await getPairwiseHandle(baseInput);
		assert.equal(
			getDb()
				.prepare(
					"SELECT key_version FROM pairwise_identity_root_keys WHERE issuer=?",
				)
				.get<{ key_version: number }>(ISSUER)?.key_version,
			1,
		);
		assert.match(handle, VERSIONED_INSTANCE_HANDLE);
	} finally {
		closeDb();
	}
});

test("storage failure does not fall back to an unpersisted handle", async () => {
	await seedSqliteFixture();
	try {
		getDb().exec("DROP TABLE pairwise_identity_handles");
		await assert.rejects(
			getPairwiseHandle(baseInput),
			UNAVAILABLE_IDENTITY_STORE,
		);
	} finally {
		closeDb();
	}
});

test("persisted handles remain stable after reopening SQLite", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pdpp-pairwise-foundation-"));
	const path = join(directory, "identities.sqlite");
	try {
		initDb(path);
		await initializePairwiseIdentityRootKey(ISSUER);
		getDb()
			.prepare(
				"UPDATE pairwise_identity_root_keys SET root_key_hex=? WHERE issuer=?",
			)
			.run(TEST_KEY.toString("hex"), ISSUER);
		await recordTrustedClientSectorMembership({
			clientId: "client-a",
			clientSector: SECTOR,
			issuer: ISSUER,
		});
		const beforeRestart = await getPairwiseHandle(baseInput);
		closeDb();
		initDb(path);
		assert.equal(await getPairwiseHandle(baseInput), beforeRestart);
	} finally {
		closeDb();
		rmSync(directory, { force: true, recursive: true });
	}
});

test("SQLite upgrades the random red-stage ledger in place and ignores its handles", async () => {
	const directory = mkdtempSync(
		join(tmpdir(), "pdpp-pairwise-legacy-upgrade-"),
	);
	const path = join(directory, "identities.sqlite");
	try {
		initDb(path);
		getDb().exec("DROP TABLE pairwise_identity_handles");
		getDb().exec(`CREATE TABLE pairwise_identity_handles (
      issuer TEXT NOT NULL, subject_id TEXT NOT NULL, client_id TEXT NOT NULL,
      kind TEXT NOT NULL, source_id TEXT NOT NULL, internal_id TEXT NOT NULL,
      handle TEXT NOT NULL UNIQUE,
      PRIMARY KEY (issuer,subject_id,client_id,kind,source_id,internal_id)
    )`);
		getDb()
			.prepare("INSERT INTO pairwise_identity_handles VALUES (?,?,?,?,?,?,?)")
			.run(
				ISSUER,
				baseInput.subjectId,
				baseInput.clientId,
				"instance",
				baseInput.sourceId,
				baseInput.internalId,
				"inst_red_random",
			);
		closeDb();
		initDb(path);
		await initializePairwiseIdentityRootKey(ISSUER);
		await recordTrustedClientSectorMembership({
			clientId: baseInput.clientId,
			clientSector: SECTOR,
			issuer: ISSUER,
		});
		assert.match(await getPairwiseHandle(baseInput), HMAC_INSTANCE_HANDLE);
		assert.equal(
			getDb()
				.prepare("SELECT handle FROM pairwise_identity_handles WHERE scheme='legacy'")
				.get<{ handle: string }>()?.handle,
			"inst_red_random",
		);
		const columns = getDb()
			.prepare("PRAGMA table_info(pairwise_identity_handles)")
			.all<{ name: string }>();
		assert.ok(columns.some((column) => column.name === "client_sector"));
		assert.ok(columns.some((column) => column.name === "scheme"));
	} finally {
		closeDb();
		rmSync(directory, { force: true, recursive: true });
	}
});

test("concurrent SQLite issuance converges on the persisted identity mapping", async () => {
	await seedSqliteFixture();
	try {
		const handles = await Promise.all(
			Array.from({ length: 8 }, () => getPairwiseHandle(baseInput)),
		);
		assert.equal(new Set(handles).size, 1);
	} finally {
		closeDb();
	}
});

test("authenticated binding arrays alone translate client and RS instance IDs", () => {
	const bindings = validatePairwiseInstanceBindings([
		{
			instance_id: "inst_v1_handle-a",
			rs_instance: "rs-17",
			source_id: "source-a",
			stream: "profile",
		},
		{
			instance_id: "inst_v1_handle-a",
			rs_instance: "rs-17",
			source_id: "source-a",
			stream: "activity",
		},
	]);
	assert.equal(
		clientVisibleInstanceId("rs-17", bindings, "source-a", "profile"),
		"inst_v1_handle-a",
	);
	assert.equal(
		clientVisibleInstanceId("rs-17", bindings, "source-a", "profile"),
		"inst_v1_handle-a",
	);
	assert.equal(
		resolveInternalInstanceId(
			"inst_v1_handle-a",
			bindings,
			"source-a",
			"profile",
		),
		"rs-17",
	);
	assert.equal(
		resolveInternalInstanceId(
			"inst_v1_handle-a",
			bindings,
			"source-a",
			"profile",
		),
		"rs-17",
	);
	assert.throws(
		() => resolveInternalInstanceId("missing", bindings, "source-a", "profile"),
		MISSING_BINDING,
	);
	assert.throws(
		() =>
			validatePairwiseInstanceBindings([
				{
					instance_id: "inst_v1_same",
					rs_instance: "rs-17",
					source_id: "source-a",
				},
				{
					instance_id: "inst_v1_same",
					rs_instance: "rs-17",
					source_id: "source-b",
				},
			]),
		CROSS_SOURCE_BINDING,
	);
	assert.throws(
		() =>
			validatePairwiseInstanceBindings([
				{
					instance_id: "inst_v1_same",
					rs_instance: "rs-17",
					source_id: "source-a",
				},
				{
					instance_id: "inst_v1_same",
					rs_instance: "rs-18",
					source_id: "source-a",
				},
			]),
		CONFLICTING_BINDING,
	);
	assert.throws(
		() =>
			validatePairwiseInstanceBindings([
				{
					instance_id: "inst_v1_same",
					rs_instance: "rs-17",
					source_id: "source-a",
					stream: "profile",
				},
				{
					instance_id: "inst_v1_same",
					rs_instance: "rs-18",
					source_id: "source-a",
					stream: "activity",
				},
			]),
		CONFLICTING_BINDING,
	);
});

test("stream translations reject a different stream and malformed runtime streams", () => {
	const bindings = validatePairwiseInstanceBindings([
		{
			instance_id: "inst_profile",
			rs_instance: "rs-17",
			source_id: "source-a",
			stream: "profile",
		},
	]);
	assert.throws(
		() => clientVisibleInstanceId("rs-17", bindings, "source-a", "activity"),
		/authenticated.*binding/i,
	);
	assert.throws(
		() =>
			resolveInternalInstanceId(
				"inst_profile",
				bindings,
				"source-a",
				"activity",
			),
		/authenticated.*binding/i,
	);
	assert.throws(
		() =>
			clientVisibleInstanceId(
				"rs-17",
				bindings,
				"source-a",
				undefined as unknown as string,
			),
		/stream/i,
	);
	assert.throws(
		() =>
			resolveInternalInstanceId(
				"inst_profile",
				bindings,
				"source-a",
				17 as unknown as string,
			),
		/stream/i,
	);
});

test("client-visible translator types null bindings as grant_invalid", () => {
	assert.throws(
		() =>
			clientVisibleInstanceId("rs-17", null as never, "source-a", "profile"),
		(error: unknown) => {
			assert.equal(error instanceof PairwiseIdentityContextError, true);
			assert.equal(
				(error as PairwiseIdentityContextError).code,
				"grant_invalid",
			);
			return true;
		},
	);
});

test("internal translator types undefined bindings as grant_invalid", () => {
	assert.throws(
		() =>
			resolveInternalInstanceId(
				"inst-17",
				undefined as never,
				"source-a",
				"profile",
			),
		(error: unknown) => {
			assert.equal(error instanceof PairwiseIdentityContextError, true);
			assert.equal(
				(error as PairwiseIdentityContextError).code,
				"grant_invalid",
			);
			return true;
		},
	);
});

test("pairwise identity and binding boundaries reject malformed runtime values", async () => {
	initDb(":memory:");
	try {
		await initializePairwiseIdentityRootKey(ISSUER);
		await recordTrustedClientSectorMembership({
			clientId: baseInput.clientId,
			clientSector: SECTOR,
			issuer: ISSUER,
		});
		await completePairwiseIdentityLegacyBackfill(ISSUER);
		for (const value of ["", 17, null]) {
			await assert.rejects(
				initializePairwiseIdentityRootKey(value as unknown as string),
			);
			await assert.rejects(
				getPairwiseHandle({
					...baseInput,
					issuer: value,
				} as PairwiseHandleInput),
			);
			await assert.rejects(
				getPairwiseHandle({
					...baseInput,
					clientId: value,
				} as PairwiseHandleInput),
			);
			await assert.rejects(
				getPairwiseHandle({
					...baseInput,
					clientSector: value,
				} as PairwiseHandleInput),
			);
			await assert.rejects(
				getPairwiseHandle({
					...baseInput,
					subjectId: value,
				} as PairwiseHandleInput),
			);
			await assert.rejects(
				getPairwiseHandle({
					...baseInput,
					internalId: value,
				} as PairwiseHandleInput),
			);
			for (const field of ["clientId", "clientSector", "issuer"] as const) {
				await assert.rejects(
					recordTrustedClientSectorMembership({
						clientId: "client-a",
						clientSector: SECTOR,
						issuer: ISSUER,
						[field]: value,
					} as never),
				);
				await assert.rejects(
					backfillTrustedClientSectorMembership({
						clientId: "client-a",
						clientSector: SECTOR,
						issuer: ISSUER,
						[field]: value,
					} as never),
				);
			}
		}
		await assert.rejects(
			getPairwiseHandle({
				...baseInput,
				kind: "bogus",
			} as unknown as PairwiseHandleInput),
		);
		await assert.rejects(
			migratePairwiseIdentityIssuer({ fromIssuer: "", toIssuer: ISSUER }),
		);
		await assert.rejects(
			migratePairwiseIdentityIssuer({
				fromIssuer: "local",
				toIssuer: 17 as unknown as string,
			}),
		);
		await assert.rejects(
			initializePairwiseIdentityRootKey(""),
			(error: unknown) => {
				assert.equal(error instanceof PairwiseIdentityDeploymentError, true);
				assert.equal("code" in (error as object), false);
				return true;
			},
		);
	} finally {
		closeDb();
	}
	const validBinding = {
		source_id: "source-a",
		instance_id: "inst-1",
		rs_instance: "rs-1",
		stream: "profile",
	};
	for (const malformed of [
		undefined,
		{},
		[null],
		[{ ...validBinding, source_id: 17 }],
		[{ ...validBinding, instance_id: 17 }],
		[{ ...validBinding, rs_instance: {} }],
		[{ ...validBinding, stream: "" }],
		[{ ...validBinding, stream: undefined }],
	]) {
		assert.throws(
			() => validatePairwiseInstanceBindings(malformed as never),
			(error: unknown) => {
				assert.equal((error as Error).name, "PairwiseIdentityContextError");
				assert.notEqual(error instanceof TypeError, true);
				return true;
			},
		);
	}
});

test("prototype local-issuer rows migrate explicitly without changing disclosed handles", async () => {
	initDb(":memory:");
	try {
		const insert = getDb().prepare(
			"INSERT INTO pairwise_identity_handles (issuer,subject_id,client_id,kind,source_id,internal_id,handle) VALUES (?,?,?,?,?,?,?)",
		);
		insert.run(
			"local",
			"person-4",
			"prototype-client",
			"instance",
			"source-primary",
			"cin_stable-17",
			"inst_proto_random",
		);
		insert.run(
			"local",
			"person-4",
			"prototype-client",
			"subject",
			"",
			"person-4",
			"sub_proto_random",
		);
		await initializePairwiseIdentityRootKey("local");
		await recordTrustedClientSectorMembership({
			clientId: "prototype-client",
			clientSector: SECTOR,
			issuer: "local",
		});
		await completePairwiseIdentityLegacyBackfill("local");
		const sourceKey = getDb()
			.prepare(
				"SELECT root_key_hex FROM pairwise_identity_root_keys WHERE issuer='local'",
			)
			.get<{ root_key_hex: string }>()?.root_key_hex;
		await assert.rejects(
			initializePairwiseIdentityRootKey(ISSUER),
			/migration/i,
		);
		await migratePairwiseIdentityIssuer({
			fromIssuer: "local",
			toIssuer: ISSUER,
		});
		assert.equal(
			getDb()
				.prepare(
					"SELECT root_key_hex FROM pairwise_identity_root_keys WHERE issuer=?",
				)
				.get<{ root_key_hex: string }>(ISSUER)?.root_key_hex,
			sourceKey,
		);
		assert.equal(
			getDb()
				.prepare("SELECT issuer FROM pairwise_identity_legacy_backfills")
				.get<{ issuer: string }>()?.issuer,
			ISSUER,
		);
		await initializePairwiseIdentityRootKey(ISSUER);
		await recordTrustedClientSectorMembership({
			clientId: "prototype-client",
			clientSector: SECTOR,
			issuer: ISSUER,
		});
		await completePairwiseIdentityLegacyBackfill(ISSUER);
		assert.match(
			await getPairwiseHandle({ ...baseInput, clientId: "prototype-client" }),
			HMAC_INSTANCE_HANDLE,
		);
		assert.match(
			await getPairwiseHandle({
				...baseInput,
				clientId: "prototype-client",
				kind: "subject",
				internalId: "person-4",
			}),
			HMAC_SUBJECT_HANDLE,
		);
		await assert.rejects(
			migratePairwiseIdentityIssuer({
				fromIssuer: "local",
				toIssuer: ISSUER,
			}),
		);
	} finally {
		closeDb();
	}
});

test("issuer migration failure leaves source identifiers and deployment issuer unchanged", async () => {
	initDb(":memory:");
	try {
		await initializePairwiseIdentityRootKey("local");
		await recordTrustedClientSectorMembership({
			clientId: "source-client",
			clientSector: SECTOR,
			issuer: "local",
		});
		const insert = getDb().prepare(
			"INSERT INTO pairwise_identity_handles (issuer,subject_id,client_id,kind,source_id,internal_id,handle) VALUES (?,?,?,?,?,?,?)",
		);
		insert.run(
			"local",
			"person-4",
			"source-client",
			"instance",
			"source",
			"cin-1",
			"inst_local_preserved",
		);
		insert.run(
			ISSUER,
			"person-5",
			"target-client",
			"instance",
			"source",
			"cin-2",
			"inst_target_exists",
		);
		await assert.rejects(
			migratePairwiseIdentityIssuer({
				fromIssuer: "local",
				toIssuer: ISSUER,
			}),
		);
		assert.equal(
			getDb()
				.prepare(
					"SELECT issuer FROM pairwise_identity_deployment WHERE singleton_id=1",
				)
				.get<{ issuer: string }>()?.issuer,
			"local",
		);
		assert.equal(
			getDb()
				.prepare(
					"SELECT handle FROM pairwise_identity_handles WHERE issuer='local' AND internal_id='cin-1'",
				)
				.get<{ handle: string }>()?.handle,
			"inst_local_preserved",
		);
	} finally {
		closeDb();
	}
});

test("issuer migration rejects an unknown source and mixed legacy namespaces", async () => {
	initDb(":memory:");
	try {
		await assert.rejects(
			migratePairwiseIdentityIssuer({ fromIssuer: "locale", toIssuer: ISSUER }),
		);
		const insert = getDb().prepare(
			"INSERT INTO pairwise_identity_handles (issuer,subject_id,client_id,kind,source_id,internal_id,handle) VALUES (?,?,?,?,?,?,?)",
		);
		insert.run(
			"local",
			"person-4",
			"prototype-client",
			"instance",
			"source",
			"cin-proto",
			"inst_proto_random",
		);
		await assert.rejects(
			migratePairwiseIdentityIssuer({ fromIssuer: "locale", toIssuer: ISSUER }),
		);
		assert.equal(
			getDb()
				.prepare(
					"SELECT issuer FROM pairwise_identity_deployment WHERE singleton_id=1",
				)
				.get(),
			undefined,
		);
		insert.run(
			"https://old-as.example",
			"person-5",
			"old-client",
			"instance",
			"source",
			"cin-old",
			"inst_old_random",
		);
		await assert.rejects(
			migratePairwiseIdentityIssuer({
				fromIssuer: "https://old-as.example",
				toIssuer: ISSUER,
			}),
		);
		assert.equal(
			getDb()
				.prepare(
					"SELECT count(*) AS count FROM pairwise_identity_issuer_migrations",
				)
				.get<{ count: number }>()?.count,
			0,
		);
		await assert.rejects(initializePairwiseIdentityRootKey(ISSUER));
		getDb()
			.prepare(
				"INSERT INTO pairwise_identity_deployment (singleton_id,issuer) VALUES (1,?)",
			)
			.run(ISSUER);
		await assert.rejects(initializePairwiseIdentityRootKey(ISSUER));
		await assert.rejects(completePairwiseIdentityLegacyBackfill(ISSUER));
		await assert.rejects(
			getPairwiseHandle({ ...baseInput, clientId: "prototype-client" }),
		);
		assert.deepEqual(
			getDb()
				.prepare(
					"SELECT issuer,handle FROM pairwise_identity_handles ORDER BY issuer",
				)
				.all(),
			[
				{ issuer: "https://old-as.example", handle: "inst_old_random" },
				{ issuer: "local", handle: "inst_proto_random" },
			],
		);
	} finally {
		closeDb();
	}
});

test("issuer migration rolls back every namespace change after a mid-transaction failure", async () => {
	initDb(":memory:");
	try {
		getDb()
			.prepare(
				"INSERT INTO pairwise_identity_handles (issuer,subject_id,client_id,kind,source_id,internal_id,handle) VALUES ('local','person-4','prototype-client','instance','source','cin-proto','inst_proto_random')",
			)
			.run();
		await initializePairwiseIdentityRootKey("local");
		await recordTrustedClientSectorMembership({
			clientId: "prototype-client",
			clientSector: SECTOR,
			issuer: "local",
		});
		getDb().exec(
			`CREATE TRIGGER fail_pairwise_migration BEFORE INSERT ON pairwise_identity_issuer_migrations BEGIN SELECT RAISE(ABORT, 'forced migration failure'); END`,
		);
		await assert.rejects(
			migratePairwiseIdentityIssuer({ fromIssuer: "local", toIssuer: ISSUER }),
			/forced migration failure/,
		);
		assert.equal(
			getDb()
				.prepare(
					"SELECT issuer FROM pairwise_identity_deployment WHERE singleton_id=1",
				)
				.get<{ issuer: string }>()?.issuer,
			"local",
		);
		assert.equal(
			getDb()
				.prepare(
					"SELECT issuer FROM pairwise_identity_handles WHERE handle='inst_proto_random'",
				)
				.get<{ issuer: string }>()?.issuer,
			"local",
		);
		assert.equal(
			getDb()
				.prepare(
					"SELECT issuer FROM pairwise_trusted_client_sectors WHERE client_id='prototype-client'",
				)
				.get<{ issuer: string }>()?.issuer,
			"local",
		);
		assert.equal(
			getDb()
				.prepare("SELECT issuer FROM pairwise_identity_root_keys")
				.get<{ issuer: string }>()?.issuer,
			"local",
		);
		assert.equal(
			getDb()
				.prepare(
					"SELECT count(*) AS count FROM pairwise_identity_issuer_migrations",
				)
				.get<{ count: number }>()?.count,
			0,
		);
	} finally {
		closeDb();
	}
});

test("HMAC issuance does not require legacy membership backfill", async () => {
	initDb(":memory:");
	try {
		await initializePairwiseIdentityRootKey(ISSUER);
		const insert = getDb().prepare(
			"INSERT INTO pairwise_identity_handles (issuer,subject_id,client_id,kind,source_id,internal_id,handle) VALUES (?,?,?,?,?,?,?)",
		);
		insert.run(
			ISSUER,
			baseInput.subjectId,
			"legacy-unregistered",
			"instance",
			"old-source",
			"old-id",
			"inst_legacy_unregistered",
		);
		await recordTrustedClientSectorMembership({
			clientId: baseInput.clientId,
			clientSector: SECTOR,
			issuer: ISSUER,
		});
		assert.match(await getPairwiseHandle(baseInput), HMAC_INSTANCE_HANDLE);
		await assert.rejects(
			completePairwiseIdentityLegacyBackfill(ISSUER),
			(error: unknown) => error instanceof PairwiseIdentityDeploymentError,
		);
		await recordTrustedClientSectorMembership({
			clientId: "legacy-unregistered",
			clientSector: SECTOR,
			issuer: ISSUER,
		});
		await completePairwiseIdentityLegacyBackfill(ISSUER);
		assert.match(await getPairwiseHandle(baseInput), VERSIONED_INSTANCE_HANDLE);
		getDb()
			.prepare(
				"INSERT INTO pairwise_identity_handles (issuer,subject_id,client_id,kind,source_id,internal_id,handle) VALUES (?,?,?,?,?,?,?)",
			)
			.run(
				ISSUER,
				baseInput.subjectId,
				"late-legacy",
				"instance",
				"old-source",
				"late-id",
				"inst_late_legacy",
			);
		await recordTrustedClientSectorMembership({
			clientId: "late-legacy",
			clientSector: SECTOR,
			issuer: ISSUER,
		});
		assert.match(
			await getPairwiseHandle({ ...baseInput, clientId: "late-legacy" }),
			HMAC_INSTANCE_HANDLE,
		);
	} finally {
		closeDb();
	}
});

test("a conflicting legacy sector merge does not affect HMAC identity", async () => {
	initDb(":memory:");
	try {
		await initializePairwiseIdentityRootKey(ISSUER);
		await recordTrustedClientSectorMembership({
			clientId: "legacy-a",
			clientSector: SECTOR,
			issuer: ISSUER,
		});
		const insert = getDb().prepare(
			"INSERT INTO pairwise_identity_handles (issuer,subject_id,client_id,kind,source_id,internal_id,handle) VALUES (?,?,?,?,?,?,?)",
		);
		insert.run(
			ISSUER,
			baseInput.subjectId,
			"legacy-a",
			"instance",
			"source-a",
			"cin-conflict",
			"inst_legacy_a",
		);
		insert.run(
			ISSUER,
			baseInput.subjectId,
			"legacy-b",
			"instance",
			"source-b",
			"cin-conflict",
			"inst_legacy_b",
		);
		await recordTrustedClientSectorMembership({
			clientId: "legacy-b",
			clientSector: SECTOR,
			issuer: ISSUER,
		});
		assert.ok(
			getDb()
				.prepare(
					"SELECT 1 AS present FROM pairwise_trusted_client_sectors WHERE issuer=? AND client_id=?",
				)
				.get(ISSUER, "legacy-b"),
		);
		await recordTrustedClientSectorMembership({
			clientId: "unrelated-same-sector",
			clientSector: SECTOR,
			issuer: ISSUER,
		});
		await recordTrustedClientSectorMembership({
			clientId: "other-sector-client",
			clientSector: OTHER_SECTOR,
			issuer: ISSUER,
		});
		const other = await getPairwiseHandle({
			...baseInput,
			clientId: "other-sector-client",
			clientSector: OTHER_SECTOR,
			internalId: "cin-other",
		});
		assert.match(other, VERSIONED_INSTANCE_HANDLE);
	} finally {
		closeDb();
	}
});

test("backfilled conflicting legacy facts do not block HMAC issuance", async () => {
	initDb(":memory:");
	try {
		await initializePairwiseIdentityRootKey(ISSUER);
		const insert = getDb().prepare(
			"INSERT INTO pairwise_identity_handles (issuer,subject_id,client_id,kind,source_id,internal_id,handle) VALUES (?,?,?,?,?,?,?)",
		);
		insert.run(
			ISSUER,
			baseInput.subjectId,
			"old-a",
			"instance",
			"source-a",
			"cin-existing-conflict",
			"inst_old_a",
		);
		insert.run(
			ISSUER,
			baseInput.subjectId,
			"old-b",
			"instance",
			"source-b",
			"cin-existing-conflict",
			"inst_old_b",
		);
		for (const clientId of ["old-a", "old-b"]) {
			await backfillTrustedClientSectorMembership({
				clientId,
				clientSector: SECTOR,
				issuer: ISSUER,
			});
		}
		await completePairwiseIdentityLegacyBackfill(ISSUER);
		assert.match(
			await getPairwiseHandle({
				...baseInput,
				clientId: "old-a",
				internalId: "cin-existing-conflict",
			}),
			HMAC_INSTANCE_HANDLE,
		);
		await recordTrustedClientSectorMembership({
			clientId: "other-sector-client",
			clientSector: OTHER_SECTOR,
			issuer: ISSUER,
		});
		assert.match(
			await getPairwiseHandle({
				...baseInput,
				clientId: "other-sector-client",
				clientSector: OTHER_SECTOR,
				internalId: "cin-existing-conflict",
			}),
			VERSIONED_INSTANCE_HANDLE,
		);
	} finally {
		closeDb();
	}
});

test("legacy source aliases do not affect HMAC issuance", async () => {
	initDb(":memory:");
	try {
		await initializePairwiseIdentityRootKey(ISSUER);
		const insert = getDb().prepare(
			"INSERT INTO pairwise_identity_handles (issuer,subject_id,client_id,kind,source_id,internal_id,handle) VALUES (?,?,?,?,?,?,?)",
		);
		insert.run(
			ISSUER,
			baseInput.subjectId,
			"alias-client",
			"instance",
			"source-x",
			"cin-alias",
			"inst_alias_x",
		);
		insert.run(
			ISSUER,
			baseInput.subjectId,
			"alias-client",
			"instance",
			"source-y",
			"cin-alias",
			"inst_alias_y",
		);
		await backfillTrustedClientSectorMembership({
			clientId: "alias-client",
			clientSector: SECTOR,
			issuer: ISSUER,
		});
		await recordTrustedClientSectorMembership({
			clientId: "alias-sibling",
			clientSector: SECTOR,
			issuer: ISSUER,
		});
		await completePairwiseIdentityLegacyBackfill(ISSUER);
		let issued: string | undefined;
		for (const clientId of ["alias-client", "alias-sibling"]) {
			for (const sourceId of ["source-x", "source-y", "source-z"]) {
				const input = {
					...baseInput,
					clientId,
					internalId: "cin-alias",
					sourceId,
				};
				const handle = await getPairwiseHandle(input);
				assert.match(handle, HMAC_INSTANCE_HANDLE);
				if (issued) {
					assert.equal(handle, issued);
				}
				issued = handle;
			}
		}
		await recordTrustedClientSectorMembership({
			clientId: "other-sector-client",
			clientSector: OTHER_SECTOR,
			issuer: ISSUER,
		});
		assert.match(
			await getPairwiseHandle({
				...baseInput,
				clientId: "other-sector-client",
				clientSector: OTHER_SECTOR,
				internalId: "cin-alias",
			}),
			VERSIONED_INSTANCE_HANDLE,
		);
	} finally {
		closeDb();
	}
});

test("raw invalid binding arrays cannot bypass validation in either translation direction", () => {
	const crossSource = [
		{ instance_id: "inst-cross", rs_instance: "rs-a", source_id: "source-a" },
		{ instance_id: "inst-cross", rs_instance: "rs-b", source_id: "source-b" },
	];
	assert.throws(
		() =>
			resolveInternalInstanceId(
				"inst-cross",
				crossSource,
				"source-a",
				"profile",
			),
		CROSS_SOURCE_BINDING,
	);
	assert.throws(
		() => clientVisibleInstanceId("rs-a", crossSource, "source-a", "profile"),
		CROSS_SOURCE_BINDING,
	);
	const splitHandle = [
		{
			instance_id: "inst-split",
			rs_instance: "rs-a",
			source_id: "source-a",
			stream: "profile",
		},
		{
			instance_id: "inst-split",
			rs_instance: "rs-b",
			source_id: "source-a",
			stream: "activity",
		},
	];
	assert.throws(
		() =>
			resolveInternalInstanceId(
				"inst-split",
				splitHandle,
				"source-a",
				"profile",
			),
		CONFLICTING_BINDING,
	);
	assert.throws(
		() => clientVisibleInstanceId("rs-a", splitHandle, "source-a", "profile"),
		CONFLICTING_BINDING,
	);
});

test("binding validation enforces a bijection between stored instances and handles across streams", () => {
	assert.throws(
		() =>
			validatePairwiseInstanceBindings([
				{
					instance_id: "inst-one",
					rs_instance: "rs-one",
					source_id: "source-a",
					stream: "profile",
				},
				{
					instance_id: "inst-two",
					rs_instance: "rs-one",
					source_id: "source-a",
					stream: "activity",
				},
			]),
		CONFLICTING_BINDING,
	);
});

test("configured issuer changes need migration; another deployment database can use a distinct issuer", async () => {
	await seedSqliteFixture();
	try {
		const before = await getPairwiseHandle(baseInput);
		await assert.rejects(
			initializePairwiseIdentityRootKey(`${ISSUER}/`),
			/issuer|migration|configured/i,
		);
		await migratePairwiseIdentityIssuer({
			fromIssuer: ISSUER,
			toIssuer: `${ISSUER}/`,
		});
		await recordTrustedClientSectorMembership({
			clientId: "client-a",
			clientSector: SECTOR,
			issuer: `${ISSUER}/`,
		});
		assert.equal(
			await getPairwiseHandle({ ...baseInput, issuer: `${ISSUER}/` }),
			before,
		);
		await assert.rejects(
			initializePairwiseIdentityRootKey("https://another-as.example"),
			/configured issuer/i,
		);
		await assert.rejects(
			recordTrustedClientSectorMembership({
				clientId: "drift-client",
				clientSector: SECTOR,
				issuer: "https://another-as.example",
			}),
			/configured issuer/i,
		);
		await assert.rejects(
			getPairwiseHandle({ ...baseInput, issuer: "https://another-as.example" }),
			/configured issuer/i,
		);
		closeDb();
		initDb(":memory:");
		const secondIssuer = "https://another-as.example";
		await initializePairwiseIdentityRootKey(secondIssuer);
		await recordTrustedClientSectorMembership({
			clientId: "client-a",
			clientSector: SECTOR,
			issuer: secondIssuer,
		});
		assert.match(
			await getPairwiseHandle({ ...baseInput, issuer: secondIssuer }),
			VERSIONED_INSTANCE_HANDLE,
		);
	} finally {
		closeDb();
	}
});

test("identity tables, issuer config, and migration ledgers are backup-required", () => {
	for (const table of [
		"pairwise_identity_handles",
		"pairwise_identity_root_keys",
		"pairwise_trusted_client_sectors",
		"pairwise_identity_deployment",
		"pairwise_identity_legacy_backfills",
		"pairwise_identity_issuer_migrations",
	]) {
		assert.equal(
			BACKUP_TABLE_INVENTORY[table]?.classification,
			"backup_required",
		);
	}
});

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;
let postgresCounter = 0;
const tempDbName = () => {
	postgresCounter += 1;
	return `pdpp_pairwise_identity_${process.pid}_${postgresCounter}`;
};

if (POSTGRES_URL) {
	test("PostgreSQL cold bootstrap, key custody, migration, and concurrent issuance match SQLite", async () => {
		await withTemporaryPostgresDatabase(
			{
				closeConnections: closePostgresStorage,
				connectionString: POSTGRES_URL,
				databaseName: tempDbName(),
				templateName: null,
			},
			async (databaseUrl) => {
				const legacyPool = new Pool({ connectionString: databaseUrl });
				try {
					await legacyPool.query(`CREATE TABLE pairwise_identity_handles (
            issuer TEXT NOT NULL, subject_id TEXT NOT NULL, client_id TEXT NOT NULL,
            kind TEXT NOT NULL CHECK (kind IN ('subject','grantor','instance')),
            source_id TEXT NOT NULL, internal_id TEXT NOT NULL, handle TEXT NOT NULL UNIQUE,
            PRIMARY KEY (issuer,subject_id,client_id,kind,source_id,internal_id)
          )`);
					await legacyPool.query(
						`INSERT INTO pairwise_identity_handles (issuer,subject_id,client_id,kind,source_id,internal_id,handle)
             VALUES ($1,$2,$3,'instance',$4,$5,'inst_pg_red_random')`,
						[
							ISSUER,
							baseInput.subjectId,
							baseInput.clientId,
							baseInput.sourceId,
							"cin-red-upgrade",
						],
					);
				} finally {
					await legacyPool.end();
				}
				await initPostgresStorage({ backend: "postgres", databaseUrl });
				await initializePairwiseIdentityRootKey(ISSUER);
				await postgresQuery(
					"UPDATE pairwise_identity_root_keys SET root_key_hex=$1 WHERE issuer=$2",
					[TEST_KEY.toString("hex"), ISSUER],
				);
				await recordTrustedClientSectorMembership({
					clientId: baseInput.clientId,
					clientSector: SECTOR,
					issuer: ISSUER,
				});
				assert.equal(
					await getPairwiseHandle({
						...baseInput,
						internalId: "cin-red-upgrade",
					}),
					expectedHandle({ ...baseInput, internalId: "cin-red-upgrade" }),
				);
				const provisionedBefore = await postgresQuery<{ root_key_hex: string }>(
					"SELECT root_key_hex FROM pairwise_identity_root_keys WHERE issuer=$1",
					[ISSUER],
				);
				await initializePairwiseIdentityRootKey(ISSUER);
				const provisionedAfter = await postgresQuery<{ root_key_hex: string }>(
					"SELECT root_key_hex FROM pairwise_identity_root_keys WHERE issuer=$1",
					[ISSUER],
				);
				assert.equal(
					provisionedBefore.rows[0]?.root_key_hex,
					provisionedAfter.rows[0]?.root_key_hex,
				);
				await recordTrustedClientSectorMembership({
					clientId: "client-a",
					clientSector: SECTOR,
					issuer: ISSUER,
				});
				await recordTrustedClientSectorMembership({
					clientId: "client-b",
					clientSector: SECTOR,
					issuer: ISSUER,
				});
				const handles = await Promise.all(
					Array.from({ length: 8 }, () => getPairwiseHandle(baseInput)),
				);
				assert.equal(new Set(handles).size, 1);
				assert.equal(handles[0], expectedHandle(baseInput));
				assert.equal(
					await getPairwiseHandle({ ...baseInput, sourceId: "source-alias" }),
					handles[0],
				);
				await recordTrustedClientSectorMembership({
					clientId: "client-other-sector",
					clientSector: OTHER_SECTOR,
					issuer: ISSUER,
				});
				const otherSector = await getPairwiseHandle({
					...baseInput,
					clientId: "client-other-sector",
					clientSector: OTHER_SECTOR,
				});
				assert.notEqual(otherSector, handles[0]);
				const legacyId = "cin-legacy-pg";
				await postgresQuery(
					`INSERT INTO pairwise_identity_handles (issuer,subject_id,client_id,kind,source_id,internal_id,handle)
           VALUES ($1,$2,$3,'instance','legacy-source',$4,'inst_pg_legacy')`,
					[ISSUER, baseInput.subjectId, baseInput.clientId, legacyId],
				);
				assert.equal(
					await getPairwiseHandle({
						...baseInput,
						internalId: legacyId,
						sourceId: "new-source-alias",
					}),
					expectedHandle({ ...baseInput, internalId: legacyId }),
				);
				await recordTrustedClientSectorMembership({
					clientId: "old-client-pg-a",
					clientSector: SECTOR,
					issuer: ISSUER,
				});
				await recordTrustedClientSectorMembership({
					clientId: "old-client-pg-b",
					clientSector: SECTOR,
					issuer: ISSUER,
				});
				await recordTrustedClientSectorMembership({
					clientId: "new-client-pg",
					clientSector: SECTOR,
					issuer: ISSUER,
				});
				await postgresQuery(
					`INSERT INTO pairwise_identity_handles (issuer,subject_id,client_id,kind,source_id,internal_id,handle)
           VALUES ($1,$2,'old-client-pg-a','instance','old-source',$3,'inst_pg_ambiguous_a'),
                  ($1,$2,'old-client-pg-b','instance','old-source',$3,'inst_pg_ambiguous_b')`,
					[ISSUER, baseInput.subjectId, "cin-ambiguous-pg"],
				);
				assert.equal(
					await getPairwiseHandle({
						...baseInput,
						clientId: "new-client-pg",
						internalId: "cin-ambiguous-pg",
					}),
					expectedHandle({ ...baseInput, internalId: "cin-ambiguous-pg" }),
				);
				await initPostgresStorage({ backend: "postgres", databaseUrl });
				assert.equal(
					await getPairwiseHandle({ ...baseInput, clientId: "client-b" }),
					handles[0],
				);
				const schemaRows = await getPostgresPool().query<{
					table_name: string;
				}>(
					`SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema()
             AND table_name = ANY($1::text[])`,
					[
						[
							"pairwise_identity_handles",
							"pairwise_identity_root_keys",
							"pairwise_trusted_client_sectors",
							"pairwise_identity_deployment",
							"pairwise_identity_legacy_backfills",
							"pairwise_identity_issuer_migrations",
						],
					],
				);
				assert.equal(schemaRows.rows.length, 6);
				await postgresQuery(
					"DELETE FROM pairwise_identity_root_keys WHERE issuer=$1",
					[ISSUER],
				);
				await assert.rejects(getPairwiseHandle(baseInput), UNAVAILABLE_KEY);
				await assert.rejects(
					getPairwiseHandle({
						...baseInput,
						internalId: "cin-after-pg-key-loss",
					}),
					UNAVAILABLE_KEY,
				);
				await assert.rejects(
					initializePairwiseIdentityRootKey(ISSUER),
					LOST_ISSUER_KEY,
				);
			},
		);
	});

test("PostgreSQL default issuance ignores prototype legacy mappings", async () => {
		await withTemporaryPostgresDatabase(
			{
				closeConnections: closePostgresStorage,
				connectionString: POSTGRES_URL,
				databaseName: tempDbName(),
				templateName: null,
			},
			async (databaseUrl) => {
				await initPostgresStorage({ backend: "postgres", databaseUrl });
				await postgresQuery(
					`INSERT INTO pairwise_identity_handles
						(issuer,subject_id,client_id,kind,source_id,internal_id,handle)
					 VALUES ('local','person-4','prototype-client','instance','source','cin-proto','inst_proto_random')`,
				);
				await initializePairwiseIdentityRootKey("local");
				await recordTrustedClientSectorMembership({
					clientId: "prototype-client",
					clientSector: SECTOR,
					issuer: "local",
				});
				await completePairwiseIdentityLegacyBackfill("local");
				const sourceKey = (
					await postgresQuery<{ root_key_hex: string }>(
						"SELECT root_key_hex FROM pairwise_identity_root_keys WHERE issuer='local'",
					)
				).rows[0]?.root_key_hex;
				await migratePairwiseIdentityIssuer({
					fromIssuer: "local",
					toIssuer: ISSUER,
				});
				assert.equal(
					(
						await postgresQuery<{ root_key_hex: string }>(
							"SELECT root_key_hex FROM pairwise_identity_root_keys WHERE issuer=$1",
							[ISSUER],
						)
					).rows[0]?.root_key_hex,
					sourceKey,
				);
				assert.equal(
					(
						await postgresQuery<{ issuer: string }>(
							"SELECT issuer FROM pairwise_identity_legacy_backfills",
						)
					).rows[0]?.issuer,
					ISSUER,
				);
				const migrated = await postgresQuery<{
					issuer: string;
					handle: string;
				}>(
					"SELECT issuer,handle FROM pairwise_identity_handles WHERE client_id='prototype-client'",
				);
				assert.deepEqual(migrated.rows[0], {
					issuer: ISSUER,
					handle: "inst_proto_random",
				});
				await initializePairwiseIdentityRootKey(ISSUER);
				await recordTrustedClientSectorMembership({
					clientId: "prototype-client",
					clientSector: SECTOR,
					issuer: ISSUER,
				});
				await completePairwiseIdentityLegacyBackfill(ISSUER);
				assert.match(
					await getPairwiseHandle({
						...baseInput,
						clientId: "prototype-client",
						internalId: "cin-proto",
					}),
					HMAC_INSTANCE_HANDLE,
				);
			},
		);
	});

	test("PostgreSQL refuses unknown-source and mixed-issuer migrations before pinning state", async () => {
		await withTemporaryPostgresDatabase(
			{
				closeConnections: closePostgresStorage,
				connectionString: POSTGRES_URL,
				databaseName: tempDbName(),
				templateName: null,
			},
			async (databaseUrl) => {
				await initPostgresStorage({ backend: "postgres", databaseUrl });
				await assert.rejects(
					migratePairwiseIdentityIssuer({
						fromIssuer: "locale",
						toIssuer: ISSUER,
					}),
				);
				for (const [issuer, handle] of [
					["local", "inst_proto_random"],
					["https://old-as.example", "inst_old_random"],
				] as const) {
					await postgresQuery(
						"INSERT INTO pairwise_identity_handles (issuer,subject_id,client_id,kind,source_id,internal_id,handle) VALUES ($1,'person-4','prototype-client','instance','source',$2,$3)",
						[issuer, handle.replace("inst_", "cin-"), handle],
					);
				}
				await assert.rejects(
					migratePairwiseIdentityIssuer({
						fromIssuer: "locale",
						toIssuer: ISSUER,
					}),
				);
				await assert.rejects(
					migratePairwiseIdentityIssuer({
						fromIssuer: "https://old-as.example",
						toIssuer: ISSUER,
					}),
				);
				assert.equal(
					(
						await postgresQuery(
							"SELECT count(*)::int AS count FROM pairwise_identity_issuer_migrations",
						)
					).rows[0]?.count,
					0,
				);
				assert.equal(
					(
						await postgresQuery(
							"SELECT count(*)::int AS count FROM pairwise_identity_deployment",
						)
					).rows[0]?.count,
					0,
				);
				await assert.rejects(initializePairwiseIdentityRootKey(ISSUER));
				await postgresQuery(
					"INSERT INTO pairwise_identity_deployment (singleton_id,issuer) VALUES (1,$1)",
					[ISSUER],
				);
				await assert.rejects(initializePairwiseIdentityRootKey(ISSUER));
				await assert.rejects(completePairwiseIdentityLegacyBackfill(ISSUER));
				await assert.rejects(
					getPairwiseHandle({ ...baseInput, clientId: "prototype-client" }),
				);
				assert.deepEqual(
					(
						await postgresQuery(
							"SELECT issuer,handle FROM pairwise_identity_handles ORDER BY issuer",
						)
					).rows,
					[
						{ issuer: "https://old-as.example", handle: "inst_old_random" },
						{ issuer: "local", handle: "inst_proto_random" },
					],
				);
			},
		);
	});

	test("PostgreSQL migration source, target, and mid-transaction failures preserve all state", async () => {
		await withTemporaryPostgresDatabase(
			{
				closeConnections: closePostgresStorage,
				connectionString: POSTGRES_URL,
				databaseName: tempDbName(),
				templateName: null,
			},
			async (databaseUrl) => {
				await initPostgresStorage({ backend: "postgres", databaseUrl });
				await initializePairwiseIdentityRootKey("local");
				await recordTrustedClientSectorMembership({
					clientId: "prototype-client",
					clientSector: SECTOR,
					issuer: "local",
				});
				await postgresQuery(
					"INSERT INTO pairwise_identity_handles (issuer,subject_id,client_id,kind,source_id,internal_id,handle) VALUES ('local','person-4','prototype-client','instance','source','cin-proto','inst_proto_random')",
				);
				await assert.rejects(
					migratePairwiseIdentityIssuer({
						fromIssuer: "other",
						toIssuer: ISSUER,
					}),
				);
				await postgresQuery(
					"INSERT INTO pairwise_identity_handles (issuer,subject_id,client_id,kind,source_id,internal_id,handle) VALUES ($1,'person-5','target-client','instance','source','cin-target','inst_target_random')",
					[ISSUER],
				);
				await assert.rejects(
					migratePairwiseIdentityIssuer({
						fromIssuer: "local",
						toIssuer: ISSUER,
					}),
				);
				await postgresQuery(
					"DELETE FROM pairwise_identity_handles WHERE issuer=$1",
					[ISSUER],
				);
				await postgresQuery(
					`CREATE FUNCTION fail_pairwise_migration() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced migration failure'; END $$`,
				);
				await postgresQuery(
					"CREATE TRIGGER fail_pairwise_migration BEFORE INSERT ON pairwise_identity_issuer_migrations FOR EACH ROW EXECUTE FUNCTION fail_pairwise_migration()",
				);
				await assert.rejects(
					migratePairwiseIdentityIssuer({
						fromIssuer: "local",
						toIssuer: ISSUER,
					}),
					/forced migration failure/,
				);
				assert.equal(
					(
						await postgresQuery(
							"SELECT issuer FROM pairwise_identity_deployment WHERE singleton_id=1",
						)
					).rows[0]?.issuer,
					"local",
				);
				assert.equal(
					(
						await postgresQuery(
							"SELECT issuer FROM pairwise_identity_handles WHERE handle='inst_proto_random'",
						)
					).rows[0]?.issuer,
					"local",
				);
				assert.equal(
					(
						await postgresQuery(
							"SELECT issuer FROM pairwise_trusted_client_sectors WHERE client_id='prototype-client'",
						)
					).rows[0]?.issuer,
					"local",
				);
				assert.equal(
					(
						await postgresQuery(
							"SELECT issuer FROM pairwise_identity_root_keys",
						)
					).rows[0]?.issuer,
					"local",
				);
				assert.equal(
					(
						await postgresQuery(
							"SELECT count(*)::int AS count FROM pairwise_identity_issuer_migrations",
						)
					).rows[0]?.count,
					0,
				);
			},
		);
	});

	test("PostgreSQL HMAC issuance ignores legacy registration conflicts", async () => {
		await withTemporaryPostgresDatabase(
			{
				closeConnections: closePostgresStorage,
				connectionString: POSTGRES_URL,
				databaseName: tempDbName(),
				templateName: null,
			},
			async (databaseUrl) => {
				await initPostgresStorage({ backend: "postgres", databaseUrl });
				await initializePairwiseIdentityRootKey(ISSUER);
				await recordTrustedClientSectorMembership({
					clientId: "client-a",
					clientSector: SECTOR,
					issuer: ISSUER,
				});
				assert.equal(
					await lookupPairwiseInstanceMapping({
						clientId: "client-a",
						clientSector: SECTOR,
						instanceHandle: "inst_missing_lookup",
						issuer: ISSUER,
						subjectId: baseInput.subjectId,
					}),
					null,
				);
				assert.equal(
					(
						await postgresQuery(
							"SELECT count(*)::int AS count FROM pairwise_identity_legacy_backfills",
						)
					).rows[0]?.count,
					0,
				);
				await assert.rejects(
					getPairwiseHandle({ ...baseInput, clientId: "missing-client" }),
				);
				await assert.rejects(
					getPairwiseHandle({ ...baseInput, clientSector: OTHER_SECTOR }),
				);
				assert.match(await getPairwiseHandle(baseInput), HMAC_INSTANCE_HANDLE);
				await postgresQuery(
					`INSERT INTO pairwise_identity_handles (issuer,subject_id,client_id,kind,source_id,internal_id,handle)
					 VALUES ($1,'person-4','legacy-a','instance','source','cin-conflict','inst_conflict_a'),
					        ($1,'person-4','legacy-b','instance','source','cin-conflict','inst_conflict_b'),
					        ($1,'person-4','orphan-client','instance','source','cin-orphan','inst_orphan')`,
					[ISSUER],
				);
				await recordTrustedClientSectorMembership({
					clientId: "legacy-a",
					clientSector: SECTOR,
					issuer: ISSUER,
				});
				await recordTrustedClientSectorMembership({
					clientId: "legacy-b",
					clientSector: SECTOR,
					issuer: ISSUER,
				});
				assert.equal(
					(
						await postgresQuery(
							"SELECT count(*)::int AS count FROM pairwise_trusted_client_sectors WHERE client_id='legacy-b'",
						)
					).rows[0]?.count,
					1,
				);
				await assert.rejects(completePairwiseIdentityLegacyBackfill(ISSUER));
				assert.match(await getPairwiseHandle(baseInput), HMAC_INSTANCE_HANDLE);
				await backfillTrustedClientSectorMembership({
					clientId: "legacy-b",
					clientSector: SECTOR,
					issuer: ISSUER,
				});
				await recordTrustedClientSectorMembership({
					clientId: "orphan-client",
					clientSector: SECTOR,
					issuer: ISSUER,
				});
				await completePairwiseIdentityLegacyBackfill(ISSUER);
				const issuedHandle = await getPairwiseHandle(baseInput);
				assert.equal(
					(
						await lookupPairwiseInstanceMapping({
							clientId: baseInput.clientId,
							clientSector: SECTOR,
							instanceHandle: issuedHandle,
							issuer: ISSUER,
							subjectId: baseInput.subjectId,
						})
					)?.internalId,
					baseInput.internalId,
				);
				await postgresQuery(
					"INSERT INTO pairwise_identity_handles (issuer,subject_id,client_id,kind,source_id,internal_id,handle) VALUES ($1,'person-4','late-client','instance','source','cin-late','inst_late')",
					[ISSUER],
				);
				await recordTrustedClientSectorMembership({
					clientId: "late-client",
					clientSector: SECTOR,
					issuer: ISSUER,
				});
				assert.match(
					await getPairwiseHandle({ ...baseInput, clientId: "late-client" }),
					HMAC_INSTANCE_HANDLE,
				);
				await postgresQuery(
					`INSERT INTO pairwise_identity_handles (issuer,subject_id,client_id,kind,source_id,internal_id,handle)
					 VALUES ('https://foreign-as.example','person-foreign','foreign-client','instance','source','cin-foreign','inst_foreign')`,
				);
				await assert.rejects(
					getPairwiseHandle(baseInput),
					(error: unknown) => error instanceof PairwiseIdentityDeploymentError,
				);
				await assert.rejects(
					recordTrustedClientSectorMembership({
						clientId: "another-late-client",
						clientSector: SECTOR,
						issuer: ISSUER,
					}),
					(error: unknown) => error instanceof PairwiseIdentityDeploymentError,
				);
			},
		);
	});
} else {
	test("PostgreSQL pairwise identity parity (skipped: PDPP_TEST_POSTGRES_URL unset)", {
		skip: true,
	}, () => {});
}
