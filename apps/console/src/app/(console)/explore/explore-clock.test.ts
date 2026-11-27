// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

// React error #418 on /explore: relative times ("5 minutes ago") were worded from
// Date.now() once on the server and again in the browser.
test("every Explore row words its time from the one clock the page sends down", () => {
  const canvas = read("./explore-canvas.tsx");
  assert.doesNotMatch(canvas, /exploreRecordRow\(entry\)/);
  assert.match(canvas, /exploreRecordRow\(entry, useExploreNow\(\)\)/);
  const page = read("./page.tsx");
  assert.match(page, /<ExploreClock now=\{Date\.now\(\)\}>/);
});
