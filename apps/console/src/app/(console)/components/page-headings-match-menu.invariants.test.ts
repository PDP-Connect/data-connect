// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Every page a menu item opens carries the menu item's label as its main
 * heading, so the person always sees the word they clicked. The table maps
 * each menu address to the file that holds that page's heading. Home and
 * Data sources are rebuilt separately and are skipped here.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { NAV_GROUPS, type NavItem } from "@pdpp/brand-react";

const CONSOLE = fileURLToPath(new URL("..", import.meta.url));
const OPERATOR_UI = fileURLToPath(new URL("../../../../../../reference-implementation/vendor/operator-ui/src/", import.meta.url));

const SKIPPED = new Set(["/", "/sources"]);

const HEADING_FILE: Record<string, string> = {
  "/audit": `${CONSOLE}audit/page.tsx`,
  "/connect": `${CONSOLE}connect/page.tsx`,
  "/deployment": `${CONSOLE}deployment/page.tsx`,
  "/device-exporters": `${CONSOLE}device-exporters/page.tsx`,
  "/event-subscriptions": `${CONSOLE}event-subscriptions/page.tsx`,
  "/explore": `${CONSOLE}explore/explore-canvas.tsx`,
  "/grants": `${CONSOLE}grants/page.tsx`,
  "/notifications": `${CONSOLE}notifications/page.tsx`,
  "/schedules": `${OPERATOR_UI}components/views/schedules-view.tsx`,
  "/settings": `${CONSOLE}settings/page.tsx`,
  "/syncs": `${CONSOLE}syncs/syncs-view.tsx`,
};

function menuItems(items: NavItem[]): NavItem[] {
  return items.flatMap((item) => [item, ...menuItems(item.children ?? [])]);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A heading set as a `title` prop, a `title:` config key, or an `<h1>` text. */
function headingPattern(label: string): RegExp {
  const word = escapeRegExp(label);
  return new RegExp(`title="${word}"|title: "${word}"|<h1[^>]*>\\s*${word}\\s*</h1>`);
}

const DESTINATIONS = NAV_GROUPS.flatMap((group) => menuItems(group.items)).filter((item) => !SKIPPED.has(item.href));

test("every menu destination has a heading file in the table", () => {
  const missing = DESTINATIONS.filter((item) => !(item.href in HEADING_FILE)).map((item) => item.href);
  assert.deepEqual(missing, []);
});

for (const item of DESTINATIONS) {
  test(`${item.href} heading reads "${item.label}"`, async () => {
    const file = HEADING_FILE[item.href];
    assert.ok(file, `no heading file listed for ${item.href}`);
    const src = await readFile(file, "utf8");
    assert.match(src, headingPattern(item.label));
  });
}
