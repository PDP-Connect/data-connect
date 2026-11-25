// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));

test("single-access removal uses the existing server revoke route with owner access and confirmation", async () => {
  const src = await readFile(`${HERE}revoke-action.ts`, "utf8");
  // RAISE-RULES 5: destructive actions require server-checked confirmation.
  assert.match(src, /^"use server"/);
  assert.match(src, /requireDashboardAccess\(path\)/);
  assert.match(src, /confirm_revoke/);
  assert.match(src, /getOwnerToken\(\)/);
  assert.match(src, /Authorization: `Bearer \$\{token\}`/);
  assert.match(src, /\/grants\/\$\{encodeURIComponent\(grantId\)\}\/revoke/);
  assert.match(src, /method: "POST"/);
});
