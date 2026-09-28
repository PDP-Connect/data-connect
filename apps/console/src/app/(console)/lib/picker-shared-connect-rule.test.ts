// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// The Add Source picker offers a browser Connect action by the same rule as the
// browser-session routes and the RI enrollment-shell route:
// browserEnrollmentSupport(...).canAddAccount. Production readiness shows as
// the tier badge; it does not remove the action.

import assert from "node:assert/strict";
import { test } from "node:test";
import { browserEnrollmentSupport } from "pdpp-reference-implementation/connection-setup-plan";
import { buildOwnerConnectorCatalog, type CatalogManifestLike, type ConnectorCatalogEntry } from "./connection-catalog.ts";
import { sourceSetupAction, sourceSetupStatus } from "./source-setup-presentation.ts";

type Tier = "supported" | "preview" | "development";

function browserManifest(connectorId: string, tier: Tier): CatalogManifestLike {
  return {
    capabilities: { public_listing: { tier } },
    connector_id: connectorId,
    display_name: connectorId,
    runtime_requirements: { bindings: { browser: { required: true } } },
  };
}

function pickerEntry(connectorId: string, tier: Tier): ConnectorCatalogEntry {
  const entry = buildOwnerConnectorCatalog([browserManifest(connectorId, tier)], []).find(
    (candidate) => candidate.connectorKey === connectorId
  );
  assert.ok(entry, `${connectorId} is listed`);
  return entry;
}

test("a catalog-installed browser connector no key list names gets a Connect action and its tier badge", () => {
  for (const [tier, badge] of [
    ["development", "In development"],
    ["preview", "Preview"],
  ] as const) {
    const entry = pickerEntry("acme-shop", tier);
    assert.equal(entry.disposition, "browser_collector_manual");
    assert.equal(entry.enrollmentKey, "acme-shop");
    assert.ok(sourceSetupAction(entry), `acme-shop (${tier}) has a Connect action`);
    assert.equal(sourceSetupStatus(entry).label, badge);
  }
});

test("a known scaffold gets no Connect action", () => {
  const entry = pickerEntry("anthropic", "development");
  assert.equal(entry.disposition, "browser_bound_runbook");
  assert.equal(sourceSetupAction(entry), null);
  assert.equal(sourceSetupStatus(entry).label, "Not built yet");
});

test("a production-ready bundled browser connector still gets a Connect action", () => {
  const entry = pickerEntry("amazon", "supported");
  assert.equal(entry.disposition, "browser_collector_manual");
  assert.ok(sourceSetupAction(entry));
  assert.equal(entry.publicTier, "supported");
});

test("the picker's Connect decision equals browserEnrollmentSupport for every case", () => {
  for (const connectorId of ["acme-shop", "anthropic", "amazon", "doordash", "reddit"]) {
    const entry = pickerEntry(connectorId, "preview");
    const bindings = { connector_id: connectorId, runtime_requirements: { bindings: { browser: { required: true } } } };
    assert.equal(
      entry.disposition === "browser_collector_manual",
      browserEnrollmentSupport(connectorId, bindings).canAddAccount,
      connectorId
    );
  }
});
