// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Defect D4 — expiry was ENFORCED but not REPORTED.
 *
 * A grant whose `expires_at` had passed was correctly refused on read, yet
 * both `grants.status` and `GET /_ref/grant-packages/:id` still reported
 * `"active"`. From the D4 diagnostic:
 *
 *     DIAGPKG pkgStatus="active"
 *            grantRows=[{"status":"active","expires_at":"2026-09-07T23:47:38.373Z"}]
 *
 * spec-core.md:533 — "Grant lifecycle (active, expired, revoked) is tracked by
 * the authorization server, not stored in the grant itself." The AS
 * conformance list repeats it at :1360 item 8. `revoked` was tracked via the
 * `status` column; `expired` was not tracked anywhere, because it was only
 * ever computed at read time inside `introspect()`.
 *
 * These tests drive the OWNER-FACING reporting surfaces — the ones an owner
 * auditing their grants actually reads — and assert every one reports
 * `expired` once the deadline passes:
 *
 *   1. `listGrantPackagesForOwner`   (backs `GET /_ref/grant-packages`)
 *   2. `getGrantPackageForOwner`     (backs `GET /_ref/grant-packages/:id`)
 *      - the package `status`
 *      - each child's `grant_status`
 *   3. `getCumulativeClientAccessForPackage`
 *      (backs `GET /_ref/grant-packages/:id/cumulative`), including
 *      `active_child_count`, which must stop counting a lapsed child.
 *
 * plus the three control cases that keep the fix honest: an unexpired grant
 * still reports `active`, a revoked grant still reports `revoked` (revocation
 * is an owner act and must not be overwritten by the clock), and the boundary
 * at exactly `expires_at` is still `active`.
 *
 * The rows are seeded directly rather than through the HTTP picker flow. The
 * defect is in how a persisted row is REPORTED, so the shortest honest setup
 * is a row with a known `expires_at`; going through the picker would add the
 * multi-source consent flow — and the Postgres index-lane race documented as
 * D1 in the same acceptance packet — to a test that needs neither.
 *
 * Both storage backends run. Postgres is gated on `PDPP_TEST_POSTGRES_URL`
 * and registers a skipped placeholder when it is unset, matching
 * `grant-package-postgres-path.test.ts`.
 *
 * Run (SQLite):
 *   PDPP_TEST_PROFILE=memory-default node --test --import tsx \
 *     reference-implementation/test/grant-lifecycle-expired-reporting.test.ts
 *
 * Run (Postgres, against a provisioned scratch database):
 *   PDPP_TEST_PROFILE=postgres \
 *   PDPP_TEST_POSTGRES_URL=postgres://pdpp:pdpp@127.0.0.1:55471/pdpp_d4 \
 *     node --test --import tsx \
 *     reference-implementation/test/grant-lifecycle-expired-reporting.test.ts
 */

import { strict as assert } from "node:assert/strict";
import test from "node:test";

import {
	getCumulativeClientAccessForPackage,
	getGrantPackageForOwner,
	listGrantPackagesForOwner,
} from "../server/auth.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import {
	closePostgresStorage,
	initPostgresStorage,
	postgresQuery,
} from "../server/postgres-storage.ts";

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;

const SUBJECT_ID = "owner_local";
const CLIENT_ID = "d4_lifecycle_client";
const PACKAGE_VERSION = "reference.mcp_package.v2";

// A fixed past deadline and a fixed future one, so no assertion below depends
// on how long the suite takes to run.
const PAST_DEADLINE = "2020-01-01T00:00:00.000Z";
const FUTURE_DEADLINE = "2099-01-01T00:00:00.000Z";
const ISSUED_AT = "2019-01-01T00:00:00.000Z";

interface SeedOptions {
	readonly expiresAt: string | null;
	readonly grantStatus?: string;
	readonly packageId: string;
	readonly packageStatus?: string;
}

function packageEnvelope(packageId: string): string {
	// Shape required by `requireCurrentPackageEnvelope` (server/auth.ts): exact
	// key set, matching ids, and a positive approved_source_count.
	return JSON.stringify({
		approved_source_count: 1,
		client: {
			client_display: "D4 lifecycle client",
			client_id: CLIENT_ID,
			registration_mode: "dynamic",
		},
		package_id: packageId,
		source_bounded_child_grants: true,
		subject: { id: SUBJECT_ID },
		version: PACKAGE_VERSION,
	});
}

