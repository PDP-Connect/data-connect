// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Add a source takes a connector's availability from the signed install
 * catalog. The vendored conformance roster marks linkedin (and others) as a
 * known scaffold; the live catalog publishes them.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { browserConnectSupport } from "./browser-connect-support.ts";
import {
  buildOwnerConnectorCatalog,
  type CatalogManifestLike,
  type OwnerConnectorTemplateLike,
} from "./connection-catalog.ts";
import type { ConnectorInstallCatalogEntry } from "./connector-install-contract.ts";
import { sourceSetupAction, sourceSetupRowIsUnavailable, sourceSetupStatus } from "./source-setup-presentation.ts";

const DIGEST = `sha256:${"a".repeat(64)}`;

const linkedinManifest: CatalogManifestLike = {
  capabilities: { public_listing: { tier: "development" } },
  connector_id: "https://registry.pdpp.dev/connectors/linkedin",
  connector_key: "linkedin",
  display_name: "LinkedIn",
  runtime_requirements: { bindings: { browser: {} } },
};

const loomManifest: CatalogManifestLike = {
  capabilities: { public_listing: { tier: "development" } },
  connector_id: "https://registry.pdpp.dev/connectors/loom",
  connector_key: "loom",
  display_name: "Loom",
  runtime_requirements: { bindings: { browser: {} } },
};

function catalogEntry(key: string): ConnectorInstallCatalogEntry {
  return {
    bindings: { browser: {} },
    connector_id: key,
    connector_key: key,
    digest: DIGEST,
    display_name: key,
    latest: true,
    setup_modality: "browser_bound",
    tier: "development",
    version: "0.3.34",
  };
}

/** A server template as the reference serves it for a vendored scaffold. */
function scaffoldTemplate(key: string, published: boolean): OwnerConnectorTemplateLike {
  return {
    connector_id: key,
    connector_key: key,
    connector_modality: "browser_bound",
    display_name: key,
    is_known_scaffold: !published,
    public_listing: { tier: "development" },
    registration_status: "registered",
    setup_plan: {
      catalog_disposition: published ? "browser_collector_manual" : "browser_bound_runbook",
      deployment_readiness: { blockers: [], guidance: null, state: "not_applicable" },
      enrollment_key: published ? key : null,
      next_step_kind: published ? "enroll_browser_collector" : "manual_runbook",
      owner_actionable: false,
      proof_gate: "browser_collector_live_proof_missing",
      runbook_path: null,
      setup_modality: "browser_bound",
      support_state: "proof_gated",
    },
    supported_actions: [],
  };
}

test("a template flagged scaffold by the vendored roster is available when the signed catalog lists it", () => {
  const template = { ...scaffoldTemplate("linkedin", true), is_known_scaffold: true };
  const [entry] = buildOwnerConnectorCatalog([linkedinManifest], [template], [catalogEntry("linkedin")]);
  assert.ok(entry);
  assert.equal(entry.isKnownScaffold, false);
  assert.notEqual(sourceSetupStatus(entry).label, "Not available yet");
  assert.equal(sourceSetupRowIsUnavailable(entry), false);
});

test("without templates, a roster scaffold the signed catalog lists gets a connect action", () => {
  const catalog = buildOwnerConnectorCatalog([linkedinManifest], [], [catalogEntry("linkedin")]);
  const entry = catalog.find((candidate) => candidate.connectorKey === "linkedin");
  assert.ok(entry);
  assert.equal(entry.isKnownScaffold, false);
  assert.equal(entry.disposition, "browser_collector_manual");
  assert.deepEqual(sourceSetupAction(entry), {
    href: "/connect/browser-session/linkedin",
    label: "Connect account",
  });
});

test("a roster scaffold the catalog does not list stays unavailable", () => {
  const catalog = buildOwnerConnectorCatalog(
    [loomManifest],
    [scaffoldTemplate("loom", false)],
    [catalogEntry("linkedin")]
  );
  const entry = catalog.find((candidate) => candidate.connectorKey === "loom");
  assert.ok(entry);
  assert.equal(entry.isKnownScaffold, true);
  assert.equal(sourceSetupAction(entry), null);
  assert.equal(sourceSetupStatus(entry).label, "Not available yet");
  assert.equal(sourceSetupRowIsUnavailable(entry), true);
});

test("an empty catalog (fetch failed) never makes a roster scaffold available", () => {
  const catalog = buildOwnerConnectorCatalog([linkedinManifest], [], []);
  const entry = catalog.find((candidate) => candidate.connectorKey === "linkedin");
  assert.ok(entry);
  assert.equal(entry.isKnownScaffold, true);
  assert.equal(sourceSetupAction(entry), null);
});

test("browser-session setup accepts a roster scaffold only when the catalog lists it", () => {
  const sources = [{ bindings: { browser: {} }, connector_id: "linkedin" }];
  assert.equal(browserConnectSupport("linkedin", sources).canAddAccount, false);
  assert.equal(browserConnectSupport("linkedin", sources, true).canAddAccount, true);
});
