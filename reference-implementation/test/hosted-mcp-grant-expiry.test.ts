// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for owner-selectable grant expiry.
 *
 * The picker hardcoded no expiry and described it in a footnote, so the only
 * outcome available was indefinite access and the sentence read as a protocol
 * constraint rather than the default it was. `expires_at` is set by the AS;
 * nothing requires it to be null.
 *
 * These tests pin the parts that would be easy to get subtly wrong later:
 * that "no end date" produces an ABSENT `expires_at` rather than an explicit
 * null (`ResolvedGrant` rejects null as a value), that an unrecognized
 * submission is an error rather than a silent fallback, and that the copy
 * never restates the access mode — the exact failure of the footnote this
 * replaces (spec-core.md:889 forbids conflating grant validity with access
 * pattern).
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  HOSTED_MCP_DEFAULT_GRANT_EXPIRY_ID,
  HOSTED_MCP_GRANT_EXPIRY_OPTIONS,
  describeGrantExpiry,
  findGrantExpiryOption,
  resolveGrantExpiry,
} from "../server/hosted-mcp-grant-expiry.ts";

/** 2026-09-02T00:00:00Z, so expected instants are readable below. */
const NOW = Date.parse("2026-09-02T00:00:00.000Z");

const isoDay = (iso: string) => iso.slice(0, 10);

test("the default is a bounded window, not indefinite access", () => {
  // Google's polarity: an owner who does nothing gets an access window that
  // closes on its own; granting forever is an explicit choice.
  const defaultOption = findGrantExpiryOption(HOSTED_MCP_DEFAULT_GRANT_EXPIRY_ID);

  assert.ok(defaultOption);
  assert.equal(defaultOption.days, 90);
  assert.notEqual(defaultOption.days, null, "the default must not be no-expiry");
});

test("an omitted choice resolves to the bounded default", () => {
  const result = resolveGrantExpiry("", "continuous", NOW);

  assert.ok("expiresAt" in result);
  assert.equal(isoDay(result.expiresAt as string), "2026-12-01", "90 days after 2026-09-02");
});

test("each offered option resolves to the instant it names", () => {
  const ninety = resolveGrantExpiry("90d", "continuous", NOW);
  assert.ok("expiresAt" in ninety);
  assert.equal(isoDay(ninety.expiresAt as string), "2026-12-01");

  const year = resolveGrantExpiry("1y", "continuous", NOW);
  assert.ok("expiresAt" in year);
  assert.equal(isoDay(year.expiresAt as string), "2027-09-02");
});

test("no end date resolves to null, which callers must render as an absent field", () => {
  const result = resolveGrantExpiry("never", "continuous", NOW);

  assert.ok("expiresAt" in result);
  // ResolvedGrant.expires_at is absent-only: absence means no expiry and an
  // explicit null is not a valid value.
  assert.equal(result.expiresAt, null);
});

test("an unrecognized choice is an error rather than a silent default", () => {
  // Guessing would hand the owner an expiry they never chose, on the one
  // control whose purpose is bounding how long access lasts.
  const result = resolveGrantExpiry("forever-and-ever", "continuous", NOW);

  assert.ok("error" in result);
  assert.match(result.error, /how long/i);
});

test("single-use ignores the control, because expiry is not what bounds it", () => {
  // A single_use grant is consumed at first token issuance (spec-core.md:920).
  const result = resolveGrantExpiry("1y", "single_use", NOW);

  assert.ok("expiresAt" in result);
  assert.equal(result.expiresAt, null, "the picker suppresses the control for single_use");
});

test("every offered option has a distinct id and a label an owner can read", () => {
  const ids = HOSTED_MCP_GRANT_EXPIRY_OPTIONS.map((option) => option.id);

  assert.equal(new Set(ids).size, ids.length, "form values must be unambiguous");
  for (const option of HOSTED_MCP_GRANT_EXPIRY_OPTIONS) {
    assert.ok(option.label.trim().length > 0);
    // No protocol vocabulary on the owner path.
    assert.doesNotMatch(option.label, /expires_at|null|P\d+D/);
  }
});

