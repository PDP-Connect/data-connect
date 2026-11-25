// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));

test("revoking a device has an explicit confirmation step", async () => {
  const [page, action] = await Promise.all([
    readFile(`${HERE}page.tsx`, "utf8"),
    readFile(`${HERE}actions.ts`, "utf8"),
  ]);
  // RAISE-RULES.md #5: every destructive action has a confirmation sentence naming the effect.
  assert.ok(page.includes("This stops this device from sending data to this server."));
  assert.ok(page.includes('name="confirm_revoke" type="hidden" value="yes"'));
  assert.ok(action.includes('formData.get("confirm_revoke") !== "yes"'));
});

test("device rows show the name, last seen time, and what they send", async () => {
  const page = await readFile(`${HERE}page.tsx`, "utf8");
  // RAISE-RULES.md #3: the device list names the device, when it was last seen, and what it sends.
  assert.ok(page.includes("Last seen"));
  assert.ok(page.includes("Sends ${device.source_instances.map(sourceLabel)"));
  assert.ok(page.includes('<summary className="cursor-pointer text-sm">Details</summary>'));
});

test("experimental metadata stays folded with the other technical facts", async () => {
  const page = await readFile(`${HERE}page.tsx`, "utf8");
  // RAISE-RULES.md #4: technical terms stay inside a folded Details section.
  const detailsStart = page.indexOf('<details className="mb-4 text-sm">');
  const metadata = page.indexOf("Surface: reference-experimental · Data sources:", detailsStart);
  assert.ok(detailsStart >= 0 && metadata > detailsStart);
  assert.ok(!page.includes('meta={<MetaPill label="data sources"'));
});
