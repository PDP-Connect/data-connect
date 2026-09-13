// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Grant lifecycle derivation: active / expired / revoked.
//
// spec-core.md:533 — "Grant lifecycle (active, expired, revoked) is tracked by
// the authorization server, not stored in the grant itself." AS conformance
// item 8 (spec-core.md:1360) repeats the same three-state vocabulary.
//
// Only ONE of those three states is persisted. `grants.status` and
// `grant_packages.status` default to 'active' and are flipped to 'revoked' by
// an explicit owner action (`markPackageRevokedCascade`). Nothing ever writes
// 'expired' to either column, because expiry is not an event the AS observes —
// it is a deadline that passes on its own.
//
// This module fixes REPORTING only: an owner auditing their grants saw
// 'active' for a grant that had in fact lapsed. It derives the reported
// lifecycle from the two facts that determine it — the persisted status and
// the deadline — at the moment of reporting.
//
// SCOPE — enforcement is a SEPARATE, UNRESOLVED defect. Do not read this
// module as evidence that elapsed grants are refused. `introspect()` compares
// `tokens.expires_at`, and for `mcp_package` tokens the member filter
// (auth.ts, `getGrantPackageAccess`) compares only `token_expires_at`.
// `grants.expires_at` is selected by those queries but never compared
// temporally — outside this module its only consumer is the equality check in
// `requirePersistedGrantColumnBindings`. The consent-acceptance dossier
// (CONSENT-ACCEPTANCE-0907.md, "D4, re-graded") records introspection
// returning `active: true` for an elapsed grant on both backends. Nothing here
// changes that path.
//
// DERIVED, NOT PERSISTED. Two reasons:
//
//   1. The spec says lifecycle is "tracked by the authorization server", not
//      that each state is stored in a column. Deriving tracks it exactly, and
//      is correct the instant the deadline passes. A persisted transition is
//      only as fresh as whatever last wrote it, so it would report 'active'
//      for any grant that expired since the last write — reintroducing the
//      same defect with a smaller window.
//   2. Persisting would require a sweep to notice the deadline. That is a
//      scheduler, and a scheduler is a new failure mode (missed ticks, clock
//      skew, one more thing to run in every deployment) bought for no
//      correctness gain over reading the clock at report time.
//
// Revocation stays persistent and keeps precedence: it is a real event, it is
// what the cascade writes, and an owner who revoked a grant should keep seeing
// 'revoked' after its deadline also passes, not have that action overwritten
// by the clock.
//
// This module is deliberately pure and clock-injected so every branch —
// including the exact-boundary case — is unit-testable without a database.

/** The three lifecycle states the spec defines for a grant. */
export type GrantLifecycle = "active" | "expired" | "revoked";

/**
 * Derives the lifecycle to REPORT for one grant or grant package.
 *
 * @param persistedStatus  the `status` column as stored ('active' | 'revoked',
 *                         or any other value a future migration introduces).
 * @param expiresAt        the `expires_at` column. Null/absent means no expiry
 *                         (spec-core.md, Grant `expires_at`: "null means no
 *                         expiry"), so such a grant is never reported expired.
 * @param nowMs            the instant to evaluate against, in epoch ms.
 *
 * Precedence: revoked > expired > active.
 *
 * A status this function does not recognise is passed through untouched rather
 * than being coerced, so a future state cannot be silently relabelled 'active'.
 */
export function deriveGrantLifecycle(
	persistedStatus: string,
	expiresAt: string | null | undefined,
	nowMs: number,
): string {
	// Revocation is an owner action and outranks the clock. Anything that is not
	// currently 'active' is already in a terminal state we must not overwrite.
	if (persistedStatus !== "active") {
		return persistedStatus;
	}
	switch (classifyGrantDeadline(expiresAt, nowMs)) {
		case "expired":
			return "expired";
		// A deadline we cannot read is reported as such rather than as 'active'.
		// Silently falling back to the persisted status would make unreadable
		// data indistinguishable from a grant with no expiry.
		case "indeterminate":
			return "indeterminate";
		default:
			return persistedStatus;
	}
}

/**
 * Has this deadline passed as of `nowMs`?
 *
 * The boundary is EXCLUSIVE: a grant is expired once `nowMs` is strictly past
 * `expires_at`, and is still active at the instant the deadline is reached.
 * The comparison operator deliberately matches the one `introspect()` uses on
 * `tokens.expires_at` (`new Date(row.expires_at) < new Date()`, auth.ts).
 * Sharing the operator only aligns the two WHEN THE TWO DEADLINES ARE
 * IDENTICAL; it says nothing about when token access is actually refused,
 * because the deadlines are different columns.
 *
 * This function reads `grants.expires_at`, which is what lets a grant be
 * reported 'expired' on surfaces that never load a token at all. Do not infer
 * from the matching boundary that the two paths agree in general — see the
 * SCOPE note at the top of this file: the package-token enforcement path does
 * not compare the grant's deadline at all, and that defect is unresolved.
 *
 * An `expires_at` that does not parse is INDETERMINATE and throws here. It is
 * not "no deadline": returning `false` for both made an unreadable column
 * indistinguishable from an absent one, which turned data we cannot read into
 * an affirmative "active" claim on an owner-facing audit surface. Callers that
 * must tolerate the condition use `classifyGrantDeadline` and surface it.
 */
