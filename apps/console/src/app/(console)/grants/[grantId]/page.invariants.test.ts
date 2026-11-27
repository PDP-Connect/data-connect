// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
test("every record keeps its filtered subscription and package links on the technical page", () => {
  const source = read("./technical/page.tsx");
  assert.match(source, /app.grantIds.map/);
  assert.match(source, /event-subscriptions\?grant_id=\$\{encodeURIComponent\(id\)\}/);
  assert.match(source, /grants\/packages\/\$\{encodeURIComponent\(packageId\)\}/);
  assert.match(source, /Parent access package/);
});
test("the app page asks before removing all registrations or one source", () => {
  const source = read("./app-page.tsx");
  assert.match(source, /role="alertdialog"/); assert.match(source, /It keeps anything it already read/);
  assert.match(source, /removal.remove\("all"\)/); assert.match(source, /removal.remove\(key, source.source\)/);
  assert.match(source, /source.name \|\| appSourceName\(source.source\)/);
});
test("the per-row Remove control on an app's page is 44px tall on a coarse pointer", () => {
  const source = read("./app-page.tsx");
  const at = source.indexOf("Remove {name}");
  assert.ok(at > 0);
  const button = source.slice(source.lastIndexOf("<Button", at), at);
  assert.match(button, /pointer-coarse:min-h-11/);
});
// Round 8 B2: a source the owner just removed leaves "What it can read" at once; the rule is deriveAppReadingView (app-access.test.ts).
test("the app page lists the rows deriveAppReadingView returns, not its own filter", () => {
  const source = read("./app-page.tsx");
  assert.match(source, /deriveAppReadingView\(app, removal\.removed\)/);
  assert.match(source, /visibleRows\.map\(/);
});
