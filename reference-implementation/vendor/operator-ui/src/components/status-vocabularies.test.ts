// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import { GRANT_LIFECYCLE_VOCABULARY } from "./status-vocabularies.ts";

// PDPP honesty discipline: an unknown grant status must read neutral and
// labelled "unknown" — never the `active`/success tone. Painting an
// indeterminate grant as definitively live is the violation this pins shut.
test("grant lifecycle maps unknown to a neutral 'unknown' badge, never active/success", () => {
  const entry = GRANT_LIFECYCLE_VOCABULARY.unknown;
  assert.ok(entry, "expected an explicit `unknown` entry");
  assert.equal(entry.tone, "neutral");
  assert.equal(entry.label, "unknown");
  // Guard against regressing to the success/active tone.
  assert.notEqual(entry.tone, "success");
  assert.notEqual(entry.label, "active");
});

test("active stays success — the neutral unknown fix does not bleed into known live states", () => {
  const { active } = GRANT_LIFECYCLE_VOCABULARY;
  assert.ok(active, "expected an `active` entry");
  assert.equal(active.tone, "success");
});

// `expired` is a real, derived lifecycle state (spec-core.md:533 tracks grant
// lifecycle as active / expired / revoked). Before it was mapped, an expired
// grant fell through to the badge's neutral fallback and read like an
// indeterminate state rather than the definite terminal one it is.
test("expired is an explicit, definite terminal state — not the neutral fallback", () => {
  const entry = GRANT_LIFECYCLE_VOCABULARY.expired;
  assert.ok(entry, "expected an explicit `expired` entry");
  assert.equal(entry.label, "expired");
  // Definite, so never neutral (which this vocabulary reserves for unknown).
  assert.notEqual(entry.tone, "neutral");
  // A lapsed deadline is not a live grant.
  assert.notEqual(entry.tone, "success");
});
