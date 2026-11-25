// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { mock } from "node:test";
import * as navigation from "next/navigation";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ALL_ENTRIES, installed, notInstalled } from "../../sources/add/add-flow-fixtures.ts";
import { bannedCopyProblems } from "../../sources/add/banned-copy.ts";
import { connectorLookupKey } from "../../lib/connector-install-presentation.ts";
import { buildPackageRows } from "./package-rows-model.ts";

Object.assign(globalThis, { React });
mock.module("server-only", { namedExports: {} });
mock.module("next/navigation", { namedExports: { ...navigation, useRouter: () => ({ refresh() {}, replace() {}, push() {} }) } });

const tableModule = import("./package-table.tsx");

const lifecycles: Record<string, ReturnType<typeof installed>> = {
  amazon: installed("amazon"),
  chase: { ...installed("chase"), catalog: { bindings: {}, connector_id: "chase", connector_key: "chase", digest: "sha256:bbbb", latest: true, version: "1.3.0" } as never },
  ynab: notInstalled("ynab"),
};
const rows = buildPackageRows({
  catalog: ALL_ENTRIES,
  existingConnectionCounts: { amazon: 1 },
  lifecycleFor: (entry) => lifecycles[connectorLookupKey(entry.connectorKey)] ?? { catalog: null, installed: null },
});

// Design "Data source packages": a plain table; Update when there is one, Uninstall when nothing uses it.
test("rows are the services with a package on this computer, A to Z", () => {
  assert.deepEqual(rows.map((row) => row.displayName), ["Amazon", "Chase"]);
});

test("Update shows only when a newer version exists; Uninstall only when no data source uses the package", () => {
  const amazon = rows.find((row) => row.connectorKey === "amazon");
  const chase = rows.find((row) => row.connectorKey === "chase");
  assert.equal(amazon?.updateTo, null);
  assert.equal(amazon?.canUninstall, false);
  assert.equal(chase?.updateTo, "1.3.0");
  assert.equal(chase?.canUninstall, true);
});

// Design banned list 2: package, version, update, uninstall (and version numbers) are allowed on this page only.
test("the packages table uses only the allowed words, no badges, and no fold", async () => {
  const { PackageTable } = await tableModule;
  const html = renderToStaticMarkup(createElement(PackageTable, { rows }));
  assert.deepEqual(bannedCopyProblems(html, { allowWords: ["package", "version number"] }), []);
  assert.match(html, />Update</);
  assert.match(html, />Uninstall</);
  assert.match(html, /1\.2\.3/);
  const empty = renderToStaticMarkup(createElement(PackageTable, { rows: [] }));
  assert.deepEqual(bannedCopyProblems(empty, { allowWords: ["package"] }), []);
});

// Design "Data source packages": the same server actions as today move here.
test("the table uses the same update and uninstall actions as before, and Settings links to the page", async () => {
  const table = await readFile(new URL("./package-table.tsx", import.meta.url), "utf8");
  assert.match(table, /updateConnectorAction/);
  assert.match(table, /uninstallConnectorAction/);
  const settings = await readFile(new URL("../page.tsx", import.meta.url), "utf8");
  assert.match(settings, /href="\/settings\/packages"/);
});

// Design "Data source packages": the link sits in a section about data sources near the top of Settings.
test("Settings carries the one-line link in a Data sources section above Remote access", async () => {
  const settings = await readFile(new URL("../page.tsx", import.meta.url), "utf8");
  const section = settings.indexOf('<Section title="Data sources">');
  const link = settings.indexOf("Data source packages</span>");
  assert.ok(section > 0 && link > section, "the link is inside the Data sources section");
  assert.ok(settings.indexOf('title="Remote access"') > link, "the section comes before Remote access");
  assert.equal((settings.match(/href="\/settings\/packages"/g) ?? []).length, 1);
});
