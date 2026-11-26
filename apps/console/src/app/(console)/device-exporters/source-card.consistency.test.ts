// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
test("collector source links use durable connection identity, never device binding identity", async () => {
  const src = await readFile(new URL("collector-list.tsx", import.meta.url), "utf8");
  assert.match(src, /\/sources\/\$\{encodeURIComponent\(source\.connector_instance_id\)\}/);
  assert.doesNotMatch(src, /\/sources\/\$\{encodeURIComponent\(source\.source_instance_id\)\}/);
  assert.match(src, /Data source not linked yet/);
  assert.doesNotMatch(src, /<code/);
});
