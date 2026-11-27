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
const PAGE_FILE = `${HERE}technical-page.tsx`;

test("all run source links share the encoded resolved connection route", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.ok(src.includes("const connectionId = resolveRunConnectionId(runStatus, events);"));
  assert.ok(src.includes('const sourceHref = connectionId ? `/sources/${encodeURIComponent(connectionId)}` : null;'));
  // DIRECTION.md, “What must stay true” #4: keep the source path but show one source breadcrumb.
  assert.equal((src.match(/href: sourceHref/g) ?? []).length, 1);
  assert.ok(src.includes("{ href: sourceHref, label: connectorName }"));
  assert.equal((src.match(/\x2fsources\x2f\$\{/g) ?? []).length, 1);
  assert.ok(!src.includes("encodeURIComponent(connectorId)"));
});

test("the header no longer duplicates the source breadcrumb in its description", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  const headerStart = src.indexOf("<PageHeader");
  const headerEnd = src.indexOf("<CurrentAssistanceSection", headerStart);
  const header = src.slice(headerStart, headerEnd);
  assert.match(header, /breadcrumbs=\{\[/);
  assert.match(header, /description=\{/);
  assert.doesNotMatch(header, /href=\{sourceHref\}|connectorLabel/);
});

test("breadcrumbs include a source only when its connection route is known", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  // DIRECTION.md, “What must stay true” #4: the source breadcrumb remains conditional and singular.
  assert.match(src, /breadcrumbs=\{\[[\s\S]*?\.\.\.\(sourceHref \? \[\{ href: sourceHref, label: connectorName \}\] : \[\]\)/);
  assert.match(src, /label: "Sync history"/);
  assert.match(src, /label: `\$\{connectorName\} sync`/);
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
