// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { closeDb, getDb, initDb } from "../server/db.ts";
import {
	buildPairwiseInstanceBindings,
	type PairwiseAsGrantProjection,
	type PairwiseAsSourceAuthority,
} from "../server/pairwise-as-context.ts";
import {
	clientVisibleInstanceId,
	completePairwiseIdentityLegacyBackfill,
	getPairwiseHandle,
	initializePairwiseIdentityRootKey,
	lookupPairwiseInstanceMapping,
	PairwiseIdentityContextError,
	recordTrustedClientSectorMembership,
	validatePairwiseInstanceBindings,
} from "../server/pairwise-identity.ts";
import {
	closePostgresStorage,
	initPostgresStorage,
	postgresQuery,
} from "../server/postgres-storage.ts";
import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts";

const ISSUER = "https://as.example";
const SECTOR = "https://sector.example/applications.json";
const OTHER_SECTOR = "https://other.example/sector.json";
const INTERNAL_SUBJECT = "person-4";
const SOURCE = "https://source.example/profile";
const SOURCE_A = "https://source.example/a";
const SOURCE_B = "https://source.example/b";
const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;
let postgresCounter = 0;
const sourceAuthorities = new Map<string, PairwiseAsSourceAuthority>();

async function setup(): Promise<void> {
	initDb(":memory:");
	sourceAuthorities.clear();
	await initializePairwiseIdentityRootKey(ISSUER);
	getDb()
		.prepare(
			"UPDATE pairwise_identity_root_keys SET root_key_hex=? WHERE issuer=?",
		)
		.run(
			"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
			ISSUER,
		);
	for (const [clientId, clientSector] of [
		["client-a", SECTOR],
		["client-b", SECTOR],
		["client-c", OTHER_SECTOR],
	] as const) {
		await recordTrustedClientSectorMembership({
			clientId,
			clientSector,
			issuer: ISSUER,
		});
	}
	await completePairwiseIdentityLegacyBackfill(ISSUER);
}

function context() {
	return {
		issuer: ISSUER,
		resolveCanonicalSourceForInstance: (internalInstanceId: string) =>
			sourceAuthorities.get(internalInstanceId) ?? null,
		resolveClientSector: (clientId: string) => {
			if (clientId === "client-c") return OTHER_SECTOR;
			return SECTOR;
		},
	};
}

async function issueHandle(
	clientId: string,
	internalId: string,
	sourceId = SOURCE,
) {
	const clientSector = clientId === "client-c" ? OTHER_SECTOR : SECTOR;
	sourceAuthorities.set(internalId, {
		acceptedLegacySourceAliases: [],
		canonicalSourceId: sourceId,
		declarationVersion: "declaration-v1",
	});
	return getPairwiseHandle({
		clientId,
		clientSector,
		internalId,
		issuer: ISSUER,
		kind: "instance",
		sourceId,
		subjectId: INTERNAL_SUBJECT,
	});
}

async function issueLegacyHandle(
	internalId: string,
	retainedSourceAlias: string,
	handle: string,
	acceptedAliases: string[],
): Promise<string> {
	getDb()
		.prepare(
			"INSERT INTO pairwise_identity_handles (issuer,subject_id,client_id,kind,source_id,internal_id,handle) VALUES (?,?,?,?,?,?,?)",
		)
		.run(
			ISSUER,
			INTERNAL_SUBJECT,
			"client-a",
			"instance",
			retainedSourceAlias,
			internalId,
			handle,
		);
	sourceAuthorities.set(internalId, {
		acceptedLegacySourceAliases: acceptedAliases,
		canonicalSourceId: SOURCE,
		declarationVersion: "declaration-v7",
	});
	return handle;
}

