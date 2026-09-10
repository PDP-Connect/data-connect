// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Unit tests for the pure grant-lifecycle derivation
// (server/grant-lifecycle.ts).
//
// Defect D4, REPORTING ONLY: a grant whose `expires_at` had passed was
// REPORTED "active" by `grants.status` and by
// `GET /_ref/grant-packages/:id`. This module does not make such a grant be
// refused, and these tests do not show that it is. Enforcement compares
// `tokens.expires_at`, never `grants.expires_at`, so introspection can still
// return active for an elapsed grant — a separate, unresolved defect. See the
// SCOPE note in server/grant-lifecycle.ts.
//
// spec-core.md:533 and the AS conformance
// list at :1360 require the AS to track lifecycle as active / expired /
// revoked; only `revoked` was ever persisted, so `expired` could never be
// reported. These tests pin the derivation that closes that gap.
//
// Every case passes an explicit `nowMs` rather than reading the clock, so the
// exact-boundary case is testable at all and the suite cannot go green or red
// for reasons of wall-clock timing.

import { strict as assert } from "node:assert/strict";
import { test } from "node:test";

import {
	deriveGrantLifecycle,
	derivePackageLifecycle,
	hasGrantExpired,
} from "../server/grant-lifecycle.ts";

const DEADLINE = "2026-09-07T23:47:38.373Z"; // the expires_at from the D4 report
const DEADLINE_MS = Date.parse(DEADLINE);

test("deriveGrantLifecycle: an active grant past its deadline reports expired", () => {
	// The D4 defect itself: status column says 'active', the deadline has passed.
	assert.equal(
		deriveGrantLifecycle("active", DEADLINE, DEADLINE_MS + 1),
		"expired",
	);
	assert.equal(
		deriveGrantLifecycle("active", DEADLINE, DEADLINE_MS + 86_400_000),
		"expired",
	);
});

test("deriveGrantLifecycle: an active grant before its deadline stays active", () => {
	assert.equal(
		deriveGrantLifecycle("active", DEADLINE, DEADLINE_MS - 1),
		"active",
	);
	assert.equal(
		deriveGrantLifecycle("active", DEADLINE, DEADLINE_MS - 86_400_000),
		"active",
	);
});

test("deriveGrantLifecycle: the boundary is exclusive — active AT expires_at", () => {
	// Pinned deliberately. `introspect()` refuses with `expires_at < now`, so
	// reporting must flip on the same comparison; an inclusive boundary here
	// would report 'expired' for a grant that still serves data.
	assert.equal(deriveGrantLifecycle("active", DEADLINE, DEADLINE_MS), "active");
	assert.equal(
		deriveGrantLifecycle("active", DEADLINE, DEADLINE_MS + 1),
		"expired",
	);
});

test("deriveGrantLifecycle: a revoked grant stays revoked, before AND after its deadline", () => {
	// Revocation is an owner action and outranks the clock. Reporting a revoked
	// grant as 'expired' would erase the fact that someone revoked it.
	assert.equal(
		deriveGrantLifecycle("revoked", DEADLINE, DEADLINE_MS - 1),
		"revoked",
	);
	assert.equal(
		deriveGrantLifecycle("revoked", DEADLINE, DEADLINE_MS + 1),
		"revoked",
	);
});

test("deriveGrantLifecycle: a grant with no expiry is never expired", () => {
	// spec-core.md, Grant `expires_at`: "null means no expiry". Absent and
	// explicit-null both mean the same thing.
	const farFuture = DEADLINE_MS + 10 * 365 * 86_400_000;
	assert.equal(deriveGrantLifecycle("active", null, farFuture), "active");
	assert.equal(deriveGrantLifecycle("active", undefined, farFuture), "active");
});

test("deriveGrantLifecycle: an unparseable expires_at is reported indeterminate", () => {
	// Refusing to guess beats reporting a lifecycle we cannot substantiate.
	// Reporting 'active' here WAS the guess: it made an unreadable deadline
	// indistinguishable from a grant that has no deadline at all.
	assert.equal(
		deriveGrantLifecycle("active", "not-a-date", DEADLINE_MS + 1),
		"indeterminate",
	);
});

test("deriveGrantLifecycle: an unrecognised status is passed through, not coerced", () => {
	// A future lifecycle state must not be silently relabelled 'active'.
	assert.equal(
		deriveGrantLifecycle("suspended", DEADLINE, DEADLINE_MS + 1),
		"suspended",
	);
});

test("hasGrantExpired: pins the raw predicate at and around the boundary", () => {
	assert.equal(hasGrantExpired(DEADLINE, DEADLINE_MS - 1), false);
	assert.equal(hasGrantExpired(DEADLINE, DEADLINE_MS), false);
	assert.equal(hasGrantExpired(DEADLINE, DEADLINE_MS + 1), true);
	assert.equal(hasGrantExpired(null, DEADLINE_MS + 1), false);
	assert.equal(hasGrantExpired("", DEADLINE_MS + 1), false);
});

// `derivePackageLifecycle` takes full member lifecycle inputs, not bare
// expiry strings: revocation is a lifecycle fact the reduction must see. See
// grant-lifecycle-revocation-and-indeterminate.test.ts for the revocation
// cases; these pin the expiry-only reduction.
const activeMember = (expiresAt: string | null) => ({
	expiresAt,
	grantStatus: "active",
	memberStatus: "active",
});

test("derivePackageLifecycle: expired only when EVERY member has lapsed", () => {
	const later = "2026-12-31T00:00:00.000Z";
	const now = DEADLINE_MS + 1; // past DEADLINE, before `later`

	// All members lapsed -> the package as a whole grants nothing.
	assert.equal(
		derivePackageLifecycle(
			"active",
			[activeMember(DEADLINE), activeMember(DEADLINE)],
			now,
		),
		"expired",
	);
	// One member still live -> the package still grants access.
	assert.equal(
		derivePackageLifecycle(
			"active",
			[activeMember(DEADLINE), activeMember(later)],
			now,
		),
		"active",
	);
	// A member with no expiry never lapses, so it keeps the package live.
	assert.equal(
		derivePackageLifecycle(
			"active",
			[activeMember(DEADLINE), activeMember(null)],
			now,
		),
		"active",
	);
});

test("derivePackageLifecycle: a package with no members has no deadline to pass", () => {
	assert.equal(derivePackageLifecycle("active", [], DEADLINE_MS + 1), "active");
});

test("derivePackageLifecycle: a revoked package stays revoked even once every member lapses", () => {
	assert.equal(
		derivePackageLifecycle(
			"revoked",
			[activeMember(DEADLINE)],
			DEADLINE_MS + 1,
		),
		"revoked",
	);
});
