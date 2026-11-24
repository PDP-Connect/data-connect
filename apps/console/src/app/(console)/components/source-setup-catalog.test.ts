// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test, { mock } from "node:test";
import * as navigation from "next/navigation";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ConnectorCatalogEntry } from "../lib/connection-catalog.ts";
import {
  parseConnectorInstallCatalogResponse,
  parseConnectorInstallStatusResponse,
} from "../lib/connector-install-contract.ts";
import { connectorInstallCatalogFixture, connectorInstallStatusFixture } from "../lib/connector-install-fixtures.ts";
import type { ConnectorInstallLifecycle } from "../lib/connector-install-presentation.ts";

// The catalog's import graph reaches `server-only`, which throws outside a
// server component, and its recovery notice calls `useRouter`, which needs a
// mounted app router (same approach as owner-token-admission.harness.ts).
// Vendored components compiled outside the console tsconfig use the classic
// JSX runtime (same as consent-screen-runtime.test.mjs).
Object.assign(globalThis, { React });
mock.module("server-only", { namedExports: {} });
mock.module("next/navigation", {
  namedExports: { ...navigation, useRouter: () => ({ refresh() {} }) },
});
const catalogModule = import("./source-setup-catalog.tsx");

// Reddit before its package is installed: listed by a shipped manifest, not
// registered, and (while the package catalog is busy) with no package facts.
const reddit: ConnectorCatalogEntry = {
  acquisitionPaths: [],
  connectorKey: "reddit",
  deploymentReadiness: { blockers: [], guidance: null, state: "ready" },
  displayName: "Reddit",
  disposition: "browser_collector_manual",
  externalDocs: [],
  isKnownScaffold: false,
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

async function render(
  installCatalogTransientlyUnavailable: boolean,
  entry: ConnectorCatalogEntry = reddit,
  lifecycle?: ConnectorInstallLifecycle,
  installSkippedEntries = 0
): Promise<string> {
  const { SourceSetupCatalog } = await catalogModule;
  return renderToStaticMarkup(
    createElement(SourceSetupCatalog, {
      action: "/sources/add",
      catalog: [entry],
      installCatalogTransientlyUnavailable,
      installSkippedEntries,
      // The page builds this from the empty catalog a busy snapshot returns.
      installLifecycleByConnector: lifecycle ? { [entry.connectorKey]: lifecycle } : {},
      query: "",
    })
  );
}

test("a busy package catalog does not hide an unregistered connector", async () => {
  assert.match(await render(true), />Reddit</);
});

test("a known-empty package catalog hides an unregistered connector with no package", async () => {
  assert.doesNotMatch(await render(false), />Reddit</);
});

const INSTALL_BUTTON = />Install<\/button>/;
const UNAVAILABLE_FALSE = /data-row-unavailable="false"/;
const UNAVAILABLE_TRUE = /data-row-unavailable="true"/;
const UNAVAILABLE_DISCLOSURE = /data-testid="unavailable-connectors-disclosure"/;
const BROWSER_SETUP_LINK = /href="\/connect\/browser-session\//;
const INSTALL_OR_BROWSER_SETUP = />Install<\/button>|href="\/connect\/browser-session\//;
const INSTALL_DISABLED = /data-testid="connector-install-disabled"/;
const HOST_BLOCK = /Host blocked: Browser unavailable here\./;
const CANNOT_ADD_HERE = /1 connector cannot be added here/;
const PLATFORM_COPY = /not available on this platform/;
const UNKNOWN_PACKAGE = /data-testid="connector-install-catalog-transient"/;
const INSTALL_FIRST = /Install package first/;
const INSTALL_NEXT_STEP = /data-testid="connector-install-next-step"/;
const SKIPPED_NOTICE = /data-testid="install-skipped-notice"/;
const NEW_BROWSER_SETUP = /href="\/connect\/browser-session\/new-browser"/;

const unregisteredBrowser: ConnectorCatalogEntry = {
  ...reddit,
  connectorKey: "new-browser",
  disposition: "browser_bound_runbook",
  displayName: "New browser connector",
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

// A connector whose account setup is fully supported once it is registered.
// Before its package is installed the setup route would answer 404, so the
// card must lead with Install and only link to setup afterwards.
const setupCapable: ConnectorCatalogEntry = {
  ...unregisteredBrowser,
  disposition: "browser_collector_manual",
  ownerActionable: true,
};

test("an unregistered browser connector offers Install before account setup exists", async () => {
  const html = await render(false, setupCapable, browserPackage);
  assert.match(html, INSTALL_BUTTON, "the actual package control must remain reachable before registration");
  assert.match(html, UNAVAILABLE_FALSE);
  assert.doesNotMatch(html, UNAVAILABLE_DISCLOSURE);
  assert.doesNotMatch(html, BROWSER_SETUP_LINK, "installation must not invent a working setup route");
});

test("known scaffolds still offer neither Install nor account setup", async () => {
  const html = await render(
    false,
    {
      ...unregisteredBrowser,
      disposition: "browser_collector_manual",
      isKnownScaffold: true,
      ownerActionable: true,
    },
    browserPackage
  );
  assert.match(html, INSTALL_DISABLED);
  assert.doesNotMatch(html, INSTALL_OR_BROWSER_SETUP);
});

// Installing a package registers a connector but cannot create a setup path:
// these dispositions stay without an account action after registration, so an
// Install button for them would end in a connector that can never collect.
const DISPOSITIONS_WITHOUT_SETUP_PATH = [
  "provider_auth_proof_gated",
  "api_network_unsupported",
  "unknown_unsupported",
  "browser_bound_runbook",
] as const;
const NOT_INSTALLABLE = /Not installable: no setup path is available here\./;

for (const disposition of DISPOSITIONS_WITHOUT_SETUP_PATH) {
  test(`${disposition} never offers an install control and sorts into the collapsed footer`, async () => {
    const entry: ConnectorCatalogEntry = {
      ...unregisteredBrowser,
      disposition,
      ownerActionable: undefined,
      supportState: "unsupported",
    };
    for (const busy of [false, true]) {
      const html = await render(busy, entry, browserPackage);
      assert.doesNotMatch(html, INSTALL_BUTTON, `${disposition} (busy=${busy}) must not offer Install`);
      assert.doesNotMatch(html, INSTALL_FIRST);
      assert.match(html, INSTALL_DISABLED);
      assert.match(html, NOT_INSTALLABLE);
      assert.match(html, UNAVAILABLE_TRUE);
      assert.match(html, UNAVAILABLE_DISCLOSURE);
    }
  });
}

test("an explicit host restriction is displayed without offering Install", async () => {
  assert.ok(browserPackage.catalog);
  const html = await render(false, setupCapable, {
    ...browserPackage,
    catalog: {
      ...browserPackage.catalog,
      bindings: { browser: { available: false, reason: "Browser unavailable here." } },
    },
  });
  assert.match(html, HOST_BLOCK);
  assert.doesNotMatch(html, INSTALL_BUTTON);
});

test("a package without a latest digest does not gain an Install control", async () => {
  assert.ok(browserPackage.catalog);
  const html = await render(false, setupCapable, {
    ...browserPackage,
    catalog: { ...browserPackage.catalog, latest: false },
  });
  assert.doesNotMatch(html, INSTALL_BUTTON);
  assert.match(html, UNAVAILABLE_TRUE);
  assert.match(html, UNAVAILABLE_DISCLOSURE);
  assert.match(html, CANNOT_ADD_HERE);
  assert.doesNotMatch(html, PLATFORM_COPY);
});

test("a busy package catalog shows retry guidance without offering an unknown install", async () => {
  const html = await render(true, setupCapable, browserPackage);
  assert.match(html, UNKNOWN_PACKAGE);
  assert.match(html, UNAVAILABLE_FALSE);
  assert.doesNotMatch(html, INSTALL_OR_BROWSER_SETUP);
});

test("after installation account setup appears only when the setup planner supports it", async () => {
  const [installed] = parseConnectorInstallStatusResponse(connectorInstallStatusFixture).data;
  assert.ok(installed);
  assert.ok(browserPackage.catalog);
  const lifecycle: ConnectorInstallLifecycle = {
    catalog: { ...browserPackage.catalog, digest: installed.digest },
    installed: { ...installed, connector_id: "new-browser" },
  };
  const stillBlocked = await render(false, unregisteredBrowser, lifecycle);
  assert.doesNotMatch(stillBlocked, INSTALL_OR_BROWSER_SETUP);
  assert.match(stillBlocked, UNAVAILABLE_TRUE);

  const ready = await render(
    false,
    {
      ...unregisteredBrowser,
      disposition: "browser_collector_manual",
      ownerActionable: true,
      registrationStatus: "registered",
    },
    lifecycle
  );
  assert.match(ready, NEW_BROWSER_SETUP);
  assert.match(ready, UNAVAILABLE_FALSE);
  assert.doesNotMatch(ready, INSTALL_BUTTON);
});

test("a setup-capable connector offers Install first and links to account setup only once installed", async () => {
  const beforeInstall = await render(false, setupCapable, browserPackage);
  assert.match(beforeInstall, INSTALL_BUTTON);
  assert.match(beforeInstall, INSTALL_FIRST);
  assert.match(beforeInstall, INSTALL_NEXT_STEP);
  assert.doesNotMatch(beforeInstall, BROWSER_SETUP_LINK, "setup must not be linked before the package is installed");
  assert.match(beforeInstall, UNAVAILABLE_FALSE);

  const [installed] = parseConnectorInstallStatusResponse(connectorInstallStatusFixture).data;
  assert.ok(installed);
  assert.ok(browserPackage.catalog);
  const afterInstall = await render(false, { ...setupCapable, registrationStatus: "registered" }, {
    catalog: { ...browserPackage.catalog, digest: installed.digest },
    installed: { ...installed, connector_id: "new-browser" },
  });
  assert.match(afterInstall, NEW_BROWSER_SETUP);
  assert.doesNotMatch(afterInstall, INSTALL_BUTTON);
  assert.doesNotMatch(afterInstall, INSTALL_FIRST);
  assert.doesNotMatch(afterInstall, INSTALL_NEXT_STEP);
});

test("a registered connector whose package is not installed offers Install and no setup link", async () => {
  const html = await render(false, { ...setupCapable, registrationStatus: "registered" }, browserPackage);
  assert.match(html, INSTALL_BUTTON);
  assert.doesNotMatch(html, NEW_BROWSER_SETUP, "setup must wait for the package even when the connector is registered");
  assert.match(html, UNAVAILABLE_FALSE);
});

test("package offers the console could not read are reported, not silently missing", async () => {
  assert.doesNotMatch(await render(false, setupCapable, browserPackage, 0), SKIPPED_NOTICE);
  const one = await render(false, setupCapable, browserPackage, 1);
  assert.match(one, SKIPPED_NOTICE);
  assert.match(one, /1 package offer could not be read/);
  assert.match(await render(false, setupCapable, browserPackage, 3), /3 package offers could not be read/);
});

test("an installed connector that the reference has not registered shows registration pending, not a setup link", async () => {
  const [installed] = parseConnectorInstallStatusResponse(connectorInstallStatusFixture).data;
  assert.ok(installed);
  assert.ok(browserPackage.catalog);
  const lifecycle: ConnectorInstallLifecycle = {
    catalog: { ...browserPackage.catalog, digest: installed.digest },
    installed: { ...installed, connector_id: "new-browser" },
  };
  const pending = await render(false, setupCapable, lifecycle);
  assert.match(pending, /Registration pending/);
  assert.doesNotMatch(pending, BROWSER_SETUP_LINK, "the setup route answers 404 until the connector is registered");
  assert.doesNotMatch(pending, INSTALL_BUTTON);
  assert.match(pending, UNAVAILABLE_FALSE);

  const registered = await render(false, { ...setupCapable, registrationStatus: "registered" }, lifecycle);
  assert.doesNotMatch(registered, /Registration pending/);
  assert.match(registered, NEW_BROWSER_SETUP);
});
