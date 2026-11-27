// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
const read = (file: string) => readFile(new URL(file, import.meta.url), "utf8");
test("webhook pages render no secret material or technical folds", async () => {
  for (const file of ["page.tsx", "webhook-view.tsx", "[subscriptionId]/page.tsx"]) {
    const src = await read(file);
    assert.doesNotMatch(src, /\.secret\b|secret_hash|secret_text|<details/);
  }
});
test("webhook stopping uses the existing action with explicit confirmation", async () => {
  const [view, action] = await Promise.all([read("webhook-view.tsx"), read("disable-action.ts")]);
  assert.match(view, /action=\{disableSubscriptionAction\}/);
  assert.match(view, /name="confirm_disable"/);
  assert.match(view, /value="yes"\s+required/);
  assert.match(action, /requireDashboardAccess\(/);
  assert.match(action, /disableClientEventSubscription\(/);
  assert.match(action, /confirm_disable[\s\S]{0,200}!==\s*"yes"/);
  assert.match(action, /Buffer.byteLength\(raw, "utf8"\)/);
  assert.doesNotMatch(action, /raw.slice\(0,/);
});
test("list and detail preserve the shared action return routes", async () => {
  const [view, detail, action] = await Promise.all([read("webhook-view.tsx"), read("[subscriptionId]/page.tsx"), read("disable-action.ts")]);
  assert.match(detail, /<WebhookDetail/);
  assert.match(view, /returnTo = "detail"/);
  assert.match(view, /name="return_to" type="hidden" value=\{returnTo\}/);
  assert.match(action, /returnTo === "detail"/);
  assert.match(action, /returnTo === "list" \? \{ peek: subscriptionId \} : \{\}/);
});
test("webhooks retain distinct recovery instructions for stopped, failed, removed access and deleted", async () => {
  const src = await read("webhook-view.tsx");
  assert.match(src, /row.status === "disabled_revoked"/);
  assert.match(src, /row.status === "deleted"/);
  assert.match(src, /row.status === "disabled_failure"/);
  assert.match(src, /The app needs new access and a new webhook/);
  assert.match(src, /The app can turn them back on/);
});
test("webhook page names the app with the Apps naming functions and keeps status filtering", async () => {
  const [page, view] = await Promise.all([read("page.tsx"), read("webhook-view.tsx")]);
  assert.match(page, /appNamesByClientId/);
  assert.match(view, /pendingApprovalAppName/);
  assert.match(page, /name="status"/);
  assert.match(page, /An app can ask to be told when your data changes/);
});
