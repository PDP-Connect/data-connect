// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * D-R4 — THE 256-MEMBER ASSUMPTION.
 *
 * `queries/auth/grant-package-members/expiries-by-package.sql` declared
 * `@max_rows: 256` and its comment treated that as "the SAME per-package
 * invariant that list-all-by-package.sql already carries". No issuance path
 * enforces any such ceiling: `createHostedMcpGrantPackage` writes one member
 * per approved authorization detail and never counts them.
 *
 * `allowUnboundedReadAcknowledged` ENFORCES the annotation — it throws
 * `SmallEnumerationOverflowError` when a read returns more rows than declared.
 * So the annotation was not a harmless stale comment: a 257-member package
 * made the owner's whole grant-package LIST fail, not just that one package.
 *
 * Two independent halves, both fixed here:
 *
 *   1. The bound is now real. The query is keyset-paged with a literal
 *      `LIMIT 256`, so `@max_rows: 256` describes ONE PAGE — something the SQL
 *      actually guarantees — and `listMemberLifecycleByPackage` loops until a
 *      short page returns. Any member count reads correctly.
 *
 *      Chosen over enforcing 256 at issuance because that would not rescue
 *      packages already past the bound in an existing database (the detail
 *      route reads `list-all-by-package.sql`, same declared bound, unpaged),
 *      and it would add a protocol-visible hard refusal to issuance that
 *      spec-core does not require.
 *
 *   2. The lookahead row is dropped BEFORE enrichment. The list route reads
 *      `limit + 1` rows to answer `has_more`, then discards the extra one. It
 *      used to fetch that discarded package's members too, so a single
 *      oversized package sitting just past the page boundary could fail a page
 *      of packages that were each well within the bound — the reviewer's
 *      reproduction, which observed 257 members returned for a `lookahead`
 *      package that was never part of the visible page.
 *
 * Packages are created through the REAL issuance path
 * (`createHostedMcpGrantPackage`), not by seeding rows, because the claim
 * under test is precisely that issuance enforces no ceiling.
 *
 * Run:
 *   PDPP_TEST_PROFILE=memory-default node --test --import tsx \
 *     reference-implementation/test/grant-package-member-bound.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
	createHostedMcpGrantPackage,
	getGrantPackageForOwner,
	listGrantPackagesForOwner,
} from "../server/auth.ts";
import { createSqliteConnectorInstanceStore } from "../server/stores/connector-instance-store.ts";
import { createSqliteConsentDeviceAuthDriver } from "./helpers/sqlite-consent-device-auth-driver.ts";

/** The per-page bound declared by the paged member query. */
const PAGE_SIZE = 256;

async function seedInstance(connectorInstanceId: string): Promise<void> {
	const now = new Date().toISOString();
	const account = `${connectorInstanceId}@example.com`;
	await createSqliteConnectorInstanceStore().upsert({
		connectorId: "spotify",
		connectorInstanceId,
		createdAt: now,
		displayName: account,
		ownerSubjectId: "owner_local",
		sourceBinding: { account },
		sourceBindingKey: account,
		sourceKind: "account",
		status: "active",
		updatedAt: now,
	});
}

/**
 * Issues ONE grant package carrying exactly `memberCount` members through the
 * real issuance path. One member is written per authorization detail, and each
 * detail is bound to its own seeded source instance.
 */
async function issuePackageWithMembers(
	driver: ReturnType<typeof createSqliteConsentDeviceAuthDriver>,
	prefix: string,
	memberCount: number,
): Promise<string> {
	const instanceIds: string[] = [];
	for (let i = 0; i < memberCount; i += 1) {
		const id = `cin_${prefix}_${i}`;
		await seedInstance(id);
		instanceIds.push(id);
	}
	const result = await createHostedMcpGrantPackage({
		authorizationDetails: instanceIds.map((instanceId) => ({
			access_mode: "continuous",
			purpose_code: "https://pdpp.dev/purpose/personal_ai_assistant",
			source: { id: driver.getRegisteredConnectorId(), kind: "connector" },
			streams: [{ instance_ids: [instanceId], name: "top_artists" }],
			type: "https://pdpp.dev/data-access",
		})),
		clientId: driver.getRegisteredClientId(),
		connectionIds: instanceIds,
		storageBindings: instanceIds.map(() => ({ connector_id: "spotify" })),
	});
	const childGrants = result.child_grants as unknown[];
	assert.equal(
		childGrants.length,
		memberCount,
		"premise: issuance writes one member per authorization detail",
	);
	return result.package_id as string;
}

test("a package at the declared bound (256 members) lists and reads", async () => {
	const driver = createSqliteConsentDeviceAuthDriver();
	await driver.setup();
	try {
		const packageId = await issuePackageWithMembers(driver, "at", PAGE_SIZE);

		const detail = await getGrantPackageForOwner(packageId);
		assert.ok(detail, "the detail route must return the package");
		assert.equal(detail.member_count, PAGE_SIZE);

		const listed = await listGrantPackagesForOwner({ limit: 10 });
		const data = listed.data as { package_id: string; status: string }[];
		const found = data.find((row) => row.package_id === packageId);
		assert.ok(found, "the list route must return the package");
		// Every member is live, so the package is active.
		assert.equal(found.status, "active");
	} finally {
		await driver.teardown();
	}
});

test("a package PAST the declared bound (257 members) still lists and reads", async () => {
	// The defect: issuance happily writes the 257th member, and the bounded
	// read then threw SmallEnumerationOverflowError and failed the whole list.
	const driver = createSqliteConsentDeviceAuthDriver();
	await driver.setup();
	try {
		const packageId = await issuePackageWithMembers(
			driver,
			"past",
			PAGE_SIZE + 1,
		);

		const listed = await listGrantPackagesForOwner({ limit: 10 });
		const data = listed.data as { package_id: string; status: string }[];
		const found = data.find((row) => row.package_id === packageId);
		assert.ok(found, "a 257-member package must not fail the list route");
		assert.equal(found.status, "active");
	} finally {
		await driver.teardown();
	}
});

test("an oversized package in the LOOKAHEAD row does not fail the visible page", async () => {
	// The reviewer's reproduction. With limit=1 the route reads two rows: the
	// one it returns and one lookahead row it discards. The oversized package
	// is the discarded one, so its members were read for no reason and the
	// overflow failed a page whose only visible package had ONE member.
	const driver = createSqliteConsentDeviceAuthDriver();
	await driver.setup();
	try {
		// Issued first, so it sorts LAST under ORDER BY created_at DESC and
		// lands in the lookahead position.
		const lookaheadId = await issuePackageWithMembers(
			driver,
			"lookahead",
			PAGE_SIZE + 1,
		);
		const visibleId = await issuePackageWithMembers(driver, "visible", 1);

		const listed = await listGrantPackagesForOwner({ limit: 1 });
		const data = listed.data as { package_id: string }[];
		assert.equal(data.length, 1, "limit=1 must return exactly one package");
		const onlyRow = data[0];
		assert.ok(onlyRow);
		assert.equal(
			onlyRow.package_id,
			visibleId,
			"premise: the oversized package is the discarded lookahead row",
		);
		assert.notEqual(onlyRow.package_id, lookaheadId);
		// The lookahead row exists, so the caller is told there is more.
		assert.equal(listed.has_more, true);
		assert.ok(listed.next_cursor, "a further page must be reachable");
	} finally {
		await driver.teardown();
	}
});
