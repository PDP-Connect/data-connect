// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { buildOwnerConnectorCatalog, type ConnectorCatalogEntry } from "../../lib/connection-catalog.ts";
import type { ConnectorInstallCatalogEntry } from "../../lib/connector-install-contract.ts";
import type { ConnectorInstallLifecycle } from "../../lib/connector-install-presentation.ts";
import { buildConnectorInstallLifecycleByConnector, connectorLookupKey } from "../../lib/connector-install-presentation.ts";
import { sourceSetupCardModel } from "../../lib/source-setup-presentation.ts";
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

test("fresh Core offers install-before-proof only for supported or preview local collectors", () => {
  // Latest signed catalog entries, normalized by Core; a fresh image has no
  // registered manifests, templates, or installed packages to supply proof yet.
  const packages: ConnectorInstallCatalogEntry[] = [
    {
      connector_key: "claude-code",
      display_name: "Claude Code",
      digest: "sha256:13687c6441cede6b6a50169f9d66c28878bdb1212c694c4152896612453f5d68",
      version: "0.3.30",
      tier: "supported",
    },
    {
      connector_key: "codex",
      display_name: "OpenAI Codex CLI",
      digest: "sha256:6df59e78fcfd79cef46c0b3ef512a7bc3c921cf9536cabb647893e7ca131437e",
      version: "0.3.15",
      tier: "supported",
    },
    { connector_key: "twitter-archive", display_name: "Twitter/X Archive", version: "0.1.26", tier: "development", digest: "sha256:d45bca513f6fe29f57572bae6e2850295baab9f20c1253a731110daa6e54da6c" },
    { connector_key: "ical", display_name: "Calendar (iCal)", version: "0.1.26", tier: "development", digest: "sha256:2b8c4cc8db4adf57fb135a983caf8e4e4934f5dada8d156cccbad64541d4cce5" },
    { connector_key: "apple-photos", display_name: "Apple Photos", version: "0.1.27", tier: "development", digest: "sha256:291787ea345a1bc70655ae0a02b9ed134cb75467d6aac2441c259b8341e1744b" },
    { connector_key: "google-takeout", display_name: "Google Takeout", version: "0.1.28", tier: "development", digest: "sha256:d7a388d383c7474dde89031dbe129c69bf9dc702cf4d9340e9725a606d92c111" },
    { connector_key: "imessage", display_name: "iMessage (macOS)", version: "0.1.26", tier: "development", digest: "sha256:f38ee9b8958748b76dc84fbdfc8ea9ec5c803c1a76798a767f000cebd8d6c204" },
  ].map((entry) => ({
    ...entry,
    bindings: { filesystem: { required: true }, ...(entry.connector_key === "google-takeout" ? { network: { required: false } } : {}) },
    catalog_connector_id: `https://registry.pdpp.dev/connectors/${entry.connector_key}`,
    connector_id: entry.connector_key,
    latest: true,
    tier: entry.tier as ConnectorInstallCatalogEntry["tier"],
  }));
  const catalog = buildOwnerConnectorCatalog([], [], packages);
  const lifecycle = buildConnectorInstallLifecycleByConnector(packages, []);
  assert.ok(catalog.every((entry) => entry.disposition === "local_collector_unproven"));
  const model = buildAddSourceList({
    catalog,
    catalogTransientlyUnavailable: false,
    existingConnectionIds: {},
    lifecycleFor: (entry) => lifecycle[entry.connectorKey] ?? null,
  });
  assert.deepEqual(model.rows.map((row) => row.connectorKey), ["claude-code", "codex"]);
  for (const entry of catalog) {
    const state = lifecycle[entry.connectorKey]!;
    const offered = entry.publicTier === "supported" || entry.publicTier === "preview";
    assert.equal(isConnectableEntry(entry, state, false), offered, `${entry.connectorKey}: connect page availability`);
    const card = sourceSetupCardModel(entry, state, false);
    assert.equal(card.noSetupPath, !offered);
    assert.equal(card.packageNeedsInstall, offered, `${entry.connectorKey}: no automatic install for a refused service`);
    assert.equal(isConnectableEntry({ ...entry, registrationStatus: "registered" }, state, false), false);
    assert.equal(isConnectableEntry(entry, {
      ...state,
      catalog: { ...state.catalog!, bindings: { filesystem: { available: false } } },
    }, false), false);
  }
});