function projection(
	instanceIds: string[],
	resolvedInstances: {
		source_id: string;
		stream: string;
		rs_instance: string;
	}[],
	options: {
		clientId?: string;
		grantId?: string;
		sourceId?: string;
		streams?: string[];
	} = {},
): PairwiseAsGrantProjection {
	const clientId = options.clientId ?? "client-a";
	const streams = options.streams ?? ["profile"];
	return {
		grant: {
			grant_id: options.grantId ?? "grt_core",
			client: { client_id: clientId },
			source: { id: options.sourceId ?? SOURCE },
			streams: streams.map((name) => ({
				instance_ids: [...instanceIds],
				name,
			})),
			subject: { id: "sub_pairwise-4" },
		},
		resolvedInstances,
	};
}

function tuple(rsInstance: string, stream = "profile", sourceId = SOURCE) {
	return {
		source_id: sourceId,
		stream,
		rs_instance: rsInstance,
	};
}

async function build(
	target:
		| {
				kind: "core";
				grant: PairwiseAsGrantProjection["grant"];
				resolvedInstances: PairwiseAsGrantProjection["resolvedInstances"];
		  }
		| {
				kind: "package";
				children: PairwiseAsGrantProjection[];
		  },
	clientId = "client-a",
) {
	return buildPairwiseInstanceBindings({
		clientId,
		context: context(),
		internalSubjectId: INTERNAL_SUBJECT,
		target,
	});
}

function coreTarget(
	grant: PairwiseAsGrantProjection,
): Parameters<typeof build>[0] {
	return {
		kind: "core",
		grant: grant.grant,
		resolvedInstances: grant.resolvedInstances,
	};
}

function packageTarget(
	children: PairwiseAsGrantProjection[],
): Parameters<typeof build>[0] {
	return { kind: "package", children };
}

async function assertGrantInvalid(action: Promise<unknown>): Promise<void> {
	await assert.rejects(action, (error: unknown) => {
		assert.equal(error instanceof PairwiseIdentityContextError, true);
		assert.equal((error as PairwiseIdentityContextError).code, "grant_invalid");
		return true;
	});
}

const IDENTITY_TABLES = [
	"pairwise_identity_handles",
	"pairwise_identity_legacy_backfills",
	"pairwise_trusted_client_sectors",
	"pairwise_identity_root_keys",
	"pairwise_identity_deployment",
	"pairwise_identity_issuer_migrations",
] as const;

function identityRowsDigest(rows: unknown[]): string {
	return createHash("sha256")
		.update(JSON.stringify(rows.map((row) => JSON.stringify(row)).sort()))
		.digest("hex");
}

function sqliteIdentitySnapshot() {
	return IDENTITY_TABLES.map((table) =>
		identityRowsDigest(getDb().prepare(`SELECT * FROM ${table}`).all()),
	);
}

test("bindings reuse a sector handle across clients and separate other sectors", async () => {
	await setup();
	try {
		const clientAHandle = await issueHandle("client-a", "cin-17");
		const clientBHandle = await issueHandle("client-b", "cin-17");
		const clientCHandle = await issueHandle("client-c", "cin-17");
		assert.equal(clientAHandle, clientBHandle);
		assert.notEqual(clientAHandle, clientCHandle);

		const bindings = await build(
			coreTarget(projection([clientAHandle], [tuple("cin-17")])),
		);
		assert.equal(bindings[0]?.instance_id, clientAHandle);
		assert.equal(bindings[0]?.rs_instance, "cin-17");
	} finally {
		closeDb();
	}
});

test("Core grant ID does not become a package binding field", async () => {
	await setup();
	try {
		const handle = await issueHandle("client-a", "cin-core");
		const grant = projection([handle], [tuple("cin-core")], {
			grantId: "grt_core",
		});
		const bindings = await build(coreTarget(grant));
		assert.deepEqual(Object.keys(bindings[0] ?? {}).sort(), [
			"instance_id",
			"rs_instance",
			"source_id",
			"stream",
		]);
		assert.equal(bindings[0]?.grant_id, undefined);
	} finally {
		closeDb();
	}
});

