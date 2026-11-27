// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");

// Round 11 (F15): every group on Settings has a heading, and no row stands alone as its own group.
test("every Settings group has a heading", () => {
  const sections = page.match(/<Section[^>]*>/g) ?? [];
  assert.ok(sections.length >= 4);
  for (const tag of sections) assert.match(tag, /title=/, tag);
});

test("Notifications sits in the first group, not alone", () => {
  assert.match(page, /<Section title="Access and alerts">[\s\S]*<NotificationsRow[\s\S]*<\/Section>\s*<Section title="Updates">/);
});

test("a row's status goes under its label on a phone", () => {
  const row = readFileSync(new URL("./settings-row.tsx", import.meta.url), "utf8");
  assert.match(row, /block text-\[13px\] sm:inline/);
});
