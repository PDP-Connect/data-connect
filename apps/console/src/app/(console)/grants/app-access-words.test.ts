// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { appPlaceLine } from "./app-access-words.ts";

test("the place line carries the not-verified mark the same way on the list and the page", () => {
  assert.equal(appPlaceLine({ name: "Scene Assistant", place: "this computer", verified: false }), "this computer · not verified");
  assert.equal(appPlaceLine({ name: "Scene Assistant", place: "no address given", verified: false }), "not verified");
  assert.equal(appPlaceLine({ name: "Scene Assistant", place: "claude.ai", verified: true }), "claude.ai");
});

test("the list says what the app's page says, not 'all your data sources'", async () => {
  const list = await readFile(new URL("./app-access-list.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(list, /all your data sources/);
  assert.match(list, /appAccessLines/);
  assert.match(list, /appPlaceLine/);
  const page = await readFile(new URL("./[grantId]/app-page.tsx", import.meta.url), "utf8");
  assert.match(page, /appPlaceLine/);
});

test("on an app's page the warning that explains Remove access comes before the button, and 'has not read anything yet' is said once", async () => {
  const page = await readFile(new URL("./[grantId]/app-page.tsx", import.meta.url), "utf8");
  assert.ok(page.indexOf("could not confirm who runs this app") < page.indexOf("Remove access\n"), "warning first");
  assert.equal((page.match(/Has not read anything yet\./g) ?? []).length, 0);
});
