// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { settingsTrail } from "./settings-trail.ts";

const APP = fileURLToPath(new URL("..", import.meta.url));
const SUB_PAGES = [
  "settings/sign-in/page.tsx",
  "settings/remote-access/page.tsx",
  "settings/technical/page.tsx",
  "settings/packages/page.tsx",
  "deployment/page.tsx",
  "deployment/tokens/page.tsx",
  "deployment/provider-apps/page.tsx",
  "notifications/page.tsx",
  "privacy/page.tsx",
  "device-exporters/page.tsx",
  "event-subscriptions/page.tsx",
];

test("the trail is Settings, then the page", () => {
  assert.deepEqual(settingsTrail("Webhooks"), [{ href: "/settings", label: "Settings" }, { label: "Webhooks" }]);
});

test("every Settings sub-page has the same way back, and no page has a second one", async () => {
  for (const rel of SUB_PAGES) {
    const source = await readFile(`${APP}${rel}`, "utf8");
    assert.match(source, /settingsTrail\(/, `${rel} needs the Settings trail`);
    assert.doesNotMatch(source, /Back to Settings/, `${rel} keeps one way back, the trail`);
  }
});

test("the release link on Settings is at least 24 px tall, with its row's room around it", async () => {
  const source = await readFile(`${APP}settings/page.tsx`, "utf8");
  assert.match(source, /className="inline-flex min-h-11 items-center underline">See the latest version/);
});
