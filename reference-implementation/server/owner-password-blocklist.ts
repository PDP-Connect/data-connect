// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";

/**
 * NIST SP 800-63B-4 section 3.1.1.2 requires a verifier to compare a new
 * password against a list of commonly used, expected or compromised values.
 * This is the one hard reject besides length: there are no composition rules.
 *
 * `data/common-passwords.txt` holds the 10,000 most common passwords from the
 * public ZxcvbnData list (zxcvbn, MIT), lower-cased, one per line. Most of
 * them are shorter than the 15-character floor, so on their own they would
 * almost never match. A password is blocked when, after lower-casing, it is:
 *   - a listed entry,
 *   - a listed entry repeated (`passwordpassword`), or
 *   - a listed entry followed only by digits (`password1234567890`).
 * Those are the ways a common password most often reaches 15 characters.
 *
 * This applies when a password is set or changed. It never runs against a
 * stored password: an existing owner keeps a shorter or listed password until
 * they choose to change it.
 */
const COMMON_PASSWORDS: ReadonlySet<string> = new Set(
  readFileSync(new URL("./data/common-passwords.txt", import.meta.url), "utf8")
    .split("\n")
    .filter(line => line.length > 0)
);

export const OWNER_PASSWORD_TOO_COMMON_MESSAGE = "That password is too common. Choose a longer or less predictable one.";

export function isBlockedOwnerPassword(password: string): boolean {
  // Padding with whitespace must not turn a listed password into an unlisted one.
  const candidate = password.normalize("NFKC").trim().toLowerCase();
  if (COMMON_PASSWORDS.has(candidate)) return true;
  const withoutDigitSuffix = candidate.replace(/\d+$/u, "");
  if (withoutDigitSuffix !== candidate && COMMON_PASSWORDS.has(withoutDigitSuffix)) return true;
  // The shortest repeating unit decides: `abcabcabc` is `abc` three times.
  for (let unit = 1; unit <= candidate.length / 2; unit += 1) {
    if (candidate.length % unit === 0 && COMMON_PASSWORDS.has(candidate.slice(0, unit))) {
      if (candidate.slice(0, unit).repeat(candidate.length / unit) === candidate) return true;
    }
  }
  return false;
}
