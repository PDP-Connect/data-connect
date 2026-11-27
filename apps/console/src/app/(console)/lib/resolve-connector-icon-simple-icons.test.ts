// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveConnectorIconFromSimpleIcons } from "./resolve-connector-icon-simple-icons.ts";

const FIGMA_TITLE = /<title>Figma<\/title>/;

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

// Next's standalone tracer copies only the traced files (outputFileTracingIncludes
// names data/simple-icons.json and icons/*.svg), never the package's own
// package.json. The lookup must not require a file the build does not ship.
test("resolves from a standalone-style layout that ships no package.json", async () => {
  const source = join(process.cwd(), "..", "..", "node_modules", "simple-icons");
  const root = mkdtempSync(join(tmpdir(), "standalone-layout-"));
  const previous = process.cwd();
  try {
    const pkg = join(root, "node_modules", "simple-icons");
    mkdirSync(join(pkg, "data"), { recursive: true });
    mkdirSync(join(pkg, "icons"), { recursive: true });
    cpSync(join(source, "data", "simple-icons.json"), join(pkg, "data", "simple-icons.json"));
    cpSync(join(source, "icons", "figma.svg"), join(pkg, "icons", "figma.svg"));
    mkdirSync(join(root, "apps", "console"), { recursive: true });
    process.chdir(join(root, "apps", "console"));
    const icon = await resolveConnectorIconFromSimpleIcons("figma");
    assert.ok(icon, "a traced standalone package must still resolve");
    assert.match(icon.svg ?? "", FIGMA_TITLE);
  } finally {
    process.chdir(previous);
    rmSync(root, { force: true, recursive: true });
  }
});
