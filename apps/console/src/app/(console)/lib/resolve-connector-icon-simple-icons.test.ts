// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { resolveConnectorIconFromSimpleIcons } from "./resolve-connector-icon-simple-icons.ts";

test("resolves a known brand by connector key (exact slug match)", async () => {
  const icon = await resolveConnectorIconFromSimpleIcons("github");
  assert.ok(icon);
  assert.equal(icon.kind, "inline_svg");
  assert.match(icon.svg ?? "", /^<svg[^>]*role="img"/);
  assert.match(icon.svg ?? "", /<title>GitHub<\/title>/);
});

test("resolves a hyphenated connector key to its collapsed slug", async () => {
  const icon = await resolveConnectorIconFromSimpleIcons("claude-code");
  assert.ok(icon);
  assert.match(icon.svg ?? "", /<title>Claude Code<\/title>/);
});

test("returns null for a connector key with no matching slug", async () => {
  assert.equal(await resolveConnectorIconFromSimpleIcons("amazon"), null);
  assert.equal(await resolveConnectorIconFromSimpleIcons("totally-made-up-connector-xyz"), null);
});

test("returns null for an empty or blank connector key", async () => {
  assert.equal(await resolveConnectorIconFromSimpleIcons(""), null);
  assert.equal(await resolveConnectorIconFromSimpleIcons("   "), null);
});