function grantJson(grantId: string, expiresAt: string | null): string {
	const grant: Record<string, unknown> = {
		client: { client_id: CLIENT_ID },
		grant_id: grantId,
		issued_at: ISSUED_AT,
		subject: { id: SUBJECT_ID },
		version: "0.1.0",
	};
	// `expires_at` is absent-only when there is no expiry: an explicit JSON null
	// is what the startup migrations strip (db.ts / postgres-storage.ts).
	if (expiresAt !== null) {
		grant.expires_at = expiresAt;
	}
	return JSON.stringify(grant);
}

/**
 * Seeds one grant package with exactly one member grant. `expiresAt` is the
 * only knob the assertions vary; `grantStatus`/`packageStatus` exist for the
 * revoked control.
 */
async function seedPackage(
	usePostgres: boolean,
	opts: SeedOptions,
): Promise<void> {
	const { packageId, expiresAt } = opts;
	const grantStatus = opts.grantStatus ?? "active";
	const packageStatus = opts.packageStatus ?? "active";
	const grantId = `grt_${packageId}`;
	const sourceJson = JSON.stringify({
		kind: "connector",
		id: "https://example.test/connectors/spotify",
	});

	if (usePostgres) {
		await postgresQuery(
			`INSERT INTO grants(grant_id, subject_id, client_id, grant_json, access_mode, status, issued_at, expires_at)
       VALUES($1, $2, $3, $4::jsonb, 'read', $5, $6, $7)`,
			[
				grantId,
				SUBJECT_ID,
				CLIENT_ID,
				grantJson(grantId, expiresAt),
				grantStatus,
				ISSUED_AT,
				expiresAt,
			],
		);
		await postgresQuery(
			`INSERT INTO grant_packages(package_id, subject_id, client_id, status, package_json, created_at, approved_at)
       VALUES($1, $2, $3, $4, $5::jsonb, $6, $6)`,
			[
				packageId,
				SUBJECT_ID,
				CLIENT_ID,
				packageStatus,
				packageEnvelope(packageId),
				ISSUED_AT,
			],
		);
		await seedMemberWithToken(true, {
			addedAt: ISSUED_AT,
			expiresAt,
			grantId,
			packageId,
			sourceJson,
		});
		return;
	}

	const db = getDb();
	db.prepare(
		`INSERT INTO grants(grant_id, subject_id, client_id, grant_json, access_mode, status, issued_at, expires_at)
     VALUES(?, ?, ?, ?, 'read', ?, ?, ?)`,
	).run(
		grantId,
		SUBJECT_ID,
		CLIENT_ID,
		grantJson(grantId, expiresAt),
		grantStatus,
		ISSUED_AT,
		expiresAt,
	);
	db.prepare(
		`INSERT INTO grant_packages(package_id, subject_id, client_id, status, package_json, created_at, approved_at)
     VALUES(?, ?, ?, ?, ?, ?, ?)`,
	).run(
		packageId,
		SUBJECT_ID,
		CLIENT_ID,
		packageStatus,
		packageEnvelope(packageId),
		ISSUED_AT,
		ISSUED_AT,
	);
	await seedMemberWithToken(false, {
		addedAt: ISSUED_AT,
		expiresAt,
		grantId,
		packageId,
		sourceJson,
	});
}

/**
 * Inserts the member row and the client token it is bound to.
 * `grant_package_members.token_id` is NOT NULL, and the real system binds a
 * token's expiry to its grant's (`requirePersistedGrantColumnBindings` rejects
 * a token that outlives its grant), so the seeded token carries the same
 * deadline as the grant.
 */
async function seedMemberWithToken(
	usePostgres: boolean,
	opts: {
		readonly addedAt: string;
		readonly expiresAt: string | null;
		readonly grantId: string;
		readonly packageId: string;
		readonly sourceJson: string;
	},
): Promise<void> {
	const { addedAt, expiresAt, grantId, packageId, sourceJson } = opts;
	const tokenId = `tok_${grantId}`;
	if (usePostgres) {
		await postgresQuery(
			`INSERT INTO tokens(token_id, grant_id, subject_id, client_id, token_kind, expires_at, created_at)
       VALUES($1, $2, $3, $4, 'client', $5, $6)`,
			[tokenId, grantId, SUBJECT_ID, CLIENT_ID, expiresAt, addedAt],
		);
		await postgresQuery(
			`INSERT INTO grant_package_members(package_id, grant_id, token_id, source_json, status, added_at)
       VALUES($1, $2, $3, $4::jsonb, 'active', $5)`,
			[packageId, grantId, tokenId, sourceJson, addedAt],
		);
		return;
	}
	const db = getDb();
	db.prepare(
		`INSERT INTO tokens(token_id, grant_id, subject_id, client_id, token_kind, expires_at, created_at)
     VALUES(?, ?, ?, ?, 'client', ?, ?)`,
	).run(tokenId, grantId, SUBJECT_ID, CLIENT_ID, expiresAt, addedAt);
	db.prepare(
		`INSERT INTO grant_package_members(package_id, grant_id, token_id, source_json, status, added_at)
     VALUES(?, ?, ?, ?, 'active', ?)`,
	).run(packageId, grantId, tokenId, sourceJson, addedAt);
}

