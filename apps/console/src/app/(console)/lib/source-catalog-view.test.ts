// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import type { ConnectorCatalogEntry } from "./connection-catalog.ts";
import { buildCatalogView, type CatalogViewOptions, searchUrlFor } from "./source-catalog-view.ts";

function entry(
  connectorKey: string,
  displayName: string,
  publicTier: ConnectorCatalogEntry["publicTier"],
  overrides: Partial<ConnectorCatalogEntry> = {}
): ConnectorCatalogEntry {
  return {
    acquisitionPaths: [],
    connectorKey,
    deploymentReadiness: { blockers: [], guidance: null, state: "ready" },
    displayName,
    disposition: "static_secret_connect",
    externalDocs: [],
    isKnownScaffold: false,
    listingNote: null,
    modality: "api_network",
    nextStepKind: "capture_static_secret",
    ownerActionable: true,
    ownerActionMethod: null,
    ownerActionUrl: null,
    proofGate: null,
    publicTier,
    refreshPolicyRationale: null,
    runbookPath: null,
    setupDescription: null,
    setupHelpText: null,
    setupModality: "static_secret",
    supportState: "supported",
    ...overrides,
  };
}

const scaffold = (key: string, name: string) =>
  entry(key, name, "development", {
    disposition: "browser_bound_runbook",
    isKnownScaffold: true,
    ownerActionable: false,
  });

const catalog = [
  entry("zeta", "Zeta", "supported"),
  entry("alpha", "Alpha", "development"),
  entry("mid", "Middle", "preview"),
  entry("beta", "Beta", "supported"),
  scaffold("ghost", "Ghost"),
];

const base: CatalogViewOptions = {
  maturity: "all",
  ownedKeys: new Set(),
  query: "",
  sort: "name",
  updateKeys: new Set(),
  worksHereOnly: false,
};

const names = (entries: readonly ConnectorCatalogEntry[]) => entries.map((e) => e.displayName);

test("default order is by name; maturity does not decide it", () => {
  const view = buildCatalogView(catalog, base);
  // "Alpha" is in development and still comes first: a connector is not buried because it is early.
  assert.deepEqual(names(view.addable), ["Alpha", "Beta", "Middle", "Zeta"]);
});

test("sorting by maturity puts supported first, then name within a tier", () => {
  const view = buildCatalogView(catalog, { ...base, sort: "maturity" });
  assert.deepEqual(names(view.addable), ["Beta", "Zeta", "Middle", "Alpha"]);
});

test("the maturity filter keeps one tier", () => {
  assert.deepEqual(names(buildCatalogView(catalog, { ...base, maturity: "supported" }).addable), ["Beta", "Zeta"]);
  assert.deepEqual(names(buildCatalogView(catalog, { ...base, maturity: "preview" }).addable), ["Middle"]);
  assert.deepEqual(names(buildCatalogView(catalog, { ...base, maturity: "development" }).addable), ["Alpha"]);
});

test("rows with no setup path are set apart and dropped by the works-on-this-device filter", () => {
  assert.deepEqual(names(buildCatalogView(catalog, base).unavailable), ["Ghost"]);
  assert.deepEqual(names(buildCatalogView(catalog, { ...base, worksHereOnly: true }).unavailable), []);
});

test("owned sources come first, updates before the rest, and ignore the add-list filters", () => {
  const view = buildCatalogView(catalog, {
    ...base,
    maturity: "preview",
    ownedKeys: new Set(["zeta", "beta"]),
    updateKeys: new Set(["zeta"]),
  });
  assert.deepEqual(names(view.yours), ["Zeta", "Beta"]);
  assert.deepEqual(names(view.addable), ["Middle"]);
  assert.equal(
    [...view.yours, ...view.addable, ...view.unavailable].filter((e) => e.connectorKey === "zeta").length,
    1,
    "an owned source is listed once, not again under Add a source"
  );
});

test("search matches the display name or connector key, case-insensitively", () => {
  assert.deepEqual(names(buildCatalogView(catalog, { ...base, query: " MID " }).addable), ["Middle"]);
  assert.deepEqual(names(buildCatalogView(catalog, { ...base, query: "ghost" }).unavailable), ["Ghost"]);
});

test("the search URL keeps the rest of the location and drops an empty query", () => {
  assert.equal(
    searchUrlFor("http://localhost:3000/sources/add?demo=1#top", " gmail "),
    "/sources/add?demo=1&source_q=gmail#top"
  );
  assert.equal(searchUrlFor("http://localhost:3000/sources/add?source_q=gmail", ""), "/sources/add");
});
