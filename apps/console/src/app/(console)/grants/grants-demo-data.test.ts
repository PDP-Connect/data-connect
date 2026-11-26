// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { buildAppPractice } from "./app-practice.ts";
import {
  buildAppAccessDemoData,
  buildEmptyGrantsDemoData,
  buildGrantsDemoData,
  createAppAccessDemoDataSource,
} from "./grants-demo-data.ts";

test("web-address practice includes stored and derived names and an unknown dynamic client", async () => {
  const source = createAppAccessDemoDataSource("web-address");
  const registrations = (await source.listAppAccess()).data;
  assert.equal(registrations.length, 3);
  const { apps } = buildAppPractice("web-address");
  assert.deepEqual(apps.map((a) => [a.name, a.place, a.verified]).sort(), [
    ["An app that gave no name", "no address given", false],
    ["ChatGPT", "chatgpt.com", true],
    ["tools.example", "tools.example", true],
  ]);
  const [first] = registrations;
  assert.ok(first);
  assert.equal((await source.removeAppAccess({ client_ids: [first.client_id] })).ended_count, 1);
  assert.equal((await source.listAppAccess()).data[1]?.sources[0]?.in_force, true);
});

test("practice removal updates only the local complete app list and is repeatable", async () => {
  const source = createAppAccessDemoDataSource();
  const first = (await source.listAppAccess()).data[0];
  assert.ok(first);
  assert.equal((await source.removeAppAccess({ client_ids: [first.client_id] })).ended_count, 1);
  assert.equal((await source.listAppAccess()).data[0]?.sources[0]?.in_force, false);
  assert.equal((await source.removeAppAccess({ client_ids: [first.client_id] })).ended_count, 0);
});

test("practice apps supply complete access facts without a live request", () => {
  const list = buildAppAccessDemoData();
  assert.equal(list.has_more, false);
  assert.equal(list.data.length, 2);
  assert.equal(list.data[0]?.sources[0]?.in_force, true);
  assert.equal(list.data[1]?.sources[0]?.stopped_reason, "removed");
});

test("empty Apps demo has no rows or waiting requests while atlas keeps both", () => {
  const empty = buildEmptyGrantsDemoData();
  const atlas = buildGrantsDemoData();
  assert.equal(empty.grants.data.length, 0);
  assert.equal(empty.approvals.data.length, 0);
  assert.ok(atlas.grants.data.length > 0);
  assert.ok(atlas.approvals.data.length > 0);
});
