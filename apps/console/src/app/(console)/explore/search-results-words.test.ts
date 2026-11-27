// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { exploreRecordRow, exploreRecordTitle } from "./explore-presentation.ts";

const canvas = () => readFile(fileURLToPath(new URL("./explore-canvas.tsx", import.meta.url)), "utf8");

test("a search hit with no preview is titled by the matched record text, not its kind", () => {
  const hit = { connectionDisplayName: "Steam", displayAt: "2026-11-27T10:00:00Z", snippet: "Portal 2", stream: "owned_games" };
  assert.equal(exploreRecordTitle(hit), "Portal 2");
  assert.equal(exploreRecordRow(hit).title, "Portal 2");
  assert.equal(exploreRecordRow(hit).kind, "Owned games");
  assert.equal(exploreRecordTitle({ stream: "owned_games" }), "Owned games");
});

test("the search page shows the query once in its words, with one quote style", async () => {
  const source = await canvas();
  assert.doesNotMatch(source, /See all '\{query\}'/);
  assert.doesNotMatch(source, /Search results for &lsquo;\{query\}&rsquo;/);
});
