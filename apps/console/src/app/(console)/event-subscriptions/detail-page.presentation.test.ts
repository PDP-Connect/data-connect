// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
test("webhook detail and list use one plain delivery and confirmation component", async () => {
  const detail = await readFile(new URL("[subscriptionId]/page.tsx", import.meta.url), "utf8");
  const view = await readFile(new URL("webhook-view.tsx", import.meta.url), "utf8");
  assert.match(detail, /<WebhookDetail/);
  assert.match(view, /row.recent_attempts.map/);
  assert.match(view, /name="confirm_disable"/);
  assert.doesNotMatch(view, /<details/);
  assert.match(view, /<SupportCopy/);
});
