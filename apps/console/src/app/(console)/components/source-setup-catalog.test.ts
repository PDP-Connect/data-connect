// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test, { mock } from "node:test";
import * as navigation from "next/navigation";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ConnectorCatalogEntry } from "../lib/connection-catalog.ts";
import type { ExistingSourceSetupLink } from "./source-setup-catalog.tsx";
import { buildAddSourceDemoCatalog } from "../sources/add/add-source-demo-data.ts";
import {
  parseConnectorInstallCatalogResponse,
  parseConnectorInstallStatusResponse,
} from "../lib/connector-install-contract.ts";
import { connectorInstallCatalogFixture, connectorInstallStatusFixture } from "../lib/connector-install-fixtures.ts";
import { connectorInstallRowModel, type ConnectorInstallLifecycle } from "../lib/connector-install-presentation.ts";

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

async function render(
  installCatalogTransientlyUnavailable: boolean,
  entry: ConnectorCatalogEntry = reddit,
  lifecycle?: ConnectorInstallLifecycle,
  installSkippedEntries = 0,
  existingSourcesByConnector: Readonly<Record<string, readonly ExistingSourceSetupLink[]>> = {},
  query = ""
): Promise<string> {
  const { SourceSetupCatalog } = await catalogModule;
  return renderToStaticMarkup(
    createElement(SourceSetupCatalog, {
      catalog: [entry],
      existingSourcesByConnector,
      installCatalogTransientlyUnavailable,
      installSkippedEntries,
      // The page builds this from the empty catalog a busy snapshot returns.
      installLifecycleByConnector: lifecycle ? { [entry.connectorKey]: lifecycle } : {},
      query,
    })
  );
}