test("expiry is described as a consequence, and never restates the access mode", () => {
  const ends = describeGrantExpiry("2026-12-01T00:00:00.000Z", isoDay);
  assert.equal(ends, "Access ends 2026-12-01.");

  const never = describeGrantExpiry(null, isoDay);
  assert.equal(never, "No scheduled end date.");

  // The footnote this replaces said "access lasts until you revoke it,
  // whichever access mode you choose above" — false under One-time access, and
  // a conflation spec-core.md:889 forbids.
  for (const copy of [ends, never]) {
    assert.doesNotMatch(copy, /revoke|one-time|ongoing|single|continuous|access mode/i);
    assert.doesNotMatch(copy, /expires_at/);
  }
});

// ─── Owner-picked dates ─────────────────────────────────────────────────────
//
// The quick-fill options are a shortcut for common windows, not the only
// windows allowed: the consent screen offers a real date picker (owner
// feedback round 2 — "arbitrary ISO-8601 grant expiry"). These pin the
// boundary between "a date this server will grant" and "a date it refuses",
// because both failure directions are silent ones — a rejected valid date
// reads to the owner as a broken control, and an accepted absurd date reads
// as a correct grant.

test("an owner-picked date resolves to the END of that day, not its first instant", () => {
  const result = resolveGrantExpiry("2026-12-02", "continuous", NOW);

  assert.ok("expiresAt" in result, "a date inside the bound must be granted");
  // An owner who picks "December 2" means access lasts THROUGH December 2.
  // Resolving to midnight would silently cut the last day off the grant.
  assert.equal(result.expiresAt, "2026-12-02T23:59:59.999Z");
});

test("a date beyond the five-year ceiling is refused, and says what to do instead", () => {
  const result = resolveGrantExpiry("2226-01-01", "continuous", NOW);

  // The mis-typed-year case: 2226 for 2026 would otherwise become a
  // two-century grant that looks, on the confirmation, exactly like a correct
  // one.
  assert.ok("error" in result, "an absurd date must not mint a two-century grant");
  assert.match(result.error, /five years/, "the owner is told the bound");
  assert.match(result.error, /no end date/i, "and the honest alternative to it");
});

test("a date in the past is refused rather than minting an already-dead grant", () => {
  const result = resolveGrantExpiry("2020-01-01", "continuous", NOW);

  assert.ok("error" in result);
  assert.match(result.error, /future/);
});

test("a rejected date never reads as an unrecognized keyword", () => {
  // Both are dates the server will not grant, so both must be answered as
  // date problems. Falling through to the option-id vocabulary would tell an
  // owner who picked a real date to "choose how long this access should last"
  // — advice that does not describe what they did wrong.
  for (const value of ["2226-01-01", "2020-01-01"]) {
    const result = resolveGrantExpiry(value, "continuous", NOW);
    assert.ok("error" in result);
    assert.doesNotMatch(result.error, /how long this access should last/);
  }
});

test("the fixed option ids still resolve, and a non-date keyword is still an error", () => {
  // The date path must not have swallowed the vocabulary the form POST uses.
  const ninety = resolveGrantExpiry("90d", "continuous", NOW);
  assert.ok("expiresAt" in ninety);
  assert.equal(ninety.expiresAt, new Date(NOW + 90 * 24 * 60 * 60 * 1000).toISOString());

  const never = resolveGrantExpiry("never", "continuous", NOW);
  assert.ok("expiresAt" in never);
  assert.equal(never.expiresAt, null);

  const nonsense = resolveGrantExpiry("whenever-i-say", "continuous", NOW);
  assert.ok("error" in nonsense);
  assert.match(nonsense.error, /how long this access should last/);
});

test("a date-shaped value that is not a real date is refused as a date problem", () => {
  // `2026-13-45` matches the shape but names no day.
  const result = resolveGrantExpiry("2026-13-45", "continuous", NOW);

  assert.ok("error" in result);
  assert.doesNotMatch(result.error, /how long this access should last/);
});
