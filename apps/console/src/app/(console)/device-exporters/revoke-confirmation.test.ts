// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
test("collector removal confirms its effect and preserves the server confirmation", async () => {
  const [list, action] = await Promise.all([readFile(new URL("collector-list.tsx", import.meta.url), "utf8"), readFile(new URL("actions.ts", import.meta.url), "utf8")]);
  assert.match(list, /Your saved records stay/);
  assert.match(list, /role="alertdialog"/);
  assert.match(list, /name="confirm_revoke"\s+type="hidden"\s+value="yes"/);
  assert.match(action, /formData.get\("confirm_revoke"\) !== "yes"/);
});
test("collector rows have plain time and data source links without folds", async () => {
  const list = await readFile(new URL("collector-list.tsx", import.meta.url), "utf8");
  assert.match(list, /Last heard from/);
  assert.match(list, /source\.connector_instance_id/);
  assert.doesNotMatch(list, /<details/);
});