interface ReportedPackage {
	readonly children?: readonly { readonly grant_status?: unknown }[];
	readonly status?: unknown;
}

/** The lifecycle every surface reports for one package, gathered in one place. */
async function reportedLifecycles(packageId: string): Promise<{
	activeChildCount: number;
	cumulativeChildStatuses: string[];
	cumulativePackageStatus: string | undefined;
	detailChildStatuses: string[];
	detailStatus: unknown;
	listStatus: unknown;
}> {
	const page = (await listGrantPackagesForOwner({ limit: 200 })) as {
		data: readonly { package_id: string; status?: unknown }[];
	};
	const listRow = page.data.find((row) => row.package_id === packageId);
	assert.ok(listRow, `package ${packageId} must appear in the owner listing`);

	const detail = (await getGrantPackageForOwner(
		packageId,
	)) as ReportedPackage | null;
	assert.ok(
		detail,
		`package ${packageId} must resolve for the owner detail view`,
	);

	const cumulative = (await getCumulativeClientAccessForPackage(packageId)) as {
		active_child_count: number;
		children: readonly { grant_status?: unknown }[];
		packages: readonly { package_id: string; status?: unknown }[];
	} | null;
	assert.ok(
		cumulative,
		`package ${packageId} must resolve for the cumulative view`,
	);

	return {
		activeChildCount: cumulative.active_child_count,
		cumulativeChildStatuses: cumulative.children.map((child) =>
			String(child.grant_status),
		),
		cumulativePackageStatus: cumulative.packages
			.filter((pkg) => pkg.package_id === packageId)
			.map((pkg) => String(pkg.status))[0],
		detailChildStatuses: (detail.children ?? []).map((child) =>
			String(child.grant_status),
		),
		detailStatus: detail.status,
		listStatus: listRow.status,
	};
}