export function hasGrantExpired(
	expiresAt: string | null | undefined,
	nowMs: number,
): boolean {
	const deadline = classifyGrantDeadline(expiresAt, nowMs);
	if (deadline === "indeterminate") {
		throw new Error(
			`grant expires_at is indeterminate (unparsable): ${JSON.stringify(expiresAt)}`,
		);
	}
	return deadline === "expired";
}

/**
 * How a single `expires_at` reads against `nowMs`.
 *
 * Four outcomes, deliberately distinct:
 *
 *   - `none`          — null/absent/empty. Spec-core: "null means no expiry",
 *                       so such a grant is never reported expired.
 *   - `active`        — a readable deadline that has not been passed.
 *   - `expired`       — a readable deadline strictly in the past.
 *   - `indeterminate` — a value that does not parse. We cannot say the grant
 *                       is live and we cannot say it has lapsed. Reporting
 *                       either would be a claim the data does not support.
 *
 * The boundary between `active` and `expired` is EXCLUSIVE: a grant is expired
 * once `nowMs` is strictly past `expires_at`, and is still active at the
 * instant the deadline is reached. That matches the operator `introspect()`
 * uses on `tokens.expires_at` — but see the SCOPE note at the top of this
 * file: matching the operator aligns the two only when the two deadlines are
 * identical, and says nothing about when access is actually refused.
 */
export type GrantDeadlineClassification =
	| "active"
	| "expired"
	| "indeterminate"
	| "none";

export function classifyGrantDeadline(
	expiresAt: string | null | undefined,
	nowMs: number,
): GrantDeadlineClassification {
	if (!expiresAt) {
		return "none";
	}
	const deadlineMs = new Date(expiresAt).getTime();
	if (!Number.isFinite(deadlineMs)) {
		return "indeterminate";
	}
	return deadlineMs < nowMs ? "expired" : "active";
}

/**
 * The three facts that decide whether one package member is still live.
 *
 * Taking only `expiresAt` was a defect: revocation is the ONE lifecycle
 * transition this system actually persists, and it was the one input the
 * package reduction could not see. A package whose children had every one been
 * revoked still reported 'active', while `active_child_count` in the very same
 * response reported 0 — two contradictory answers about one package.
 *
 * `memberStatus` and `grantStatus` are separate columns because they are
 * revoked by different paths: `markPackageRevokedCascade` writes
 * `grants.status`, `markMemberRevoked` writes `grant_package_members.status`.
 * Either one alone takes the member out of the live set, which is exactly the
 * predicate `active_child_count` already filters on.
 */
export interface PackageMemberLifecycleInput {
	/** `grants.expires_at`; null/absent means no expiry. */
	readonly expiresAt: string | null | undefined;
	/** `grants.status`. */
	readonly grantStatus: string;
	/** `grant_package_members.status`. */
	readonly memberStatus: string;
}

/**
 * Package-level lifecycle. A package has no `expires_at` and no revocation
 * event of its own beyond an explicit owner revoke, so its reported lifecycle
 * is reduced from its members.
 *
 * Precedence, applied to the members that are NOT live:
 *
 *   1. Any live member          → 'active'. One member still granting access
 *                                 makes the package active, whatever the rest
 *                                 of them say. Checked first, so a definite
 *                                 liveness always beats an unreadable sibling.
 *   2. Any indeterminate member → 'indeterminate'. Nothing is definitely live
 *                                 and at least one deadline cannot be read, so
 *                                 we cannot substantiate any terminal answer.
 *   3. Any expired member       → 'expired'. Nothing live, nothing unreadable,
 *                                 and at least one member simply lapsed. The
 *                                 package was not revoked — some members were,
 *                                 and the rest ran out.
 *   4. Otherwise                → 'revoked'. Every member was revoked, which
 *                                 is a real owner act and is reported as one.
 *
 * A package with no members has no member to be dead and no deadline to have
 * passed, so it keeps its persisted status.
 *
 * An explicitly revoked package is never recomputed from its children: that is
 * an owner act and outranks anything the members say.
 */
export function derivePackageLifecycle(
	persistedStatus: string,
	members: readonly PackageMemberLifecycleInput[],
	nowMs: number,
): string {
	if (persistedStatus !== "active") {
		return persistedStatus;
	}
	if (members.length === 0) {
		return persistedStatus;
	}

	let sawIndeterminate = false;
	let sawExpired = false;
	for (const member of members) {
		// A revoked member is dead regardless of its deadline — including the
		// common case of a grant revoked BEFORE any deadline, which carries no
		// `expires_at` at all and used to read as "no deadline, therefore live".
		if (member.grantStatus !== "active" || member.memberStatus !== "active") {
			continue;
		}
		switch (classifyGrantDeadline(member.expiresAt, nowMs)) {
			case "active":
			case "none":
				return persistedStatus;
			case "indeterminate":
				sawIndeterminate = true;
				break;
			default:
				sawExpired = true;
				break;
		}
	}

	if (sawIndeterminate) {
		return "indeterminate";
	}
	return sawExpired ? "expired" : "revoked";
}