test("Core target rejects a missing or empty required grant ID", async () => {
	await setup();
	try {
		const handle = await issueHandle("client-a", "cin-core-id");
		for (const grantId of [undefined, ""]) {
			const child = projection([handle], [tuple("cin-core-id")]);
			const before = sqliteIdentitySnapshot();
			await assertGrantInvalid(
				build(
					coreTarget({
						...child,
						grant: { ...child.grant, grant_id: grantId } as never,
					}),
				),
			);
			assert.deepEqual(sqliteIdentitySnapshot(), before);
		}
	} finally {
		closeDb();
	}
});

test("Core target rejects omitted or empty exact instance_ids", async () => {
	await setup();
	try {
		const handle = await issueHandle("client-a", "cin-exact-handles");
		for (const instanceIds of [undefined, []]) {
			const child = projection([handle], [tuple("cin-exact-handles")]);
			child.grant.streams = [
				instanceIds === undefined
					? { name: "profile" }
					: { name: "profile", instance_ids: instanceIds },
			];
			const before = sqliteIdentitySnapshot();
			await assertGrantInvalid(build(coreTarget(child)));
			assert.deepEqual(sqliteIdentitySnapshot(), before);
		}
	} finally {
		closeDb();
	}
});

test("Core tuple with an extra grant ID still emits the exact Core shape", async () => {
	await setup();
	try {
		const handle = await issueHandle("client-a", "cin-core-extra");
		const resolved = {
			...tuple("cin-core-extra"),
			grant_id: "grt_core",
		};
		const bindings = await build(
			coreTarget(projection([handle], [resolved] as never)),
		);
		assert.deepEqual(Object.keys(bindings[0] ?? {}).sort(), [
			"instance_id",
			"rs_instance",
			"source_id",
			"stream",
		]);
	} finally {
		closeDb();
	}
});

test("legacy mixed-grants input and wrong target shapes are grant_invalid", async () => {
	await setup();
	try {
		const handle = await issueHandle("client-a", "cin-shape");
		const child = projection([handle], [tuple("cin-shape")]);
		const anotherCoreGrant = {
			...child,
			grant: { ...child.grant, grant_id: "grt_core_2" },
		};
		await assertGrantInvalid(
			build({
				grants: [child, anotherCoreGrant],
			} as never),
		);
		await assertGrantInvalid(
			build({
				grants: [
					child,
					{
						...child,
						grant: { ...child.grant, grant_id: undefined },
					},
				],
			} as never),
		);
		await assertGrantInvalid(
			build({
				kind: "core",
				children: [child],
			} as never),
		);
	} finally {
		closeDb();
	}
});

test("package child IDs must be distinct and come from each grant", async () => {
	await setup();
	try {
		const handle = await issueHandle("client-a", "cin-package");
		const childA = projection([handle], [tuple("cin-package")], {
			grantId: "grt_a",
		});
		const childB = projection([handle], [tuple("cin-package")], {
			grantId: "grt_b",
		});
		const bindings = await build(packageTarget([childA, childB]));
		assert.deepEqual(
			bindings.map((binding) => binding.grant_id),
			["grt_a", "grt_b"],
		);
		await assertGrantInvalid(
			build(
				packageTarget([
					childA,
					{ ...childB, grant: { ...childB.grant, grant_id: "grt_a" } },
				]),
			),
		);
	} finally {
		closeDb();
	}
});

test("package child IDs remain distinct across disjoint streams", async () => {
	await setup();
	try {
		const handle = await issueHandle("client-a", "cin-disjoint");
		const children = ["profile", "activity"].map((stream) =>
			projection([handle], [tuple("cin-disjoint", stream)], {
				grantId: "grt_duplicate",
				streams: [stream],
			}),
		);
		await assertGrantInvalid(build(packageTarget(children)));
	} finally {
		closeDb();
	}
});

test("package binding grant ID ignores conflicting tuple metadata", async () => {
	await setup();
	try {
		const handle = await issueHandle("client-a", "cin-tuple-metadata");
		const resolved = {
			...tuple("cin-tuple-metadata"),
			grant_id: "grt_foreign",
		};
		const bindings = await build(
			packageTarget([
				projection([handle], [resolved], { grantId: "grt_child" }),
			]),
		);
		assert.equal(bindings[0]?.grant_id, "grt_child");
	} finally {
		closeDb();
	}
});

