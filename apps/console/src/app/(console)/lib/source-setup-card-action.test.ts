// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { ConnectorCatalogEntry } from "./connection-catalog.ts";
import { sourceSetupAction, sourceSetupCardAction } from "./source-setup-presentation.ts";

const APP_DIR = fileURLToPath(new URL("../../", import.meta.url));

/** URL patterns of every page in the console app dir. Route groups such as `(console)` are not URL segments. */
function consolePagePatterns(): RegExp[] {
  const patterns: RegExp[] = [];
  const walk = (dir: string, segments: string[]) => {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      if (item.isDirectory()) {
        const group = item.name.startsWith("(") && item.name.endsWith(")");
        walk(`${dir}/${item.name}`, group ? segments : [...segments, item.name]);
      } else if (item.name === "page.tsx") {
        const source = segments.map((segment) => (segment.startsWith("[") ? "/[^/]+" : `/${segment}`)).join("");
        patterns.push(new RegExp(`^${source || "/"}$`));
      }
    }
  };
  walk(APP_DIR, []);
  return patterns;
}

function hrefResolves(href: string): boolean {
  const path = new URL(href, "http://console.test").pathname;
  return consolePagePatterns().some((pattern) => pattern.test(path));
}

function entry(overrides: Partial<ConnectorCatalogEntry>): ConnectorCatalogEntry {
  return {
    acquisitionPaths: [],
    connectorKey: "slack",
    deploymentReadiness: { blockers: [], state: "ready" },
    displayName: "Slack",
    disposition: "static_secret_connect",
    externalDocs: [],
    icon: null,
    isKnownScaffold: false,
    listingNote: null,
    modality: "api_network",
    nextStepKind: "capture_static_secret",
    proofGate: null,
    publicTier: "supported",
    refreshPolicyRationale: null,
    runbookPath: null,
    setupDescription: null,
    setupHelpText: null,
    setupModality: "static_secret",
    supportState: "supported",
    ...overrides,
  } as ConnectorCatalogEntry;
}

test("an unregistered connector with no package gets no Add account link", () => {
  // A local manifest lists Slack, but the reference has not registered it and
  // the package catalog has no artifact. Its static-secret page answers 404.
  const slack = entry({});
  assert.equal(sourceSetupAction(slack)?.href, "/connect/static-secret/slack");
  assert.equal(sourceSetupCardAction(slack, "not_listed", false), null);
});

test("a registered connector keeps its Add account link without a package", () => {
  const slack = entry({ registrationStatus: "registered" });
  assert.deepEqual(sourceSetupCardAction(slack, "not_listed", false), {
    href: "/connect/static-secret/slack",
    label: "Add account",
  });
  assert.equal(sourceSetupCardAction(entry({}), null, false)?.href, "/connect/static-secret/slack");
  assert.equal(sourceSetupCardAction(entry({}), "active", false)?.href, "/connect/static-secret/slack");
});

test("a package that must be installed first, or whose state is unknown, gets no setup link", () => {
  const registered = entry({ registrationStatus: "registered" });
  assert.equal(sourceSetupCardAction(registered, "not_installed", false), null);
  assert.equal(sourceSetupCardAction(registered, "active", true), null);
});

test("every setup action href resolves to a console page", () => {
  const cases: Partial<ConnectorCatalogEntry>[] = [
    { disposition: "static_secret_connect" },
    { disposition: "static_secret_experimental", supportState: "experimental" },
    { disposition: "local_collector_enroll", enrollmentKey: "claude_code", setupModality: "local_collector" },
    { disposition: "manual_upload_connect", setupModality: "manual_or_upload" },
    { disposition: "browser_collector_manual", enrollmentKey: "reddit", modality: "browser_bound", setupModality: "browser_bound" },
    { disposition: "provider_auth_connect", setupModality: "provider_authorization" },
  ];
  for (const overrides of cases) {
    const action = sourceSetupCardAction(entry({ registrationStatus: "registered", ...overrides }), "active", false);
    assert.ok(action, String(overrides.disposition));
    assert.ok(hrefResolves(action.href), `${overrides.disposition}: ${action.href}`);
  }
  assert.equal(hrefResolves("/connect/no-such-flow/slack"), false);
});