function registerCases(label: string, usePostgres: boolean): void {
	// ------------------------------------------------------------------
	// The defect itself.
	// ------------------------------------------------------------------
	test(`${label}: an elapsed grant reports "expired" on every owner-facing surface`, async () => {
		const packageId = `pkg_${label}_expired`;
		await seedPackage(usePostgres, { expiresAt: PAST_DEADLINE, packageId });

		const reported = await reportedLifecycles(packageId);

		// Before the fix every one of these read "active" while the same grant was
		// being refused with 401/403 on read.
		assert.equal(
			reported.listStatus,
			"expired",
			"GET /_ref/grant-packages must report expired",
		);
		assert.equal(
			reported.detailStatus,
			"expired",
			"GET /_ref/grant-packages/:id must report expired",
		);
		assert.deepEqual(
			reported.detailChildStatuses,
			["expired"],
			"each child grant_status must report expired",
		);
		assert.equal(
			reported.cumulativePackageStatus,
			"expired",
			"the cumulative view must report expired",
		);
		assert.deepEqual(
			reported.cumulativeChildStatuses,
			["expired"],
			"cumulative children must report expired",
		);
		// A lapsed child is not access the client still holds.
		assert.equal(
			reported.activeChildCount,
			0,
			"an expired child must not count as active",
		);
	});

	// ------------------------------------------------------------------
	// Controls: the fix must not relabel anything else.
	// ------------------------------------------------------------------
	test(`${label}: an unexpired grant still reports "active"`, async () => {
		const packageId = `pkg_${label}_active`;
		await seedPackage(usePostgres, { expiresAt: FUTURE_DEADLINE, packageId });

		const reported = await reportedLifecycles(packageId);

		assert.equal(reported.listStatus, "active");
		assert.equal(reported.detailStatus, "active");
		assert.deepEqual(reported.detailChildStatuses, ["active"]);
		assert.equal(reported.cumulativePackageStatus, "active");
		assert.equal(reported.activeChildCount, 1);
	});

	test(`${label}: a grant with no expiry still reports "active"`, async () => {
		// spec-core.md, Grant `expires_at`: "null means no expiry".
		const packageId = `pkg_${label}_noexpiry`;
		await seedPackage(usePostgres, { expiresAt: null, packageId });

		const reported = await reportedLifecycles(packageId);

		assert.equal(reported.listStatus, "active");
		assert.equal(reported.detailStatus, "active");
		assert.deepEqual(reported.detailChildStatuses, ["active"]);
		assert.equal(reported.activeChildCount, 1);
	});

	test(`${label}: a revoked grant past its deadline still reports "revoked", not "expired"`, async () => {
		// Revocation is a durable owner act. The clock must not overwrite it, or
		// the audit trail loses the fact that someone revoked this grant.
		const packageId = `pkg_${label}_revoked`;
		await seedPackage(usePostgres, {
			expiresAt: PAST_DEADLINE,
			grantStatus: "revoked",
			packageId,
			packageStatus: "revoked",
		});

		const reported = await reportedLifecycles(packageId);

		assert.equal(reported.listStatus, "revoked");
		assert.equal(reported.detailStatus, "revoked");
		assert.deepEqual(reported.detailChildStatuses, ["revoked"]);
		assert.equal(reported.cumulativePackageStatus, "revoked");
		assert.equal(reported.activeChildCount, 0);
	});

	test(`${label}: a package whose members have not all lapsed still reports "active"`, async () => {
		// A package carries no deadline of its own. With one live member it still
		// grants access, so reporting the package "expired" would be wrong even
		// though one of its children has lapsed.
		const packageId = `pkg_${label}_mixed`;
		await seedPackage(usePostgres, { expiresAt: PAST_DEADLINE, packageId });
		const liveGrantId = `grt_${packageId}_live`;
		const sourceJson = JSON.stringify({
			kind: "connector",
			id: "https://example.test/connectors/github",
		});
		if (usePostgres) {
			await postgresQuery(
				`INSERT INTO grants(grant_id, subject_id, client_id, grant_json, access_mode, status, issued_at, expires_at)
         VALUES($1, $2, $3, $4::jsonb, 'read', 'active', $5, $6)`,
				[
					liveGrantId,
					SUBJECT_ID,
					CLIENT_ID,
					grantJson(liveGrantId, FUTURE_DEADLINE),
					ISSUED_AT,
					FUTURE_DEADLINE,
				],
			);
		} else {
			getDb()
				.prepare(
					`INSERT INTO grants(grant_id, subject_id, client_id, grant_json, access_mode, status, issued_at, expires_at)
           VALUES(?, ?, ?, ?, 'read', 'active', ?, ?)`,
				)
				.run(
					liveGrantId,
					SUBJECT_ID,
					CLIENT_ID,
					grantJson(liveGrantId, FUTURE_DEADLINE),
					ISSUED_AT,
					FUTURE_DEADLINE,
				);
		}
		await seedMemberWithToken(usePostgres, {
			addedAt: ISSUED_AT,
			expiresAt: FUTURE_DEADLINE,
			grantId: liveGrantId,
			packageId,
			sourceJson,
		});

		const reported = await reportedLifecycles(packageId);

		assert.equal(
			reported.listStatus,
			"active",
			"one live member keeps the package active",
		);
		assert.equal(reported.detailStatus, "active");
		// The children still report their OWN lifecycles independently.
		assert.deepEqual([...reported.detailChildStatuses].sort(), [
			"active",
			"expired",
		]);
		assert.equal(
			reported.activeChildCount,
			1,
			"only the live child counts as active",
		);
	});
}

test.describe("grant lifecycle reporting (sqlite)", () => {
	test.before(() => {
		initDb(":memory:");
	});
	test.after(() => {
		closeDb();
	});
	registerCases("sqlite", false);
});

if (POSTGRES_URL) {
	test.describe("grant lifecycle reporting (postgres)", () => {
		test.before(async () => {
			await initPostgresStorage({
				backend: "postgres",
				databaseUrl: POSTGRES_URL,
			});
		});
		test.after(async () => {
			// Leave the scratch database clean for a re-run. Order matters: members
			// reference both packages and grants. Tokens are cleaned too — leaving
			// them behind made a second run collide on `tokens.token_id`.
			await postgresQuery(
				"DELETE FROM grant_package_members WHERE package_id LIKE 'pkg_postgres_%'",
			);
			await postgresQuery(
				"DELETE FROM grant_packages WHERE package_id LIKE 'pkg_postgres_%'",
			);
			await postgresQuery("DELETE FROM tokens WHERE client_id = $1", [
				CLIENT_ID,
			]);
			await postgresQuery("DELETE FROM grants WHERE client_id = $1", [
				CLIENT_ID,
			]);
			await closePostgresStorage();
		});
		registerCases("postgres", true);
	});
} else {
	test("grant lifecycle reporting (postgres) (skipped: PDPP_TEST_POSTGRES_URL unset)", {
		skip: true,
	}, () => {
		/* placeholder so the Postgres lane is visible in the report */
	});
}
