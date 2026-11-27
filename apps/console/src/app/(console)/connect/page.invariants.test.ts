// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { assistantInstructions } from "./assistant-instructions.ts";
const read = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8");
test("menu names have one dated source and use the researched current menus", () => {
  assert.equal(assistantInstructions.length, 4);
  assert.match(assistantInstructions[0].steps.join(" "), /Plugins.*Add custom MCP server/);
  assert.match(assistantInstructions[1].steps.join(" "), /Customize.*Connectors.*Add custom connector/);
  for (const row of assistantInstructions) assert.match(row.checkedAt, /^2026-11-/);
});
test("Connect uses the complete app list and warns before copying a private address", () => {
  assert.match(read("./load-connect.ts"), /loadApps/);
  const source = read("./connect-page.tsx");
  assert.ok(source.indexOf("needsRemoteAccess(origin)") < source.indexOf('title="1. Copy'));
  assert.doesNotMatch(source, /<details|AppAccessList/);
  assert.match(source, /No app is connected yet\./);
});
