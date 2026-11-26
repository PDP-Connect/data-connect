// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { groupGrantAccessByApp } from "../grants/app-access.ts";
import { buildAppPractice } from "../grants/app-practice.ts";
import { groupAppHistory } from "./history-apps.ts";
import { appPractice } from "./practice.ts";
test("history merges repeat registrations using the same app identity as Apps", () => {
  const base = buildAppPractice("mixed").registrations[0]!;
  const apps = groupGrantAccessByApp([{...base,client_id:"practice-app-0"},{...base,client_id:"practice-app-1"}]);
  const history = appPractice("mixed",0); if (history.mode !== "days") throw Error("wrong mode");
  const rows = groupAppHistory(history.data,apps);
  assert.equal(rows.length,3);
  assert.equal(rows[0]?.reads,240);
  assert.equal(rows[0]?.across_sources,160);
  assert.equal(rows[0]?.sources[0]?.reads,20);
  assert.equal(rows[0]?.permission_refusals,3);
});
