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
  assert.ok(src.includes("const sourceHref = connectionId ? `/sources/${encodeURIComponent(connectionId)}` : null;"));
  assert.equal((src.match(/href=\{sourceHref\}/g) ?? []).length, 2);
  assert.ok(src.includes("{ href: sourceHref, label: connectorName }"));
  assert.equal((src.match(/\x2fsources\x2f\$\{/g) ?? []).length, 1);
  assert.ok(!src.includes("encodeURIComponent(connectorId)"));
});

test("description and reconnect labels stay visible without a source route", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(
    src,
    /sourceHref \? \([\s\S]*?<Link[^>]*href=\{sourceHref\}>\s*\{connectorName\}\s*<\/Link>\s*\) : \(\s*<span>\{connectorName\}<\/span>/
  );
  assert.match(
    src,
    /sourceHref \? \([\s\S]*?<Link[^>]*href=\{sourceHref\}>\s*\{connectorLabel\}\s*<\/Link>\s*\) : \(\s*<span[^>]*>\{connectorLabel\}<\/span>/
  );
});

test("breadcrumbs include a source only when its connection route is known", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, /breadcrumbs=\{\s*sourceHref\s*\? \[/);
  assert.match(src, /: \[\{ href: dashboardRoutes\.section\.runs, label: "Syncs" \}, \{ label: "Sync" \}\]/);
});

test("auth failure diagnosis hides the connector code and links to reconnect", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, /recovery_hint\?\.action === "refresh_credentials"/);
  assert.match(src, /Reconnect this source to sync again/);
  assert.match(
    src,
    /if \(runStatus\.failure\.recovery_hint\?\.action === "refresh_credentials"\) \{\s*return runStatus\.failure\.message \? \[\["message", runStatus\.failure\.message\]\]/
  );
});
