// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PAGE_FILE = `${HERE}page.tsx`;

const WEB_PUSH_SETTINGS_RE = /<WebPushSettings config=\{state\.config\} subscriptions=\{state\.subscriptions\} \/>/;
const WEB_PUSH_CONFIG_RE = /getWebPushConfig\(\)/;
const WEB_PUSH_SUBSCRIPTIONS_RE = /listWebPushSubscriptions\(\)/;
const DEVICE_SCOPED_COPY_RE = /A message when a sync needs you\./;
const OLD_PAGE_COPY_RE = /Enable owner-action alerts|What DataConnect sends/;
const NORMAL_PAGE_DETAILS_RE = /<details className="border-t/;
const DETAILS_SUMMARY_RE = /<summary[^>]*>Details<\/summary>/g;
const OWNER_ALERT_COPY_RE = /Only owner-action alerts/;
const HEADLINE_COPY_RE = /Headline only/;
const PER_DEVICE_COPY_RE = /Per device/;

test("notifications page renders the Web Push setup surface from live owner state", async () => {
  const src = await readFile(PAGE_FILE, "utf8");

  assert.match(src, WEB_PUSH_CONFIG_RE);
  assert.match(src, WEB_PUSH_SUBSCRIPTIONS_RE);
  assert.match(src, WEB_PUSH_SETTINGS_RE);
  // DIRECTION.md, Notifications: the page says in one short sentence what the person gets.
  assert.match(src, DEVICE_SCOPED_COPY_RE);
  assert.doesNotMatch(src, OLD_PAGE_COPY_RE);
});

test("notifications has one Details fold with the page information inside it", async () => {
  const page = await readFile(PAGE_FILE, "utf8");
  const settings = await readFile(new URL("../components/web-push-settings.tsx", import.meta.url), "utf8");

  // history-repair brief P2: combine the page and settings disclosures.
  assert.doesNotMatch(page.slice(page.indexOf("return (", page.indexOf("if (unreachable"))), NORMAL_PAGE_DETAILS_RE);
  assert.equal(settings.match(DETAILS_SUMMARY_RE)?.length, 1);
  assert.match(settings, OWNER_ALERT_COPY_RE);
  assert.match(settings, HEADLINE_COPY_RE);
  assert.match(settings, PER_DEVICE_COPY_RE);
});
