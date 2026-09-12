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
 *   1. The bound is now real, on EVERY per-package member read. Each query is
 *      keyset-paged with a literal `LIMIT 256`, so `@max_rows: 256` describes
 *      ONE PAGE — something the SQL actually guarantees — and each caller
 *      loops until a short page returns. Any member count reads correctly.
 *
 *      Chosen over enforcing 256 at issuance because that would not rescue
 *      packages already past the bound in an existing database, and it would
 *      add a protocol-visible hard refusal to issuance that spec-core does not
 *      require.
 *
 *      An earlier revision paged only `expiries-by-package.sql` (the list
 *      route) and left `list-all-by-package.sql` and
 *      `list-active-by-package.sql` unpaged, so FOUR owner-facing surfaces
 *      still failed past 256 — the package DETAIL route, package REVOCATION,
 *      MCP access fan-out, and MCP refresh-token issuance. All four are
 *      covered by tests below.
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
	getGrantPackageAccess,
	getGrantPackageForOwner,
	listGrantPackagesForOwner,
	revokeGrantPackage,
} from "../server/auth.ts";
import { getDb } from "../server/db.ts";
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

		// "and reads" -- this assertion is what the title always promised. An
		// earlier revision of this test stopped at the list route above, so the
		// detail route went on throwing SmallEnumerationOverflowError past 256
		// while the suite stayed green.
		const detail = await getGrantPackageForOwner(packageId);
		assert.ok(detail, "a 257-member package must not fail the detail route");
		assert.equal(detail.member_count, PAGE_SIZE + 1);
		assert.equal(
			(detail.children as unknown[]).length,
			PAGE_SIZE + 1,
			"every member must survive paging, not just the first page",
		);
	} finally {
		await driver.teardown();
	}
});

test("the detail route returns members in (added_at, grant_id) order across page boundaries", async () => {
	// Behavior-preservation gate. `children` is passed through to the owner's
	// detail payload in the query's ORDER BY sequence, so paging must not
	// reorder it -- which is why the keyset is the composite pair and not
	// `grant_id` alone.
	const driver = createSqliteConsentDeviceAuthDriver();
	await driver.setup();
	try {
		const packageId = await issuePackageWithMembers(driver, "order", 600);
		const detail = await getGrantPackageForOwner(packageId);
		assert.ok(detail);
		const children = detail.children as {
			added_at: string;
			grant_id: string;
		}[];
		assert.equal(children.length, 600);

		// No member is skipped or repeated across the three pages.
		assert.equal(
			new Set(children.map((child) => child.grant_id)).size,
			600,
			"paging must not drop or duplicate a member",
		);

		for (let i = 1; i < children.length; i += 1) {
			const prev = children[i - 1];
			const cur = children[i];
			assert.ok(prev && cur);
			const ordered =
				prev.added_at < cur.added_at ||
				(prev.added_at === cur.added_at && prev.grant_id < cur.grant_id);
			assert.ok(
				ordered,
				`members out of order at ${i}: ${prev.added_at}/${prev.grant_id} then ${cur.added_at}/${cur.grant_id}`,
			);
		}
	} finally {
		await driver.teardown();
	}
});

test("paging survives members that share one added_at", async () => {
	// Why the keyset is the COMPOSITE (added_at, grant_id) and not added_at
	// alone. `added_at` is a per-member `nowIso()` with millisecond precision
	// and nothing makes it unique, so members issued inside one millisecond
	// tie. A tie straddling a page boundary is the dangerous case: an
	// added_at-only keyset cannot advance past it.
	//
	// Collapsing every added_at to one value is the worst case of that, and it
	// fails LOUDLY in the right way — with an added_at-only keyset this
	// returns 256 of 600 members, silently, with no error raised. Silent
	// truncation of an owner's grant list is worse than the overflow this
	// whole change set is fixing.
	const driver = createSqliteConsentDeviceAuthDriver();
	await driver.setup();
	try {
		const packageId = await issuePackageWithMembers(driver, "tie", 600);
		getDb()
			.prepare(
				"UPDATE grant_package_members SET added_at = ? WHERE package_id = ?",
			)
			.run("2026-01-01T00:00:00.000Z", packageId);

		const detail = await getGrantPackageForOwner(packageId);
		assert.ok(detail);
		const children = detail.children as { grant_id: string }[];
		assert.equal(
			children.length,
			600,
			"every member must survive paging when added_at ties",
		);
		assert.equal(
			new Set(children.map((child) => child.grant_id)).size,
			600,
			"no member may be skipped or repeated across a tied page boundary",
		);
	} finally {
		await driver.teardown();
	}
});

test("an oversized package is still revokable", async () => {
	// Revocation enumerates active members through the SAME bounded read. With
	// it unpaged, the owner could not revoke the package they most wanted to
	// revoke: the guard threw before any grant was revoked.
	const driver = createSqliteConsentDeviceAuthDriver();
	await driver.setup();
	try {
		const packageId = await issuePackageWithMembers(
			driver,
			"revoke",
			PAGE_SIZE + 1,
		);

		await revokeGrantPackage(packageId);

		const detail = await getGrantPackageForOwner(packageId);
		assert.ok(detail);
		assert.equal(detail.status, "revoked");
		const children = detail.children as { grant_status: string }[];
		assert.equal(
			children.filter((child) => child.grant_status === "revoked").length,
			PAGE_SIZE + 1,
			"the cascade must reach every member, including past the first page",
		);
	} finally {
		await driver.teardown();
	}
});

test("an oversized package still resolves MCP access for every active member", async () => {
	// The fan-out path reads `list-active-by-package.sql`, which carried the
	// same unpaged 256 bound.
	const driver = createSqliteConsentDeviceAuthDriver();
	await driver.setup();
	try {
		const packageId = await issuePackageWithMembers(
			driver,
			"access",
			PAGE_SIZE + 1,
		);

		const access = await getGrantPackageAccess(packageId);
		assert.ok(access, "MCP access resolution must not fail past the bound");
		assert.equal((access.members as unknown[]).length, PAGE_SIZE + 1);
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
