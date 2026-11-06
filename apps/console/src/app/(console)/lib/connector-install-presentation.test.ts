// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import type { ConnectorCatalogEntry } from "./connection-catalog.ts";
import {
  ConnectorInstallContractError,
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
  isUninstallableCatalogEntry,
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

test("every explicitly blocked binding is reported, not only the first", () => {
  const catalog = parseConnectorInstallCatalogResponse(connectorInstallCatalogFixture).data;
  const signal = catalog.find((candidate) => candidate.connector_id === "signal");
  assert.ok(signal);
  const blocked = connectorInstallRowModel(entry("signal", "preview"), {
    catalog: {
      ...signal,
      bindings: {
        filesystem: { available: false, reason: "Install the local collector on this host." },
        network: { available: false, reason: "Outbound network is disabled." },
        display: { available: true },
      },
    },
    installed: null,
  });
  assert.equal(
    blocked.hostBlockReason,
    "Install the local collector on this host. Outbound network is disabled."
  );
  assert.equal(blocked.action, null);
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

test("a connector with no package, no install, and no registration is not installable", () => {
  const catalog = parseConnectorInstallCatalogResponse(connectorInstallCatalogFixture).data;
  const status = parseConnectorInstallStatusResponse(connectorInstallStatusFixture).data;
  const lifecycles = buildConnectorInstallLifecycleByConnector(catalog, status);
  const none = { catalog: null, installed: null };

  // Slack as the owner saw it: listed by a local manifest, absent from the
  // package catalog and install status, and not registered.
  assert.equal(lifecycles.slack, undefined);
  assert.equal(isUninstallableCatalogEntry(entry("slack"), none), true);

  assert.equal(isUninstallableCatalogEntry({ ...entry("slack"), registrationStatus: "registered" }, none), false);
  assert.equal(isUninstallableCatalogEntry(entry("github"), lifecycles.github ?? null), false);
  assert.equal(isUninstallableCatalogEntry(entry("imessage"), lifecycles.imessage ?? null), false);
  assert.equal(isUninstallableCatalogEntry(entry("slack"), null), false);
});

test("no package state reads Not packaged yet", () => {
  const none = { catalog: null, installed: null };
  const registered = connectorInstallRowModel({ ...entry("slack"), registrationStatus: "registered" }, none);
  assert.equal(registered.activationState, "not_listed");
  assert.equal(registered.activationLabel, "Included");
  assert.equal(registered.action, null);
  assert.notEqual(connectorInstallRowModel(entry("slack"), none).activationLabel, "Not packaged yet");
});

// ── ambiguous package facts fail closed ───────────────────────────

function latestTemplate() {
  const template = parseConnectorInstallCatalogResponse(connectorInstallCatalogFixture).data.find(
    (candidate) => candidate.latest && candidate.connector_key === "github"
  );
  assert.ok(template);
  return template;
}

const OTHER_DIGEST = `sha256:${"e".repeat(64)}`;

test("two catalog connectors whose keys differ only by separator offer no install target for either", () => {
  const template = latestTemplate();
  const lifecycle = buildConnectorInstallLifecycleByConnector(
    [
      { ...template, connector_id: "foo-bar", connector_key: "foo-bar" },
      { ...template, connector_id: "foo_bar", connector_key: "foo_bar", digest: OTHER_DIGEST },
    ],
    []
  );
  const key = connectorLookupKey("foo-bar");
  assert.equal(lifecycle[key]?.catalog ?? null, null, "the colliding key must not pick one digest by arrival order");
  const model = connectorInstallRowModel(entry("foo-bar"), lifecycle[key] ?? { catalog: null, installed: null });
  assert.equal(model.action, null);
});

test("an unambiguous catalog connector still matches a differently separated key", () => {
  const template = latestTemplate();
  const lifecycle = buildConnectorInstallLifecycleByConnector(
    [{ ...template, connector_id: "foo-bar", connector_key: "foo-bar" }],
    []
  );
  assert.equal(lifecycle[connectorLookupKey("foo_bar")]?.catalog?.digest, template.digest);
});

test("two latest rows with different digests for one connector offer no install target", () => {
  const template = latestTemplate();
  const lifecycle = buildConnectorInstallLifecycleByConnector(
    [template, { ...template, digest: OTHER_DIGEST, version: "9.9.9" }],
    []
  );
  assert.equal(lifecycle[connectorLookupKey(template.connector_key)]?.catalog ?? null, null);
});

test("a repeated latest row with the same digest is not ambiguous", () => {
  const template = latestTemplate();
  const lifecycle = buildConnectorInstallLifecycleByConnector([template, { ...template }], []);
  assert.equal(lifecycle[connectorLookupKey(template.connector_key)]?.catalog?.digest, template.digest);
});

test("an ambiguous catalog entry keeps the installed package visible", () => {
  const template = latestTemplate();
  const [installed] = parseConnectorInstallStatusResponse(connectorInstallStatusFixture).data;
  assert.ok(installed);
  const lifecycle = buildConnectorInstallLifecycleByConnector(
    [template, { ...template, digest: OTHER_DIGEST }],
    [{ ...installed, connector_id: template.connector_id }]
  );
  const merged = lifecycle[connectorLookupKey(template.connector_key)];
  assert.equal(merged?.catalog ?? null, null);
  assert.equal(merged?.installed?.digest, installed.digest);
});

test("two installed rows for one connector fail instead of letting the last win", () => {
  const catalog = parseConnectorInstallCatalogResponse(connectorInstallCatalogFixture).data;
  const [installed] = parseConnectorInstallStatusResponse(connectorInstallStatusFixture).data;
  assert.ok(installed);
  assert.throws(
    () =>
      buildConnectorInstallLifecycleByConnector(catalog, [
        installed,
        { ...installed, digest: OTHER_DIGEST, version: "2.0.0" },
      ]),
    (err: unknown) => err instanceof ConnectorInstallContractError && /more than one installed/i.test(err.message)
  );
});

test("installed rows that reach one connector through different ids fail too", () => {
  const template = latestTemplate();
  const [installed] = parseConnectorInstallStatusResponse(connectorInstallStatusFixture).data;
  assert.ok(installed);
  assert.throws(
    () =>
      buildConnectorInstallLifecycleByConnector(
        [{ ...template, connector_id: "foo-bar", connector_key: "foo-bar" }],
        [
          { ...installed, connector_id: "foo-bar" },
          { ...installed, connector_id: "foo_bar" },
        ]
      ),
    ConnectorInstallContractError
  );
});

// ── binding availability ──────────────────────────────────────────

// The manifest declares `runtime_requirements.bindings` as `{ required: boolean }`
// per binding (spec-collection-profile.md), and the install routes pass that
// object through. It carries no availability claim, so it must not block Install.
test("a binding as the manifest declares it ({ required }) does not block Install", () => {
  const template = latestTemplate();
  const model = connectorInstallRowModel(entry("github"), {
    catalog: { ...template, bindings: { network: { required: true }, interactive: { required: false } } },
    installed: null,
  });
  assert.equal(model.hostBlockReason, null);
  assert.ok(model.action);
});

for (const [label, value] of [
  ['"false"', "false"],
  ["0", 0],
  ["null", null],
  ["an object", {}],
] as const) {
  test(`a binding whose available field is ${label} blocks Install instead of passing as available`, () => {
    const template = latestTemplate();
    const model = connectorInstallRowModel(entry("github"), {
      catalog: { ...template, bindings: { filesystem: { available: value } } },
      installed: null,
    });
    assert.equal(model.action, null);
    assert.match(model.hostBlockReason ?? "", /filesystem availability could not be read/);
  });
}

test("a binding that says available: true does not block Install", () => {
  const template = latestTemplate();
  const model = connectorInstallRowModel(entry("github"), {
    catalog: { ...template, bindings: { filesystem: { available: true } } },
    installed: null,
  });
  assert.equal(model.hostBlockReason, null);
  assert.ok(model.action);
});
