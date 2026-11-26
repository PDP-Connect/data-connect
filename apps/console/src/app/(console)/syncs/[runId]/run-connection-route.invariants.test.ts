// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Source wiring guard. Connection ids identify source routes; connector ids
 * only label integrations. Behavioral resolver coverage lives alongside the
 * pure helper in run-detail-labels.test.ts.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PAGE_FILE = `${HERE}page.tsx`;

test("all run source links share the encoded resolved connection route", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.ok(src.includes("const connectionId = resolveRunConnectionId(runStatus, events);"));
  assert.ok(src.includes('const sourceHref = connectionId ? `/sources/${encodeURIComponent(connectionId)}` : null;'));
  assert.equal((src.match(/href=\{sourceHref\}/g) ?? []).length, 1);
  assert.ok(src.includes("{ href: sourceHref, label: connectorName }"));
  assert.equal((src.match(/\x2fsources\x2f\$\{/g) ?? []).length, 1);
  assert.ok(!src.includes("encodeURIComponent(connectorId)"));
});

test("description label stays visible without a source route", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, /sourceHref \? \([\s\S]*?<Link[^>]*href=\{sourceHref\}>\s*\{connectorLabel\}\s*<\/Link>\s*\) : \(\s*<span[^>]*>\{connectorLabel\}<\/span>/);
});

test("breadcrumbs include a source only when its connection route is known", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, /breadcrumbs=\{\s*sourceHref\s*\? \[/);
  assert.match(src, /: \[\{ href: dashboardRoutes\.section\.runs, label: "Syncs" \}, \{ label: "Sync" \}\]/);
});

// Collection Profile 0.2.0, Section 5.11: the run page MUST NOT present a
// recovery hint as an instruction without runtime evidence, and MUST NOT hide
// the connector's own error text.
test("run detail gives no reconnect instruction inferred from the connector's error", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.doesNotMatch(src, /refresh_credentials/);
  assert.doesNotMatch(src, /Reconnect this source/);
});

test("run detail always shows the connector's error text in the failure summary", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, /\["connector", runStatus\.failure\.connector_error_message\]/);
  assert.match(src, /failure\.data\.connector_error_message/);
  assert.match(src, /\["connector", connectorMessage\]/);
});