test("mis-sourced v1 grant fails from retained authority without writes", async () => {
	await setup();
	try {
		const handle = await issueHandle("client-a", "cin-source-a", SOURCE_A);
		const before = sqliteIdentitySnapshot();
		await assertGrantInvalid(
			build(
				coreTarget(
					projection([handle], [tuple("cin-source-a", "profile", SOURCE_B)], {
						sourceId: SOURCE_B,
					}),
				),
			),
		);
		assert.deepEqual(sqliteIdentitySnapshot(), before);
	} finally {
		closeDb();
	}
});

test("legacy source aliases do not adopt a raw handle into a binding", async () => {
	await setup();
	try {
		const handle = await issueLegacyHandle(
			"cin-legacy-source",
			"source-local-alias",
			"inst_legacy_source",
			["source-local-alias"],
		);
		const before = sqliteIdentitySnapshot();
		const bindings = await build(
			coreTarget(projection([handle], [tuple("cin-legacy-source")])),
		);
		assert.deepEqual(bindings, []);
		assert.deepEqual(sqliteIdentitySnapshot(), before);
	} finally {
		closeDb();
	}
});

test("an accepted source alias on a v1 mapping resolves to its canonical source", async () => {
	await setup();
	try {
		const internalId = "cin-v1-source-alias";
		const handle = await issueHandle("client-a", internalId);
		getDb()
			.prepare(
				"UPDATE pairwise_identity_handles SET source_id=? WHERE issuer=? AND handle=? AND scheme='v1'",
			)
			.run("source-local-alias", ISSUER, handle);
		sourceAuthorities.set(internalId, {
			acceptedLegacySourceAliases: ["source-local-alias"],
			canonicalSourceId: SOURCE,
			declarationVersion: "declaration-v7",
		});
		const before = sqliteIdentitySnapshot();
		const bindings = await build(
			coreTarget(projection([handle], [tuple(internalId)])),
		);
		assert.equal(bindings[0]?.source_id, SOURCE);
		assert.deepEqual(sqliteIdentitySnapshot(), before);

		const unknownInternalId = "cin-v1-unknown-source-alias";
		const unknownHandle = await issueHandle("client-a", unknownInternalId);
		getDb()
			.prepare(
				"UPDATE pairwise_identity_handles SET source_id=? WHERE issuer=? AND handle=? AND scheme='v1'",
			)
			.run("unrecognized-source-alias", ISSUER, unknownHandle);
		sourceAuthorities.set(unknownInternalId, {
			acceptedLegacySourceAliases: ["another-source-alias"],
			canonicalSourceId: SOURCE,
			declarationVersion: "declaration-v7",
		});
		const beforeUnknownAlias = sqliteIdentitySnapshot();
		await assertGrantInvalid(
			build(
				coreTarget(projection([unknownHandle], [tuple(unknownInternalId)])),
			),
		);
		assert.deepEqual(sqliteIdentitySnapshot(), beforeUnknownAlias);
	} finally {
		closeDb();
	}
});

test("an unknown legacy source alias also leaves a missing binding", async () => {
	await setup();
	try {
		const handle = await issueLegacyHandle(
			"cin-unknown-source",
			"unrecognized-source-alias",
			"inst_unknown_source",
			["source-local-alias"],
		);
		const before = sqliteIdentitySnapshot();
		assert.deepEqual(
			await build(
				coreTarget(projection([handle], [tuple("cin-unknown-source")]))
			),
			[],
		);
		assert.deepEqual(sqliteIdentitySnapshot(), before);
	} finally {
		closeDb();
	}
});

test("binding validator rejects mixed Core and package entries", () => {
	assert.throws(
		() =>
			validatePairwiseInstanceBindings([
				{
					instance_id: "inst_a",
					rs_instance: "cin-a",
					source_id: SOURCE,
					stream: "profile",
					grant_id: "grt_a",
				},
				{
					instance_id: "inst_b",
					rs_instance: "cin-b",
					source_id: SOURCE,
					stream: "profile",
				},
			]),
		(error: unknown) => error instanceof PairwiseIdentityContextError,
	);
});

