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
	return hasGrantExpired(expiresAt, nowMs) ? "expired" : persistedStatus;
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
 * An `expires_at` that does not parse is treated as "no usable deadline" and
 * therefore NOT expired: refusing to guess is safer than reporting a lifecycle
 * we cannot substantiate, and enforcement is unaffected either way.
 */
export function hasGrantExpired(
	expiresAt: string | null | undefined,
	nowMs: number,
): boolean {
	if (!expiresAt) {
		return false;
	}
	const deadlineMs = new Date(expiresAt).getTime();
	if (!Number.isFinite(deadlineMs)) {
		return false;
	}
	return deadlineMs < nowMs;
}

/**
 * Package-level lifecycle. A package has no `expires_at` column of its own —
 * its deadline is the one carried by its member grants — so an active package
 * is reported 'expired' only when it has members and EVERY member has lapsed.
 * While any member is still live the package as a whole still grants access,
 * so it is still 'active'.
 *
 * A package with no members has no deadline to have passed, so it stays
 * 'active' (or whatever terminal status it already carries).
 */
export function derivePackageLifecycle(
	persistedStatus: string,
	memberExpiries: readonly (string | null | undefined)[],
	nowMs: number,
): string {
	if (persistedStatus !== "active") {
		return persistedStatus;
	}
	if (memberExpiries.length === 0) {
		return persistedStatus;
	}
	const allExpired = memberExpiries.every((expiresAt) =>
		hasGrantExpired(expiresAt, nowMs),
	);
	return allExpired ? "expired" : persistedStatus;
}
