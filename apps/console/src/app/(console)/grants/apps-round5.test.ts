// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const read = (rel: string) => readFile(new URL(rel, import.meta.url), "utf8");

test("the Apps page shows one Connect an app button when the header already has one", async () => {
  const groups = await read("./apps-groups.tsx");
  assert.doesNotMatch(groups, /Connect an app/);
});

test("the app page puts the warning before Remove access, and says 'not read yet' once", async () => {
  const page = await read("./[grantId]/app-page.tsx");
  assert.ok(page.indexOf("could not confirm who runs this app") < page.indexOf("Remove access\n"));
  assert.match(page, /source\.neverRead && app\.lastRead/);
  assert.match(page, /Remove \{name\}/);
});