test("null producer input is a typed grant_invalid error", async () => {
	await assertGrantInvalid(buildPairwiseInstanceBindings(null as never));
	await assertGrantInvalid(buildPairwiseInstanceBindings(undefined as never));
});

test("one issued instance handle binds across each granted stream", async () => {
	await setup();
	try {
		const handle = await issueHandle("client-a", "cin-17");
		const child = projection(
			[handle],
			[tuple("cin-17", "profile"), tuple("cin-17", "activity")],
			{ streams: ["profile", "activity"] },
		);
		const bindings = await build(coreTarget(child));
		assert.deepEqual(
			bindings.map((binding) => binding.stream),
			["profile", "activity"],
		);
		assert.deepEqual(
			bindings.map((binding) => binding.instance_id),
			[handle, handle],
		);
		assert.ok(Object.isFrozen(bindings));
		assert.ok(bindings.every(Object.isFrozen));
	} finally {
		closeDb();
	}
});

test("canonical source aliases must be resolved before binding production", async () => {
	await setup();
	try {
		const handle = await issueHandle("client-a", "cin-17");
		const aliased = { ...tuple("cin-17"), source_id: "source-local-alias" };
		await assert.rejects(
			build(coreTarget(projection([handle], [aliased]))),
			(error: unknown) => error instanceof PairwiseIdentityContextError,
		);
	} finally {
		closeDb();
	}
});

test("bindings equal the projected grant pairs and reject extra or unresolved tuples", async () => {
	await setup();
	try {
		const handle = await issueHandle("client-a", "cin-17");
		const extraHandle = await issueHandle("client-a", "cin-18");
		await assert.rejects(
			build(
				coreTarget(projection([handle], [tuple("cin-17"), tuple("cin-18")])),
			),
			(error: unknown) => error instanceof PairwiseIdentityContextError,
		);
		await assert.rejects(
			build(coreTarget(projection([handle], []))),
			(error: unknown) => error instanceof PairwiseIdentityContextError,
		);
		await assert.rejects(
			build(coreTarget(projection([handle, extraHandle], [tuple("cin-17")]))),
			(error: unknown) => error instanceof PairwiseIdentityContextError,
		);
	} finally {
		closeDb();
	}
});

test("retired persisted mappings remain in the exact issued grant context", async () => {
	await setup();
	try {
		const retiredHandle = await issueHandle("client-a", "cin-retired");
		const bindings = await build(
			coreTarget(projection([retiredHandle], [tuple("cin-retired")])),
		);
		assert.deepEqual(
			bindings.map((binding) => binding.instance_id),
			[retiredHandle],
		);
		assert.deepEqual(
			bindings.map((binding) => binding.rs_instance),
			["cin-retired"],
		);
	} finally {
		closeDb();
	}
});

test("package overlap retains one binding per child without merging contexts", async () => {
	await setup();
	try {
		const handle = await issueHandle("client-a", "cin-shared");
		const childA = projection([handle], [tuple("cin-shared")], {
			grantId: "grant-a",
		});
		const childB = projection([handle], [tuple("cin-shared")], {
			grantId: "grant-b",
		});
		const bindings = await build(packageTarget([childA, childB]));
		assert.deepEqual(
			bindings.map((binding) => binding.grant_id),
			["grant-a", "grant-b"],
		);
		assert.deepEqual(
			bindings.map((binding) => binding.instance_id),
			[handle, handle],
		);
	} finally {
		closeDb();
	}
});

