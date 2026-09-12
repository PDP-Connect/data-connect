// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Round-3 review defects in the pure derivation (server/grant-lifecycle.ts).
//
// D-R2 — PACKAGE LIFECYCLE IGNORED REVOCATION. `derivePackageLifecycle` took
// only member EXPIRY timestamps. Revocation is the one lifecycle transition
// the AS actually persists, and it was the one input the package reduction
// could not see. A package whose children had every one been individually
// revoked therefore still reported "active", while
// `getCumulativeClientAccessForPackage` reported `active_child_count: 0` for
// the same package in the same response — the reviewer's reproduction:
//
//     {"statuses":["expired","revoked"],"activeCount":0,
//      "reportedPackageStatus":"active"}
//
// A member is live only when the grant is active, the membership row is
// active, AND the deadline has not passed. The package reduction now takes
// the same three facts `active_child_count` already filters on, so the two
// numbers in one response cannot contradict each other.
//
// D-R3 — AN UNPARSABLE DEADLINE WAS REPORTED ACTIVE. `hasGrantExpired`
// returned `false` for a malformed `expires_at`, which is the same value it
// returns for "no expiry". A deadline we cannot read is not a deadline that
// does not exist: collapsing the two turned unreadable data into an
// affirmative "active" claim on an owner-facing audit surface. The predicate
// now reports three distinct outcomes and the caller surfaces the third
// rather than guessing.

import { strict as assert } from "node:assert/strict";
import { test } from "node:test";

import {
	classifyGrantDeadline,
	derivePackageLifecycle,
	hasGrantExpired,
	type PackageMemberLifecycleInput,
} from "../server/grant-lifecycle.ts";

const DEADLINE = "2026-09-07T23:47:38.373Z";
const DEADLINE_MS = Date.parse(DEADLINE);
const PAST = DEADLINE_MS + 1;

/** A live member: active grant, active membership, deadline not yet reached. */
function liveMember(
	overrides: Partial<PackageMemberLifecycleInput> = {},
): PackageMemberLifecycleInput {
	return {
		expiresAt: DEADLINE,
		grantStatus: "active",
		memberStatus: "active",
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// D-R2: revocation is an input to the package reduction
// ---------------------------------------------------------------------------

test("derivePackageLifecycle: every child revoked reports revoked, not active", () => {
	// The reviewer's headline case. Before the fix the reduction saw only
	// `[null, null]` — two members with no deadline — and reported "active"
	// for a package with nothing live in it.
	const members = [
		liveMember({ grantStatus: "revoked", expiresAt: null }),
		liveMember({ grantStatus: "revoked", expiresAt: null }),
	];
	assert.equal(derivePackageLifecycle("active", members, PAST), "revoked");
});

test("derivePackageLifecycle: a revoked child with no expiry still counts as dead", () => {
	// Pinned separately because `expiresAt: null` is exactly the shape that
	// used to read as "no deadline, therefore live".
	const members = [liveMember({ grantStatus: "revoked", expiresAt: null })];
	assert.equal(derivePackageLifecycle("active", members, PAST), "revoked");
});

test("derivePackageLifecycle: revocation via member_status counts as dead", () => {
	// `markMemberRevoked` writes grant_package_members.status, not grants.status.
	// Either column alone must be enough to take a member out of the live set.
	const members = [liveMember({ memberStatus: "revoked", expiresAt: null })];
	assert.equal(derivePackageLifecycle("active", members, PAST), "revoked");
});

test("derivePackageLifecycle: a revoked + expired mixture reports expired", () => {
	// Nothing is live, so the package is terminal. Expiry is reported in
	// preference to revocation when BOTH appear among the children, because
	// the package as a whole was not revoked — only some of its members were,
	// and the rest simply lapsed.
	const members = [
		liveMember({ grantStatus: "revoked", expiresAt: null }),
		liveMember({ expiresAt: DEADLINE }), // lapsed at PAST
	];
	assert.equal(derivePackageLifecycle("active", members, PAST), "expired");
});

test("derivePackageLifecycle: a revoked + live mixture stays active", () => {
	// One live member still grants access, so the package is still active.
	// This is the control that keeps the fix from over-reporting terminal.
	const members = [
		liveMember({ grantStatus: "revoked", expiresAt: null }),
		liveMember({ expiresAt: null }), // no deadline, active: genuinely live
	];
	assert.equal(derivePackageLifecycle("active", members, PAST), "active");
});

test("derivePackageLifecycle: a package with no members stays active", () => {
	// Unchanged behaviour, pinned so the revocation fix cannot regress it:
	// there is no member to be dead, so there is no deadline to have passed.
	assert.equal(derivePackageLifecycle("active", [], PAST), "active");
});

test("derivePackageLifecycle: an explicitly revoked package outranks its members", () => {
	// Revocation of the package itself is an owner act and is never
	// recomputed from the children.
	assert.equal(
		derivePackageLifecycle("revoked", [liveMember({ expiresAt: null })], PAST),
		"revoked",
	);
});

// ---------------------------------------------------------------------------
// D-R3: an unreadable deadline is indeterminate, not "no deadline"
// ---------------------------------------------------------------------------

test("classifyGrantDeadline: distinguishes none / valid / unparsable", () => {
	assert.equal(classifyGrantDeadline(null, PAST), "none");
	assert.equal(classifyGrantDeadline(undefined, PAST), "none");
	assert.equal(classifyGrantDeadline(DEADLINE, PAST), "expired");
	assert.equal(classifyGrantDeadline(DEADLINE, DEADLINE_MS - 1), "active");
	// The boundary stays exclusive, matching introspect().
	assert.equal(classifyGrantDeadline(DEADLINE, DEADLINE_MS), "active");
	// The defect: these used to be indistinguishable from "none".
	assert.equal(classifyGrantDeadline("not-a-date", PAST), "indeterminate");
	assert.equal(
		classifyGrantDeadline("2026-13-45T99:99:99Z", PAST),
		"indeterminate",
	);
	assert.equal(classifyGrantDeadline("", PAST), "none");
});

test("hasGrantExpired: an unparsable deadline is no longer silently 'not expired'", () => {
	// The predicate keeps its boolean shape for the callers that only need
	// "has the clock passed it", but an unreadable deadline is now an explicit
	// refusal rather than a quiet `false` that reads as an affirmative claim.
	assert.equal(hasGrantExpired(null, PAST), false);
	assert.equal(hasGrantExpired(DEADLINE, PAST), true);
	assert.equal(hasGrantExpired(DEADLINE, DEADLINE_MS - 1), false);
	assert.throws(() => hasGrantExpired("not-a-date", PAST), /indeterminate/i);
});

test("derivePackageLifecycle: an unreadable member deadline is not counted as live", () => {
	// A member whose deadline cannot be read is not evidence of liveness, so
	// it cannot hold a package "active" on its own. It reports the
	// indeterminate lifecycle rather than an affirmative "active".
	const members = [liveMember({ expiresAt: "not-a-date" })];
	assert.equal(
		derivePackageLifecycle("active", members, PAST),
		"indeterminate",
	);
});

test("derivePackageLifecycle: a live member outranks an unreadable sibling", () => {
	// If something is definitely live, the package is definitely active and
	// the unreadable sibling does not make the answer uncertain.
	const members = [
		liveMember({ expiresAt: "not-a-date" }),
		liveMember({ expiresAt: null }),
	];
	assert.equal(derivePackageLifecycle("active", members, PAST), "active");
});
