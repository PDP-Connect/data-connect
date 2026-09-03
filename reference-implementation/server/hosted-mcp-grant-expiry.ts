// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Owner-selectable grant expiry for the hosted MCP picker.
 *
 * `expires_at` is set by the authorization server (Grant fields), and nothing
 * in the spec requires it to be null or forbids offering the owner a say. The
 * picker hardcoded no expiry and described it in a footnote — "This
 * authorization has no scheduled end date." — so the only durable outcome
 * available was indefinite access, and the sentence read as a protocol
 * constraint rather than the default it actually was.
 *
 * This makes it a choice with a bounded default. The strongest precedent in
 * the corpus is Google's: it states a concrete resolved date ("this access
 * will expire on August 4, 2026") and makes indefinite access an explicit
 * opt-in rather than the default. That polarity is the right one — an owner
 * who wants to grant forever should have to say so, and an owner who does
 * nothing should end up with an access window that closes on its own.
 *
 * **Expiry is not the access mode.** `spec-core.md:889` lists grant validity,
 * data temporal scope, and access pattern as three orthogonal concepts that
 * MUST NOT be conflated. Expiry answers "how long does this authorization
 * stay valid"; `access_mode` answers "may the client read repeatedly or
 * once"; `time_range` answers "which records". This module owns only the
 * first, and its copy never restates the other two — the previous footnote's
 * failure was exactly that it did, contradicting the radio above it.
 *
 * For `single_use` the control is suppressed rather than shown with a
 * contradictory note: a single-use grant is consumed at first token issuance
 * (`spec-core.md:920`), so a scheduled end date is not the thing bounding it.
 */

/** An expiry option the picker offers. `days: null` means no scheduled end. */
export interface GrantExpiryOption {
  readonly days: number | null;
  /** Stable form value; what the POST carries. */
  readonly id: string;
  /** What the owner reads on the control. */
  readonly label: string;
}

/**
 * The offered windows. 90 days is the default because it is long enough that
 * a working agent integration does not break in normal use, and short enough
 * that a forgotten grant closes by itself within a quarter.
 */
export const HOSTED_MCP_GRANT_EXPIRY_OPTIONS: readonly GrantExpiryOption[] = Object.freeze([
  Object.freeze({ days: 90, id: "90d", label: "90 days" }),
  Object.freeze({ days: 365, id: "1y", label: "1 year" }),
  Object.freeze({ days: null, id: "never", label: "No end date" }),
]);

export const HOSTED_MCP_DEFAULT_GRANT_EXPIRY_ID = "90d";

/**
 * The longest dated expiry an owner may pick, in days.
 *
 * The quick-fill options top out at a year; a bare date picker with no ceiling
 * would let a mis-typed year (2226 for 2026) become a two-century grant that
 * looks, on the confirmation, exactly like a correct one. Five years is well
 * past any plausible deliberate choice while still closing that gap — and an
 * owner who genuinely wants unbounded access has "No end date", which says so
 * out loud instead of hiding behind a far-future date.
 */
const MAX_DATED_EXPIRY_DAYS = 5 * 365;

const DAY_MS = 24 * 60 * 60 * 1000;

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Resolve a bare `YYYY-MM-DD` the owner typed into a date picker.
 *
 * Returns null when the value is not a date at all, so the caller can fall
 * through to the option-id vocabulary; returns `{ error }` when it IS a date
 * but not one this server will grant, so a rejected date never reads as an
 * unrecognized keyword.
 *
 * Resolved to the END of the chosen day (UTC), because an owner who picks
 * "December 2" means access lasts through December 2, not until its first
 * instant.
 */
function resolveDatedExpiry(raw: string, nowMs: number): { error: string } | { expiresAt: string } | null {
  if (!ISO_DATE_RE.test(raw)) {
    return null;
  }
  const parsed = Date.parse(`${raw}T23:59:59.999Z`);
  if (Number.isNaN(parsed)) {
    return { error: "That is not a date this server can use. Pick another." };
  }
  if (parsed <= nowMs) {
    return { error: "Choose an end date in the future." };
  }
  if (parsed - nowMs > MAX_DATED_EXPIRY_DAYS * DAY_MS) {
    return { error: "Choose an end date within five years, or choose no end date." };
  }
  return { expiresAt: new Date(parsed).toISOString() };
}

/** Look up an offered option by its form value. */
export function findGrantExpiryOption(id: unknown): GrantExpiryOption | null {
  const candidate = typeof id === "string" ? id.trim() : "";
  if (!candidate) {
    return null;
  }
  return HOSTED_MCP_GRANT_EXPIRY_OPTIONS.find((option) => option.id === candidate) ?? null;
}

/**
 * Resolve a submitted expiry choice into the instant the grant carries.
 *
 * Accepts either a quick-fill option id (`90d`, `1y`, `never`) or a bare
 * `YYYY-MM-DD` the owner picked, bounded to five years. Absent falls back to
 * the default.
 *
 * Returns `{ expiresAt: null }` for "no end date", which callers must render
 * as an ABSENT `expires_at` rather than an explicit null — `ResolvedGrant`
 * treats absence as "no expiry" and rejects `null` as a value.
 *
 * An unrecognized value is an error, not a silent fallback to the default.
 * Falling back would mean an owner who submitted something the server did not
 * understand gets an expiry they never chose, and the page would show no sign
 * of it. For a control whose entire purpose is bounding how long access
 * lasts, guessing is the wrong failure mode.
 */
export function resolveGrantExpiry(
  submitted: unknown,
  accessMode: string,
  nowMs: number = Date.now()
): { error: string } | { expiresAt: string | null } {
  // A single_use grant is consumed at first token issuance (spec-core.md:920),
  // so the picker does not offer this control for it and ignores any value.
  if (accessMode === "single_use") {
    return { expiresAt: null };
  }
  const raw = typeof submitted === "string" ? submitted.trim() : "";
  // A bare date the owner picked, before the fixed vocabulary. The quick-fill
  // options are a shortcut for common windows, not the only windows allowed:
  // the consent screen offers a real date picker, and an owner who names a
  // Tuesday in March should get that Tuesday rather than a validation error.
  const dated = resolveDatedExpiry(raw, nowMs);
  if (dated) {
    return dated;
  }
  const option = findGrantExpiryOption(raw || HOSTED_MCP_DEFAULT_GRANT_EXPIRY_ID);
  if (!option) {
    return { error: "Choose how long this access should last." };
  }
  if (option.days === null) {
    return { expiresAt: null };
  }
  return { expiresAt: new Date(nowMs + option.days * DAY_MS).toISOString() };
}

/**
 * State the expiry as a consequence the owner can act on, never as a field
 * name. "Access ends 1 December 2026." beats "expires_at: 2026-12-01" for the
 * same reason spec-core.md:545 wants temporal scope rendered in words.
 *
 * Says nothing about the access mode or the data's date range; those are
 * different questions with their own controls (spec-core.md:889).
 */
export function describeGrantExpiry(expiresAt: string | null, formatDate: (iso: string) => string): string {
  if (!expiresAt) {
    return "No scheduled end date.";
  }
  return `Access ends ${formatDate(expiresAt)}.`;
}
