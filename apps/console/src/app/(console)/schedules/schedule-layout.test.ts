// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

test("Schedules and the Explore loading screen add no gutter of their own", () => {
  assert.doesNotMatch(read("page.tsx"), /<main[^>]*\bpx-/);
  assert.doesNotMatch(read("../explore/loading.tsx"), /\bpx-\d/);
});

test("Change and Pause say what they act on", () => {
  const src = read("schedule-row.tsx");
  assert.match(src, /aria-label=\{`Change how often/);
  assert.match(src, /aria-label=\{`\$\{enabled \? "Pause" : "Resume"\} syncing/);
});

test("the Schedules page words its count line with the shared summary function", () => {
  assert.match(read("page.tsx"), /scheduleSummaryLine\(/);
});
