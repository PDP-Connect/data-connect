// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("schedules keeps the bounded summary read and renders one row per data source", async () => {
  const page = await readFile(new URL("page.tsx", import.meta.url), "utf8");
  assert.match(page, /listConnectorSummaries\(opts\)/);
  assert.match(page, /summaries\.map\(\(summary\) => \(/);
  assert.match(page, /<ScheduleRow/);
  assert.match(page, /<PageHeading \/>/);
});

test("schedule reads keep their failure recovery and hide technical details", async () => {
  const page = await readFile(new URL("page.tsx", import.meta.url), "utf8");
  assert.match(page, /This could not be loaded\./);
  assert.match(page, /Try again/);
  assert.doesNotMatch(page, /<details/);
  assert.match(page, /presentation="plain"/);
});

test("the old schedules address still redirects to the canonical page", async () => {
  const page = await readFile(new URL("../sources/schedules/page.tsx", import.meta.url), "utf8");
  assert.match(page, /redirect\("\/schedules"\)/);
});