function copyOutsideDetails(html: string): string {
  const detailsTags = /<details\b[^>]*>|<\/details>/gi;
  const stack: Array<{ bodyStart: number; summary: string }> = [];
  const hiddenRanges: Array<[number, number]> = [];
  for (const match of html.matchAll(detailsTags)) {
    if (match[0].startsWith("</")) {
      const details = stack.pop();
      if (details?.summary === "details") hiddenRanges.push([details.bodyStart, match.index ?? 0]);
      continue;
    }
    const summaryEnd = html.indexOf("</summary>", (match.index ?? 0) + match[0].length);
    if (summaryEnd < 0) continue;
    const summaryStart = html.indexOf(">", (match.index ?? 0) + match[0].length - 1) + 1;
    const summary = html
      .slice(summaryStart, summaryEnd)
      .replace(/<[^>]*>/g, " ")
      .trim()
      .toLowerCase();
    stack.push({ bodyStart: summaryEnd + "</summary>".length, summary });
  }

  const mergedRanges: Array<[number, number]> = [];
  for (const [start, end] of hiddenRanges.sort(([left], [right]) => left - right)) {
    const previous = mergedRanges.at(-1);
    if (previous && start <= previous[1]) previous[1] = Math.max(previous[1], end);
    else mergedRanges.push([start, end]);
  }
  let visibleHtml = html;
  for (const [start, end] of mergedRanges.reverse()) {
    visibleHtml = `${visibleHtml.slice(0, start)}${visibleHtml.slice(end)}`;
  }
  const accessibleLabels = [...visibleHtml.matchAll(/\b(?:aria-label|alt|title|placeholder)="([^"]*)"/g)]
    .map((match) => match[1])
    .join(" ");
  const visibleText = visibleHtml
    .replace(/<[^>]*>/g, " ")
    .replace(/&(?:amp|lt|gt|quot|#x27|#39);/g, " ");
  return `${visibleText} ${accessibleLabels}`;
}

function assertNoBannedPageWords(html: string, sample: string): void {
  const copy = copyOutsideDetails(html);
  const bannedWords = /\b(?:grant|client|bearer|scope|token|run|stream|connector|manifest|projection|cursor|trace|verdict|coverage|fleet|subscription|exporter|OAuth|PKCE|DCR|JWKS|instance)\b|provider app|reference server|\b\d{4}-\d{2}-\d{2}\b|\braw JSON\b/i;
  assert.doesNotMatch(copy, bannedWords, sample);
}

async function renderEntries(
  catalog: ConnectorCatalogEntry[],
  options: {
    existingSourcesByConnector?: Readonly<Record<string, readonly ExistingSourceSetupLink[]>>;
    installCatalogTransientlyUnavailable?: boolean;
    installLifecycleByConnector?: Readonly<Record<string, ConnectorInstallLifecycle>>;
    installSkippedEntries?: number;
  } = {}
): Promise<string> {
  const { SourceSetupCatalog } = await catalogModule;
  return renderToStaticMarkup(
    createElement(SourceSetupCatalog, {
      catalog,
      existingSourcesByConnector: options.existingSourcesByConnector ?? {},
      installCatalogTransientlyUnavailable: options.installCatalogTransientlyUnavailable ?? false,
      installSkippedEntries: options.installSkippedEntries ?? 0,
      installLifecycleByConnector: options.installLifecycleByConnector ?? {},
      query: "",
    })
  );
}

test("a busy package catalog does not hide an unregistered connector", async () => {
  assert.match(await render(true), />Reddit</);
});

// Brief decisions 3 and 4: typing filters existing catalog data and maturity filters keep tiers separate.
test("catalog maturity filtering separates ready, testing, and development entries", async () => {
  const { filterSourceCatalog } = await catalogModule;
  const entries = [
    reddit,
    { ...reddit, connectorKey: "preview", displayName: "Preview source", publicTier: "preview" as const },
    { ...reddit, connectorKey: "development", displayName: "Development source", publicTier: "development" as const },
  ];
  const { DEFAULT_SOURCE_MATURITIES } = await catalogModule;
  assert.deepEqual(filterSourceCatalog(entries, "", new Set(["ready"])).map((entry) => entry.connectorKey), ["reddit"]);
  assert.deepEqual(filterSourceCatalog(entries, "", new Set(["testing"])).map((entry) => entry.connectorKey), ["preview"]);
  assert.deepEqual(filterSourceCatalog(entries, "development", new Set(["development"])).map((entry) => entry.connectorKey), ["development"]);
  // Brief decision 4: with no filter chosen, testing rows show beside ready rows; development rows stay hidden.
  assert.deepEqual(filterSourceCatalog(entries, "", DEFAULT_SOURCE_MATURITIES).map((entry) => entry.connectorKey), ["preview", "reddit"]);
});

// Add-page repair decision 1: an existing data source is installed even without a package lifecycle record.
test("an existing data source counts as installed when no package is installed", async () => {
  const { sourceIsInstalled } = await catalogModule;
  const amazon = buildAddSourceDemoCatalog().catalog.find((entry) => entry.connectorKey === "amazon");
  assert.ok(amazon);
  assert.equal(sourceIsInstalled(amazon, null, buildAddSourceDemoCatalog().existingSourcesByConnector), true);
  assert.equal(sourceIsInstalled(reddit, null, {}), false);
});

// Brief decision 4: an in-testing data source the person already uses shows under Installed without touching Filter.
test("an in-testing source with an existing data source shows in the default view", async () => {
  const preview = { ...reddit, displayName: "Preview source", publicTier: "preview" as const };
  const html = await render(false, preview, undefined, 0, {
    reddit: [{ connectionId: "c1", displayName: "Main account", latestImportFile: null, latestImportStatus: null, status: null, totalRecords: 3 }],
  });
  const installed = html.slice(html.indexOf('data-testid="installed-sources"'), html.indexOf('data-testid="available-sources"'));
  assert.match(installed, />Preview source</);
  assert.match(installed, />In testing</);
});

test("an installed development source stays under Installed when its maturity filter is off", async () => {
  const development = { ...reddit, publicTier: "development" as const };
  const html = await render(false, development, undefined, 0, {
    reddit: [{ connectionId: "c1", displayName: "My Reddit", latestImportFile: null, latestImportStatus: null, status: null, totalRecords: 3 }],
  });
  const installed = html.slice(html.indexOf('data-testid="installed-sources"'), html.indexOf('data-testid="available-sources"'));
  assert.ok(installed.includes(">My Reddit"));
  assert.ok(installed.includes(">Reddit"));
});

test("an existing source whose connector is absent from the catalog appears by its display name", async () => {
  const { SourceSetupCatalog } = await catalogModule;
  const html = renderToStaticMarkup(createElement(SourceSetupCatalog, {
    catalog: [],
    existingSourcesByConnector: {},
    uncataloguedSources: [{ connectorId: "seed-reddit", connectionId: "c9", displayName: "My Reddit archive" }],
    installCatalogTransientlyUnavailable: false,
    installLifecycleByConnector: {},
    query: "",
  }));
  const installed = html.slice(html.indexOf('data-testid="installed-sources"'), html.indexOf('data-testid="available-sources"'));
  assert.ok(installed.includes(">My Reddit archive"));
  assert.ok(installed.includes('href="/sources/seed-reddit?connection_id=c9"'));
});

test("a known-empty package catalog hides an unregistered connector with no package", async () => {
  const empty = await render(false);
  assert.doesNotMatch(empty, />Reddit</);
  assert.match(empty, /No data sources are available to add here\./);
  assert.doesNotMatch(empty, /No data sources match/);
  assert.match(await render(false, reddit, undefined, 0, {}, "calendar"), /No data sources match “calendar”\./);
});

// Brief decision 3: Enter cannot submit or reload because search is not inside a form.
test("catalog search renders without a form submission path", async () => {
  const html = await render(false);
  assert.match(html, /<input\b[^>]*type="search"/);
  assert.doesNotMatch(html, /<form(?:\s|>)/);
});

// RAISE-RULES 8: scan rendered sample states for banned customer-facing words outside folded Details.
test("sample catalog states keep banned technical words out of rendered copy", async () => {
  const demo = buildAddSourceDemoCatalog();
  const unavailableHost = {
    ...setupCapable,
    readiness: verdict("host_requirement_unmet", "configure"),
  };
  const installCatalog = browserPackage.catalog;
  assert.ok(installCatalog);
  const blockedLifecycle: ConnectorInstallLifecycle = {
    ...browserPackage,
    catalog: {
      ...installCatalog,
      bindings: { browser: { available: false, reason: "Browser unavailable here." } },
    },
  };
  const samples = [
    ["default demo catalog", await renderEntries(demo.catalog, { existingSourcesByConnector: demo.existingSourcesByConnector })],
    ["busy package catalog", await renderEntries([setupCapable], { installCatalogTransientlyUnavailable: true })],
    ["host-restricted source", await renderEntries([unavailableHost])],
    ["package host restriction", await renderEntries([setupCapable], { installLifecycleByConnector: { [setupCapable.connectorKey]: blockedLifecycle } })],
    ["existing account", await render(true, reddit, undefined, 0, {
      reddit: [{ connectionId: "connection-1", displayName: "Work account", latestImportFile: "export.zip", latestImportStatus: "Import complete", status: "Connected", totalRecords: 12 }],
    })],
  ] as const;
  for (const [name, html] of samples) assertNoBannedPageWords(html, name);
});

// Add-page repair decisions 1 and 2: existing accounts count as installed and keep one quiet source row.
test("an existing imported data source is one row with its details in one closed disclosure", async () => {
  const demo = buildAddSourceDemoCatalog();
  const amazon = demo.catalog.find((entry) => entry.connectorKey === "amazon");
  assert.ok(amazon);
  const html = await renderEntries([amazon], { existingSourcesByConnector: demo.existingSourcesByConnector });
  assert.match(html, /section aria-label="Installed"[\s\S]*data-testid="source-setup-amazon"/);
  assert.equal((html.match(/data-testid="source-setup-amazon"/g) ?? []).length, 1);
  assert.match(html, /Amazon household archive/);
  assert.match(html, /Import file/);
  assert.doesNotMatch(html, /Existing accounts|can receive another export|Package status unavailable/);
  const details = /<details class="group">([\s\S]*?)<\/details>/.exec(html)?.[0];
  assert.ok(details, "the source row should have one Details disclosure");
  assert.equal((html.match(/<details\b/g) ?? []).length, 1);
  assert.match(details, /Latest activity: accepted/);
  assert.match(details, /Import file: orders-2026-demo\.zip/);
  assert.doesNotMatch(details, /<details[^>]*\sopen(?:\s|=|>)/);
});

const INSTALL_BUTTON = />Install<\/button>/;
const UNAVAILABLE_FALSE = /data-row-unavailable="false"/;
const UNAVAILABLE_TRUE = /data-row-unavailable="true"/;
const UNAVAILABLE_DISCLOSURE = /data-testid="unavailable-connectors-disclosure"/;
const BROWSER_SETUP_LINK = /href="\/connect\/browser-session\//;
const INSTALL_OR_BROWSER_SETUP = />Install<\/button>|href="\/connect\/browser-session\//;
const NOT_INSTALLABLE = /Not installable: no setup path is available here\./;
const INSTALL_DISABLED = /data-testid="connector-install-disabled"/;
// Brief decision 6: count and label the folded unavailable group.
const CANNOT_ADD_HERE = /Can(?:'|&#x27;)t be added here \(1\)/;
const PLATFORM_COPY = /not available on this platform/;
const INSTALL_FIRST = /Install package first/;
const INSTALL_NEXT_STEP = /data-testid="connector-install-next-step"/;
const SKIPPED_NOTICE = /data-testid="install-skipped-notice"/;
const NEW_BROWSER_SETUP = /href="\/connect\/browser-session\/new-browser"/;

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

const verdict = (
  reason: NonNullable<ConnectorCatalogEntry["readiness"]>["reason"],
  action: NonNullable<ConnectorCatalogEntry["readiness"]>["action"],
  detail: string | null = null
): NonNullable<ConnectorCatalogEntry["readiness"]> => ({
  action,
  browserBound: true,
  connectorKey: "new-browser",
  detail,
  reason,
});
const READINESS_NOTE = /data-testid="connector-readiness-note"/;
const NOT_BUILT_YET = /Not built yet/;

test("published, uninstalled LinkedIn and Goodreads entries offer Install, not 'Not built yet'", async () => {
  // Brief decision 6: an available package is installable even before its runtime registration exists.
  for (const [connectorKey, displayName] of [["linkedin", "LinkedIn"], ["goodreads", "Goodreads"]] as const) {
    const html = await render(
      false,
      { ...unregisteredBrowser, connectorKey, displayName, readiness: verdict("not_installed", "install") },
      browserPackage
    );
    assert.match(html, INSTALL_BUTTON, connectorKey);
    assert.doesNotMatch(html, NOT_BUILT_YET, connectorKey);
    assert.doesNotMatch(html, READINESS_NOTE, connectorKey);
    assert.match(html, UNAVAILABLE_FALSE, connectorKey);
  }
});

// A browser connector's setup path comes from its package: before the reference
// has registered it there is no verdict, and installing is the step that lets
// the server decide. The page builds such entries from the manifest alone.
test("a manifest-only browser connector with a published package offers Install, not 'Not installable'", async () => {
  const { registrationStatus: _omitted, ...manifestOnly } = unregisteredBrowser;
  const entry = { ...manifestOnly, readiness: null };
  const html = await render(false, entry, browserPackage);
  assert.match(html, INSTALL_BUTTON);
  assert.doesNotMatch(html, NOT_INSTALLABLE);
  assert.match(html, UNAVAILABLE_FALSE);

  // While the package catalog is busy the offer is unknown, which is not "cannot install".
  const busy = await render(true, entry, browserPackage);
  assert.doesNotMatch(busy, INSTALL_BUTTON);
  assert.doesNotMatch(busy, NOT_INSTALLABLE);
  // Add-page repair decision 2: unknown package state is silent in the row; retry guidance stays at page level.
  assert.match(busy, /data-testid="connector-install-catalog-recovery"/);
  assert.doesNotMatch(busy, /Package availability is unknown/);
});

test("installing is not offered when the verdict says installing cannot make the connector runnable", async () => {
  for (const [reason, action] of [
    ["not_implemented", "unavailable"],
    ["host_requirement_unmet", "configure"],
    ["not_browser_bound", "unavailable"],
  ] as const) {
    const html = await render(false, { ...unregisteredBrowser, readiness: verdict(reason, action) }, browserPackage);
    assert.doesNotMatch(html, INSTALL_BUTTON, reason);
    assert.match(html, NOT_INSTALLABLE, reason);
  }
});

test("a development-tier manifest-only browser connector is not offered for install", async () => {
  const { registrationStatus: _omitted, ...manifestOnly } = unregisteredBrowser;
  const html = await render(false, { ...manifestOnly, publicTier: "development", readiness: null }, browserPackage);
  assert.doesNotMatch(html, INSTALL_BUTTON);
});

test("a verdict that blocks setup shows its reason and offers no account setup", async () => {
  const [installed] = parseConnectorInstallStatusResponse(connectorInstallStatusFixture).data;
  assert.ok(installed);
  assert.ok(browserPackage.catalog);
  const html = await render(
    false,
    {
      ...unregisteredBrowser,
      readiness: verdict("host_requirement_unmet", "configure", "No browser surface is configured."),
    },
    { catalog: { ...browserPackage.catalog, digest: installed.digest }, installed: { ...installed, connector_id: "new-browser" } }
  );
  assert.match(html, READINESS_NOTE);
  // DIRECTION.md, Values and words: use "data source" in customer copy.
  // RAISE-RULES 4: unavailable copy uses plain availability wording.
  assert.match(html, /This data source is not available on this server yet\./);
  assert.doesNotMatch(html, /No browser surface is configured/, "the server's diagnostic detail is not shown");
  assert.doesNotMatch(html, BROWSER_SETUP_LINK);
  assert.doesNotMatch(html, NOT_BUILT_YET);
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

test("a ready verdict offers account setup with no readiness note; a failed-verification verdict explains the repair", async () => {
  const [installed] = parseConnectorInstallStatusResponse(connectorInstallStatusFixture).data;
  assert.ok(installed);
  assert.ok(browserPackage.catalog);
  const lifecycle: ConnectorInstallLifecycle = {
    catalog: { ...browserPackage.catalog, digest: installed.digest },
    installed: { ...installed, connector_id: "new-browser" },
  };
  const setupReady = {
    ...unregisteredBrowser,
    disposition: "browser_collector_manual" as const,
    ownerActionable: true,
    registrationStatus: "registered" as const,
  };

  const ready = await render(false, { ...setupReady, readiness: verdict("runnable", "connect") }, lifecycle);
  assert.match(ready, NEW_BROWSER_SETUP);
  assert.doesNotMatch(ready, READINESS_NOTE);

  const needsRepair = await render(
    false,
    { ...unregisteredBrowser, readiness: verdict("artifact_invalid", "repair", "Digest mismatch.") },
    lifecycle
  );
  assert.match(needsRepair, READINESS_NOTE);
  assert.match(needsRepair, /failed verification\. Reinstall it to repair it\./);
  assert.doesNotMatch(needsRepair, /Digest mismatch/, "the server's diagnostic detail is not shown");
  assert.doesNotMatch(needsRepair, BROWSER_SETUP_LINK);
});

test("a verified package that declares no collection shows the placeholder note and no account setup", async () => {
  const [installed] = parseConnectorInstallStatusResponse(connectorInstallStatusFixture).data;
  assert.ok(installed);
  assert.ok(browserPackage.catalog);
  const html = await render(
    false,
    { ...unregisteredBrowser, readiness: verdict("not_implemented", "unavailable", "Declared by the package.") },
    { catalog: { ...browserPackage.catalog, digest: installed.digest }, installed: { ...installed, connector_id: "new-browser" } }
  );
  assert.match(html, READINESS_NOTE);
  // Brief decision 6: show the readiness fact in plain words when the server says not_implemented.
  assert.match(html, /This data source is a placeholder and does not collect data yet\./);
  assert.doesNotMatch(html, /Declared by the package/);
  assert.doesNotMatch(html, BROWSER_SETUP_LINK);
});

test("an explicit host restriction is displayed without offering Install", async () => {
  assert.ok(browserPackage.catalog);
  const html = await render(false, setupCapable, {
    ...browserPackage,
    catalog: {
      ...browserPackage.catalog,
      bindings: { browser: { available: false, reason: "Browser unavailable here." } },
    },
  });
  // Brief decision 6: explain the actual host restriction in plain words.
  // RAISE-RULES 4: unavailable copy does not use the banned word “run”.
  assert.match(html, /This data source is not available here: Browser unavailable here\./);
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
  // Add-page repair decision 2: the shared retry notice replaces row-level unknown-status copy.
  assert.match(html, /data-testid="connector-install-catalog-recovery"/);
  assert.doesNotMatch(html, /Package availability is unknown/);
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
  // Brief decision 1: use plain setup status wording.
  assert.match(pending, /Setup appears once the server is ready\./);
  assert.doesNotMatch(pending, BROWSER_SETUP_LINK, "the setup route answers 404 until the connector is registered");
  assert.doesNotMatch(pending, INSTALL_BUTTON);
  assert.match(pending, UNAVAILABLE_FALSE);

  const registered = await render(false, { ...setupCapable, registrationStatus: "registered" }, lifecycle);
  assert.doesNotMatch(registered, /Setup appears once the server is ready\./);
  assert.match(registered, NEW_BROWSER_SETUP);
});

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