test("a lost issued mapping is omitted without minting or returning a raw ID", async () => {
	await setup();
	try {
		const handle = await issueHandle("client-a", "cin-lost");
		const retainedHandle = await issueHandle("client-a", "cin-retained");
		getDb()
			.prepare(
				"DELETE FROM pairwise_identity_handles WHERE issuer=? AND internal_id=?",
			)
			.run(ISSUER, "cin-lost");
		const before = getDb()
			.prepare("SELECT count(*) AS count FROM pairwise_identity_handles")
			.get<{ count: number }>()?.count;
		const bindings = await build(
			coreTarget(
				projection(
					[handle, retainedHandle],
					[tuple("cin-lost"), tuple("cin-retained")],
				),
			),
		);
		const after = getDb()
			.prepare("SELECT count(*) AS count FROM pairwise_identity_handles")
			.get<{ count: number }>()?.count;
		assert.equal(after, before);
		assert.notEqual(handle, "cin-lost");
		assert.deepEqual(
			bindings.map((binding) => binding.instance_id),
			[retainedHandle],
		);
		assert.equal(
			bindings.some((binding) => binding.instance_id === handle),
			false,
		);
		assert.ok(Object.isFrozen(bindings));
		assert.throws(
			() => clientVisibleInstanceId("cin-lost", bindings, SOURCE, "profile"),
			(error: unknown) => error instanceof PairwiseIdentityContextError,
		);
	} finally {
		closeDb();
	}
});

test("a lookup miss neither mints a handle nor completes legacy backfill", async () => {
	initDb(":memory:");
	try {
		await initializePairwiseIdentityRootKey(ISSUER);
		await recordTrustedClientSectorMembership({
			clientId: "client-a",
			clientSector: SECTOR,
			issuer: ISSUER,
		});
		const before = getDb()
			.prepare(
				"SELECT (SELECT count(*) FROM pairwise_identity_handles) AS handles, (SELECT count(*) FROM pairwise_identity_legacy_backfills) AS backfills",
			)
			.get<{ handles: number; backfills: number }>();
		const internalId = await lookupPairwiseInstanceMapping({
			clientId: "client-a",
			clientSector: SECTOR,
			instanceHandle: "inst_v1_missing",
			issuer: ISSUER,
			subjectId: INTERNAL_SUBJECT,
		});
		const after = getDb()
			.prepare(
				"SELECT (SELECT count(*) FROM pairwise_identity_handles) AS handles, (SELECT count(*) FROM pairwise_identity_legacy_backfills) AS backfills",
			)
			.get<{ handles: number; backfills: number }>();
		assert.equal(internalId, null);
		assert.deepEqual(after, before);
	} finally {
		closeDb();
	}
});

test("binding production leaves issued grant and resolved tuples untouched", async () => {
	await setup();
	try {
		const handle = await issueHandle("client-a", "cin-17");
		const child = projection([handle], [tuple("cin-17")]);
		const before = JSON.stringify(child);
		const bindings = await build(coreTarget(child));
		assert.equal(JSON.stringify(child), before);
		assert.equal(bindings[0]?.instance_id, handle);
	} finally {
		closeDb();
	}
});

