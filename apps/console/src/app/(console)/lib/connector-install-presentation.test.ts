// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import type { ConnectorCatalogEntry } from "./connection-catalog.ts";
import {
  parseConnectorInstallCatalogResponse,
  parseConnectorInstallStatusResponse,
} from "./connector-install-contract.ts";
import {
  CONNECTOR_INSTALL_FIXTURE_DIGESTS,
  connectorInstallCatalogFixture,
  connectorInstallStatusFixture,
} from "./connector-install-fixtures.ts";
import {
  buildConnectorInstallLifecycleByConnector,
  connectorInstallRowModel,
  connectorLookupKey,
  shortConnectorDigest,
} from "./connector-install-presentation.ts";

const INSTALLED_DIGEST_RE = /^sha256:a{10}…a{6}$/;

function entry(
  connectorKey: string,
  publicTier: ConnectorCatalogEntry["publicTier"] = "supported"
): ConnectorCatalogEntry {
  return {
    acquisitionPaths: [],
    connectorKey,
    deploymentReadiness: { blockers: [], guidance: null, state: "ready" },
    displayName: connectorKey,
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
  };
}

test("lifecycle join selects the latest target and matches installed status by safe connector id", () => {
  const catalog = parseConnectorInstallCatalogResponse(connectorInstallCatalogFixture).data;
  const status = parseConnectorInstallStatusResponse(connectorInstallStatusFixture).data;
  const lifecycle = buildConnectorInstallLifecycleByConnector(catalog, status);
  const githubLifecycle = lifecycle.github;
  assert.ok(githubLifecycle);
  assert.equal(githubLifecycle.catalog?.version, "1.1.0");
  assert.equal(githubLifecycle.installed?.version, "1.0.0");
});

test("lifecycle join uses connector_key when catalog and status ids are registry URIs", () => {
  const catalog = parseConnectorInstallCatalogResponse(connectorInstallCatalogFixture).data;
  const status = parseConnectorInstallStatusResponse(connectorInstallStatusFixture).data;
  const latest = catalog.find((candidate) => candidate.connector_id === "github" && candidate.latest);
  const installed = status.find((candidate) => candidate.connector_id === "github");
  assert.ok(latest);
  assert.ok(installed);

  const registryId = "https://registry.pdpp.dev/connectors/package-slug";
  const lifecycle = buildConnectorInstallLifecycleByConnector(
    [
      {
        ...latest,
        catalog_connector_id: registryId,
        connector_id: registryId,
        connector_key: "owner-key",
      },
    ],
    [{ ...installed, connector_id: registryId }]
  );

  assert.equal(lifecycle["owner-key"]?.catalog?.version, "1.1.0");
  assert.equal(lifecycle["owner-key"]?.installed?.version, "1.0.0");
});

/**
 * Regression coverage for the Apple Contacts package-state bug: the manifest
 * spells its connector_key with an underscore (`apple_contacts`, this app's
 * own convention), but the published GHCR repository -- and so the OCI
 * catalog's connector_key -- uses a hyphen (`apple-contacts`). Before this
 * fix, `connectorLookupKey` only stripped a registry URL prefix, so the two
 * spellings never matched and a genuinely published connector fell through
 * to "not_listed" ("No published package") even though 42 of 45 connectors,
 * including this one, are live on the registry.
 */
test("lifecycle join matches a manifest's underscore connector_key against the catalog's hyphenated spelling", () => {
  const catalog = parseConnectorInstallCatalogResponse(connectorInstallCatalogFixture).data;
  const status = parseConnectorInstallStatusResponse(connectorInstallStatusFixture).data;
  const template = catalog.find((candidate) => candidate.latest);
  assert.ok(template);

  const lifecycle = buildConnectorInstallLifecycleByConnector(
    [{ ...template, connector_id: "apple-contacts", connector_key: "apple-contacts" }],
    status
  );

  const appleContacts = entry("apple_contacts");
  const model = connectorInstallRowModel(appleContacts, lifecycle[connectorLookupKey(appleContacts.connectorKey)] ?? {
    catalog: null,
    installed: null,
  });
  assert.notEqual(model.activationState, "not_listed", "a published connector must not report Not packaged yet");
  assert.ok(model.action, "a not-installed published connector must expose an install action");
});

test("not-installed latest package exposes Install with the explicit target digest", () => {
  const catalog = parseConnectorInstallCatalogResponse(connectorInstallCatalogFixture).data;
  const github = connectorInstallRowModel(entry("github"), {
    catalog: catalog.find((candidate) => candidate.connector_id === "github" && candidate.latest) ?? null,
    installed: null,
  });
  assert.equal(github.activationState, "not_installed");
  assert.deepEqual(github.action, {
    digest: CONNECTOR_INSTALL_FIXTURE_DIGESTS.githubCurrent,
    kind: "install",
    version: "1.1.0",
  });
  assert.equal(github.tier, "supported");
});

test("matching installed digest is Active and has no mutation action", () => {
  const catalog = parseConnectorInstallCatalogResponse(connectorInstallCatalogFixture).data;
  const status = parseConnectorInstallStatusResponse(connectorInstallStatusFixture).data;
  const [githubStatus] = status;
  assert.ok(githubStatus);
  const github = connectorInstallRowModel(entry("github"), {
    catalog: catalog.find((candidate) => candidate.connector_id === "github" && candidate.latest) ?? null,
    installed: {
      ...githubStatus,
      digest: CONNECTOR_INSTALL_FIXTURE_DIGESTS.githubCurrent,
      version: "1.1.0",
    },
  });
  assert.equal(github.activationState, "active");
  assert.equal(github.action, null);
  assert.match(github.installedDigest ?? "", INSTALLED_DIGEST_RE);
  assert.equal(github.installedDigestFull, CONNECTOR_INSTALL_FIXTURE_DIGESTS.githubCurrent);
  assert.equal(shortConnectorDigest(null), null);
});

test("older installed digest exposes Update only when a latest target exists", () => {
  const catalog = parseConnectorInstallCatalogResponse(connectorInstallCatalogFixture).data;
  const status = parseConnectorInstallStatusResponse(connectorInstallStatusFixture).data;
  const github = connectorInstallRowModel(entry("github"), {
    catalog: catalog.find((candidate) => candidate.connector_id === "github" && candidate.latest) ?? null,
    installed: status[0] ?? null,
  });
  assert.equal(github.activationState, "update_available");
  assert.deepEqual(github.action, {
    digest: CONNECTOR_INSTALL_FIXTURE_DIGESTS.githubCurrent,
    kind: "update",
    version: "1.1.0",
  });
});

test("explicit unavailable binding blocks Install and surfaces its server reason", () => {
  const catalog = parseConnectorInstallCatalogResponse(connectorInstallCatalogFixture).data;
  const signal = connectorInstallRowModel(entry("signal", "preview"), {
    catalog: catalog.find((candidate) => candidate.connector_id === "signal") ?? null,
    installed: null,
  });
  assert.equal(signal.hostBlockReason, "Install the local collector on this host.");
  assert.equal(signal.action, null);
});

test("a catalog row without latest=true does not invent an install target", () => {
  const catalog = parseConnectorInstallCatalogResponse(connectorInstallCatalogFixture).data;
  const historical = connectorInstallRowModel(entry("github"), {
    catalog: catalog.find((candidate) => candidate.connector_id === "github" && !candidate.latest) ?? null,
    installed: null,
  });
  assert.equal(historical.activationState, "not_installed");
  assert.equal(historical.action, null);
});
