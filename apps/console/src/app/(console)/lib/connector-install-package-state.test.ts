// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import type { ConnectorCatalogEntry } from "./connection-catalog.ts";
import {
  parseConnectorInstallCatalogResponse,
  parseConnectorInstallStatusResponse,
} from "./connector-install-contract.ts";
import { connectorInstallCatalogFixture, connectorInstallStatusFixture } from "./connector-install-fixtures.ts";
import { connectorInstallRowModel, type ConnectorInstallLifecycle } from "./connector-install-presentation.ts";

// registered, and (while the package catalog is busy) with no package facts.
const reddit: ConnectorCatalogEntry = {
  acquisitionPaths: [],
  connectorKey: "reddit",
  deploymentReadiness: { blockers: [], guidance: null, state: "ready" },
  displayName: "Reddit",
  disposition: "browser_collector_manual",
  externalDocs: [],
  readiness: null,
  listingNote: null,
  modality: "browser_bound",
  nextStepKind: "enroll_browser_collector",
  ownerActionable: true,
  ownerActionMethod: null,
  ownerActionUrl: null,
  proofGate: null,
  publicTier: "supported",
  refreshPolicyRationale: null,
  runbookPath: null,
  setupDescription: null,
  setupHelpText: null,
  setupModality: "browser_bound",
  supportState: "supported",
};

const unregisteredBrowser: ConnectorCatalogEntry = {
  ...reddit,
  connectorKey: "new-browser",
  disposition: "browser_bound_runbook",
  displayName: "New browser source",
  ownerActionable: false,
  registrationStatus: "not_registered",
};
const packageTemplate = parseConnectorInstallCatalogResponse(connectorInstallCatalogFixture).data.find(
  (entry) => entry.latest && entry.connector_key === "github"
);
assert.ok(packageTemplate);
const browserPackage: ConnectorInstallLifecycle = {
  catalog: { ...packageTemplate, connector_id: "new-browser", connector_key: "new-browser", bindings: {} },
  installed: null,
};

const setupCapable: ConnectorCatalogEntry = {
  ...unregisteredBrowser,
  disposition: "browser_collector_manual",
  ownerActionable: true,
};

test("package state distinguishes an included connector from an unavailable listing without offering Install", () => {
  const lifecycle = { catalog: null, installed: null };
  const bundled = connectorInstallRowModel({ ...setupCapable, registrationStatus: "registered" }, lifecycle);
  const absent = connectorInstallRowModel({ ...setupCapable, registrationStatus: "not_registered" }, lifecycle);
  assert.deepEqual([bundled.activationState, bundled.activationLabel, bundled.action], ["not_listed", "Included", null]);
  assert.deepEqual([absent.activationState, absent.activationLabel, absent.action], ["not_listed", "Not available in this app", null]);
});

test("a newer package leaves the installed version visible and explicitly names the update target", () => {
  const [installed] = parseConnectorInstallStatusResponse(connectorInstallStatusFixture).data;
  assert.ok(installed);
  assert.ok(browserPackage.catalog);
  const target = {
    ...browserPackage.catalog,
    digest: "sha256:" + "e".repeat(64),
    version: "2.0.0",
    latest: true,
  };
  const saved = { ...installed, digest: "sha256:" + "a".repeat(64), version: "1.0.0" };
  const available = connectorInstallRowModel(setupCapable, { catalog: target, installed: saved });
  assert.deepEqual([available.activationState, available.installedVersion, available.action], [
    "update_available", "1.0.0", { digest: target.digest, kind: "update", version: "2.0.0" },
  ]);
  const noTarget = connectorInstallRowModel(setupCapable, {
    catalog: { ...target, latest: false },
    installed: saved,
  });
  assert.deepEqual([noTarget.activationState, noTarget.installedVersion, noTarget.action], ["active", "1.0.0", null]);
});