test("preview permits install-before-proof, but development and unknown tiers do not", () => {
  const unregistered = { ...claudeCode, disposition: "local_collector_unproven", registrationStatus: undefined } as ConnectorCatalogEntry;
  for (const publicTier of ["supported", "preview", "development", "unknown"] as const) {
    const expected = publicTier === "supported" || publicTier === "preview";
    assert.equal(isConnectableEntry({ ...unregistered, publicTier }, notInstalled("claude-code"), false), expected);
    assert.equal(isConnectableEntry({ ...unregistered, publicTier }, notInstalled("claude-code"), true), expected);
    assert.equal(isConnectableEntry({ ...claudeCode, publicTier }, installed("claude-code"), false), true,
      "a registered, proven collector keeps its setup path regardless of tier");
  }
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


test("an unavailable-first alias does not hide a usable service", () => {
  const blocked = { ...appleHealth, connectorKey: "apple_health", disposition: "unknown_unsupported" } as ConnectorCatalogEntry;
  const model = build({}, [blocked, appleHealth]);
  assert.equal(model.rows.length, 1);
  assert.equal(model.rows[0]?.connectorKey, "apple-health");
  assert.deepEqual(model.notAddable, []);
});

test("saved account keys normalize across catalog aliases", () => {
  const model = build({ apple_health: ["cin_a"] }, [appleHealth]);
  assert.equal(model.rows[0]?.added, true);
});

mock.module("server-only", { namedExports: {} });

test("list and route lookup choose the connectable alias in either input order", async () => {
  const { findCatalogEntry } = await import("./add-source-catalog-read.ts");
  const usable = { ...ynab, connectorKey: "my-service" };
  const blocked = { ...usable, connectorKey: "my_service", publicTier: "preview", disposition: "unknown_unsupported" } as ConnectorCatalogEntry;
  for (const catalog of [[blocked, usable], [usable, blocked]]) {
    const read = {
      catalog,
      catalogTransientlyUnavailable: false,
      existingConnectionIds: {},
      lifecycleFor: () => notInstalled("my-service"),
    };
    const row = buildAddSourceList(read).rows[0]!;
    assert.equal(row.connectorKey, usable.connectorKey);
    assert.equal(findCatalogEntry(read, row.connectorKey), usable);
  }
});

// A service the server says cannot be set up on this computer is marked before it is picked.
test("a sign-in service this computer cannot open is listed with a note, and the others are not", () => {
  const blockedChase = { ...chase, readiness: { action: "configure", browserBound: true, connectorKey: "chase", detail: null, reason: "host_requirement_unmet" } } as ConnectorCatalogEntry;
  const model = build({}, [blockedChase, ynab]);
  const row = Object.fromEntries(model.rows.map((entryRow) => [entryRow.connectorKey, entryRow.blockedNote]));
  assert.equal(row.chase, "Can't be added on this computer yet");
  assert.equal(row.ynab, null);
});

// The list and the page must agree: a service the console holds as installed, but whose server verdict
// says the package must still be installed, is blocked on its setup page, so the list says so first.
test("an installed service whose server verdict still says install is marked; one still to install is not", () => {
  const verdict = { action: "install", browserBound: true, detail: null, reason: "not_installed" };
  const chaseNoArtifact = { ...chase, readiness: { ...verdict, connectorKey: "chase" } } as ConnectorCatalogEntry;
  const amazonToInstall = { ...amazon, readiness: { ...verdict, connectorKey: "amazon" } } as ConnectorCatalogEntry;
  const row = Object.fromEntries(build({}, [chaseNoArtifact, amazonToInstall]).rows.map((entryRow) => [entryRow.connectorKey, entryRow.blockedNote]));
  assert.equal(row.chase, "Can't be added on this computer yet");
  assert.equal(row.amazon, null);
});
