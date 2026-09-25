// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// The revoke promise must not outrun the product.
//
// Three owner-facing strings promised reversibility: the picker's "you can
// revoke any source you approve here later", and the two consent-result
// pages' "revoke this access any time" / "revoke any single source grant
// independently from the grants dashboard".
//
// Only the last granularity is a problem, and it is the one that matters
// most. `POST /grants/:grantId/revoke` exists in the reference server and the
// console proxies it, but no UI calls it: the only revoke control that ships
// is the all-or-nothing package cascade at `/grants/packages/:packageId`.
// The hosted UI has no grants dashboard at all.
//
// Reversibility is the promise that makes "yes" feel safe. Promising a
// granularity the owner cannot actually reach is worse than saying less, so
// these strings state only what the product delivers. This is a source-level
// guard (fast, no server boot) so a future edit cannot quietly restore the
// per-source claim while the UI to honor it still does not exist.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SERVER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "server");

const CONSENT_RESULT_PAGES = join(SERVER_DIR, "routes", "as-consent.ts");
const PICKER = join(SERVER_DIR, "routes", "as-consent-ui-helpers.ts");
const OWNER_FACING_SOURCES = [CONSENT_RESULT_PAGES, PICKER];

function ownerFacingStrings(path: string): string {
  // Strip comments so the prose EXPLAINING why the promise was removed does
  // not itself trip the guard.
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

test("no surface promises per-source revoke while no UI can perform it", () => {
  for (const path of OWNER_FACING_SOURCES) {
    const source = ownerFacingStrings(path);
    assert.equal(
      /revoke any (single )?source/i.test(source),
      false,
      `${path} must not promise per-source revoke: the route exists but no UI calls it`
    );
    assert.equal(
      /revoke .{0,40}independently/i.test(source),
      false,
      `${path} must not promise independent per-grant revocation`
    );
  }
});

test("the revoke promise that remains is the package-level one the product keeps", () => {
  const consent = ownerFacingStrings(CONSENT_RESULT_PAGES);
  const picker = ownerFacingStrings(PICKER);
  const promise = "You can revoke this access later from your grants page.";
  assert.ok(consent.includes(promise), "the consent result pages keep the deliverable promise");
  assert.ok(picker.includes(promise), "the picker keeps the same deliverable promise, worded identically");
});
