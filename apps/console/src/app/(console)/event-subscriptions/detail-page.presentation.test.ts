// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const PAGE = fileURLToPath(new URL("./[subscriptionId]/page.tsx", import.meta.url));

test("webhook detail keeps delivery attempts as rows and confirms disabling", async () => {
  const src = await readFile(PAGE, "utf8");
  // DIRECTION.md §What the look is for: present information in rows with plain labels.
  assert.ok(src.includes('<ol className="pdpp-caption divide-y divide-border/70 border-border/70 border-y">'));
  assert.ok(src.includes("This stops messages to this address; the app can turn them back on."));
  assert.ok(src.includes('name="confirm_disable" required'));
  // RAISE-RULES.md #4: response details and event codes stay folded away from the plain delivery row.
  assert.ok(src.includes('attempt.ok ? "Delivered" : "Failed"'));
  const detailsStart = src.indexOf("<details>");
  const eventType = src.indexOf("attempt.event_type", detailsStart);
  assert.ok(detailsStart >= 0 && eventType > detailsStart);
});

test("webhook detail names the page in plain words", async () => {
  const src = await readFile(PAGE, "utf8");
  // DIRECTION.md §The frame and the menu: menu labels and page titles use the same words.
  assert.ok(src.includes('title="Webhooks"'));
});
