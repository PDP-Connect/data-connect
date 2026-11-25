// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import type { ConnectorCatalogEntry } from "../../lib/connection-catalog.ts";
import type { ConnectorInstallLifecycle } from "../../lib/connector-install-presentation.ts";
import { connectorLookupKey } from "../../lib/connector-install-presentation.ts";
import { buildAddSourceList, isConnectableEntry, searchAddSourceList } from "./add-source-list-model.ts";
import { ALL_ENTRIES, amazon, appleHealth, chase, claudeCode, installed, notInstalled, whoop, ynab } from "./add-flow-fixtures.ts";

const lifecycles: Record<string, ConnectorInstallLifecycle> = {
  amazon: notInstalled("amazon"),
  "apple-health": notInstalled("apple-health"),
  chase: installed("chase"),
  "claude-code": notInstalled("claude-code"),
  whoop: notInstalled("whoop"),
  ynab: notInstalled("ynab"),
};

function build(existing: Record<string, readonly string[]> = {}, catalog: readonly ConnectorCatalogEntry[] = ALL_ENTRIES) {
  return buildAddSourceList({
    catalog,
    catalogTransientlyUnavailable: false,
    existingConnectionIds: existing,
    lifecycleFor: (entry) => lifecycles[connectorLookupKey(entry.connectorKey)] ?? { catalog: null, installed: null },
  });
}

// Design "Page 1" / "Rows with no way to connect: Not listed".
test("the list shows only services that can be connected, A to Z", () => {
  const model = build();
  assert.deepEqual(
    model.rows.map((row) => row.displayName),
    ["Amazon", "Apple Health", "Chase", "Claude Code", "YNAB"]
  );
  assert.equal(model.rows.some((row) => row.connectorKey === whoop.connectorKey), false);
  assert.deepEqual(model.notAddable, ["WHOOP"]);
});

// Design "Page 1": a service you already have is always listed, "Added", and never "can't be added".
test("an added service that cannot take a second account is still a row, and opens its own page", () => {
  const model = build({ amazon: ["cin_a"], whoop: ["cin_w"] });
  const whoopRow = model.rows.find((row) => row.connectorKey === "whoop");
  assert.ok(whoopRow, "WHOOP has an account, so it is listed");
  assert.equal(whoopRow.added, true);
  assert.equal(whoopRow.href, "/sources/whoop?connection_id=cin_w");
  assert.equal(model.notAddable.includes("WHOOP"), false);
  assert.deepEqual(searchAddSourceList(model, "whoo").kind, "rows");
});

test("an added service that can take a second account opens the connect page", () => {
  const amazonRow = build({ amazon: ["cin_a"] }).rows.find((row) => row.connectorKey === "amazon");
  assert.ok(amazonRow);
  assert.equal(amazonRow.added, true);
  assert.equal(amazonRow.href, "/sources/add/amazon");
});

// Design item "Installed section ... A service you have stays in the list with a quiet Added".
test("the list marks services that already have an account as Added, and no others", () => {
  const model = build({ amazon: ["cin_a"], chase: [] });
  const added = Object.fromEntries(model.rows.map((row) => [row.connectorKey, row.added]));
  assert.equal(added.amazon, true);
  assert.equal(added.chase, false);
  assert.equal(added.ynab, false);
});

// Design "Honest states": a host that cannot run the package is not offered.
test("a service whose package the host cannot run is not listed", () => {
  const blocked: ConnectorInstallLifecycle = {
    catalog: { ...notInstalled("amazon").catalog, bindings: { network: { available: false, reason: "offline" } } } as never,
    installed: null,
  };
  assert.equal(isConnectableEntry(amazon, blocked, false), false);
  assert.equal(isConnectableEntry(amazon, notInstalled("amazon"), false), true);
});

// Design "Rows with no way to connect": a service with no package and not registered is not listed.
test("a service with no package and no registration is not listed", () => {
  assert.equal(isConnectableEntry({ ...chase, registrationStatus: undefined }, { catalog: null, installed: null }, false), false);
});

test("every row links to its own connect page, with no install step in the link", () => {
  for (const row of build().rows) {
    assert.equal(row.href, `/sources/add/${encodeURIComponent(row.connectorKey)}`);
  }
});

// Design "Page 1": the two empty-search sentences.
test("search answers a service that cannot be added, and a query that matches nothing", () => {
  const model = build();
  assert.deepEqual(searchAddSourceList(model, "whoo"), { kind: "cannot-add", name: "WHOOP" });
  assert.deepEqual(searchAddSourceList(model, "zzz"), { kind: "no-match", query: "zzz" });
  const hit = searchAddSourceList(model, "ama");
  assert.equal(hit.kind, "rows");
  assert.deepEqual(searchAddSourceList(model, "  ").kind, "rows");
});

test("fixtures cover each kind of service the design names", () => {
  assert.deepEqual(
    [amazon, ynab, appleHealth, claudeCode].map((entry) => entry.disposition),
    ["browser_collector_manual", "static_secret_connect", "manual_upload_connect", "local_collector_enroll"]
  );
});
