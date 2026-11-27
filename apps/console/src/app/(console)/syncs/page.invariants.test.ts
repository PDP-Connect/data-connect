// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
const source = (file: string) => readFileSync(new URL(file,import.meta.url),"utf8");
test("legacy peek links redirect before history reads", () => {
  const page = source("./page.tsx");
  assert.ok(page.indexOf("if (params.peek)") < page.indexOf("await loadSyncHistory(params)"));
  assert.ok(page.includes("encodeURIComponent(params.peek)"));
  assert.ok(!page.includes("getRunTimeline"));
});
test("daily history uses durable totals and a separate bounded live read", () => {
  const loader = source("./load-sync-history.ts");
  assert.ok(loader.includes("listSyncHistory({"));
  assert.ok(loader.includes('listRuns({ status: "in_progress", limit: 100 })'));
  assert.ok(loader.includes('withCurrentSourceState(history.data,sources)'));
  assert.ok(loader.includes('syncDayProblem(row)'));
  assert.ok(loader.includes("connection_id: params.connection_id"));
});
test("history keeps technical facts off its day rows and uses connection identities", () => {
  const view = source("./daily-syncs-view.tsx");
  assert.ok(!view.includes("<details"));
  assert.ok(view.includes('name="connection_id"'));
  assert.ok(view.includes("Only problems"));
  assert.ok(!view.includes("Any result"));
  assert.ok(view.includes('"/syncs/day"'));
});
test("source choices follow server identity pages and use account names", () => {
  const loader = source("../history/load-sources.ts");
  assert.ok(loader.includes('profile: "identity_inventory"'));
  assert.ok(loader.includes("page.next_cursor"));
  assert.ok(loader.includes("connectionDisplayName"));
});