if (POSTGRES_URL) {
	test("PostgreSQL producer enforces Core, package, mapping, and source authority", async () => {
		postgresCounter += 1;
		await withTemporaryPostgresDatabase(
			{
				closeConnections: closePostgresStorage,
				connectionString: POSTGRES_URL,
				databaseName: `pdpp_pairwise_as_context_${process.pid}_${postgresCounter}`,
				templateName: null,
			},
			async (databaseUrl) => {
				sourceAuthorities.clear();
				await initPostgresStorage({ backend: "postgres", databaseUrl });
				await initializePairwiseIdentityRootKey(ISSUER);
				await recordTrustedClientSectorMembership({
					clientId: "client-a",
					clientSector: SECTOR,
					issuer: ISSUER,
				});
				await completePairwiseIdentityLegacyBackfill(ISSUER);

				const coreHandle = await issueHandle("client-a", "cin-pg-core");
				const core = await build(
					coreTarget(projection([coreHandle], [tuple("cin-pg-core")])),
				);
				assert.equal(core.length, 1);
				assert.equal(core[0]?.grant_id, undefined);
				assert.deepEqual(Object.keys(core[0] ?? {}).sort(), [
					"instance_id",
					"rs_instance",
					"source_id",
					"stream",
				]);

				const packageHandle = await issueHandle("client-a", "cin-pg-package");
				const packageBindings = await build(
					packageTarget([
						projection([packageHandle], [tuple("cin-pg-package")], {
							grantId: "grt_pg_a",
						}),
						projection([packageHandle], [tuple("cin-pg-package")], {
							grantId: "grt_pg_b",
						}),
					]),
				);
				assert.deepEqual(
					packageBindings.map((binding) => binding.grant_id),
					["grt_pg_a", "grt_pg_b"],
				);

				const lostHandle = await issueHandle("client-a", "cin-pg-lost");
				await postgresQuery(
					"DELETE FROM pairwise_identity_handles WHERE issuer=$1 AND internal_id=$2",
					[ISSUER, "cin-pg-lost"],
				);
				const lost = await build(
					coreTarget(projection([lostHandle], [tuple("cin-pg-lost")])),
				);
				assert.deepEqual(lost, []);

				const sourceHandle = await issueHandle(
					"client-a",
					"cin-pg-source-a",
					SOURCE_A,
				);
				const beforeMisSource = await postgresIdentitySnapshot();
				await assertGrantInvalid(
					build(
						coreTarget(
							projection(
								[sourceHandle],
								[tuple("cin-pg-source-a", "profile", SOURCE_B)],
								{ sourceId: SOURCE_B },
							),
						),
					),
				);
				assert.deepEqual(await postgresIdentitySnapshot(), beforeMisSource);

				const knownAliasInternalId = "cin-pg-v1-source-alias";
				const knownAliasHandle = await issueHandle(
					"client-a",
					knownAliasInternalId,
				);
				await postgresQuery(
					"UPDATE pairwise_identity_handles SET source_id=$1 WHERE issuer=$2 AND handle=$3 AND scheme='v1'",
					["legacy-pg-source-alias", ISSUER, knownAliasHandle],
				);
				sourceAuthorities.set(knownAliasInternalId, {
					acceptedLegacySourceAliases: ["legacy-pg-source-alias"],
					canonicalSourceId: SOURCE,
					declarationVersion: "declaration-v8",
				});
				const beforeKnownAlias = await postgresIdentitySnapshot();
				const knownAlias = await build(
					coreTarget(
						projection([knownAliasHandle], [tuple(knownAliasInternalId)]),
					),
				);
				assert.equal(knownAlias[0]?.source_id, SOURCE);
				assert.deepEqual(await postgresIdentitySnapshot(), beforeKnownAlias);

				const unknownAliasInternalId = "cin-pg-v1-unknown-source-alias";
				const unknownAliasHandle = await issueHandle(
					"client-a",
					unknownAliasInternalId,
				);
				await postgresQuery(
					"UPDATE pairwise_identity_handles SET source_id=$1 WHERE issuer=$2 AND handle=$3 AND scheme='v1'",
					["unknown-pg-source-alias", ISSUER, unknownAliasHandle],
				);
				sourceAuthorities.set(unknownAliasInternalId, {
					acceptedLegacySourceAliases: ["another-pg-alias"],
					canonicalSourceId: SOURCE,
					declarationVersion: "declaration-v8",
				});
				const beforeUnknownAlias = await postgresIdentitySnapshot();
				await assertGrantInvalid(
					build(
						coreTarget(
							projection(
								[unknownAliasHandle],
								[tuple(unknownAliasInternalId)],
							),
						),
					),
				);
				assert.deepEqual(await postgresIdentitySnapshot(), beforeUnknownAlias);
			},
		);
	});
} else {
	test("PostgreSQL AS context producer parity (skipped: PDPP_TEST_POSTGRES_URL unset)", {
		skip: true,
	}, () => {});
}

async function postgresIdentitySnapshot() {
	const digests = [];
	for (const table of IDENTITY_TABLES) {
		digests.push(
			identityRowsDigest((await postgresQuery(`SELECT * FROM ${table}`)).rows),
		);
	}
	return digests;
}
