// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { readLocalCollectorProfile } from "../server/local-collector-profiles.ts";

test("a pinned local-collector connector resolves to its pinned Collection Profile", () => {
  const profile = readLocalCollectorProfile("claude-code");
  assert.ok(profile);
  assert.equal(profile.connector_key, "claude-code");
  assert.ok(Array.isArray(profile.streams) && profile.streams.length > 0);
});

test("a connector the local collector does not install has no local-collector profile", () => {
  // google-messages has a local-collector definition but no published
  // Collection Profile, so the collector cannot run it.
  assert.equal(readLocalCollectorProfile("google-messages"), null);
  assert.equal(readLocalCollectorProfile("gmail"), null);
});

test("a key that is not a connector key never reaches the filesystem", () => {
  assert.equal(readLocalCollectorProfile("../local-collector-profiles/claude-code"), null);
  assert.equal(readLocalCollectorProfile("claude_code"), null);
  assert.equal(readLocalCollectorProfile(""), null);
});
