// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { classifyConnectorIntentModality } from "pdpp-reference-implementation/connection-setup-plan";
import { type BindingSource, browserConnectSupport } from "./browser-connect-support.ts";
import { isSupportedBrowserCollectorConnector } from "./connection-modality.ts";
import { parseConnectorInstallStatusResponse } from "./connector-install-contract.ts";
import { connectorInstallStatusFixture } from "./connector-install-fixtures.ts";

const BROWSER_SESSION_DIR = new URL("../connect/browser-session/[connectorId]/", import.meta.url);

// Installed packages as the connector-install status route reports them. The
// last one is a catalog-only browser-bound connector that no key list in the
// console knows about.
const installed: BindingSource[] = [
  ...parseConnectorInstallStatusResponse(connectorInstallStatusFixture).data,
  { bindings: { browser: { available: true }, network: { available: true } }, connector_id: "reddit" },
  { bindings: { browser: { available: true } }, connector_id: "https://registry.pdpp.dev/connectors/amazon" },
  { bindings: { browser: { available: true } }, connector_id: "acme-shop" },
];

function isBrowserBinding(source: BindingSource): boolean {
  return (
    classifyConnectorIntentModality({ connector_id: source.connector_id, runtime_requirements: { bindings: source.bindings } }) ===
    "browser_bound"
  );
}

test("every installed browser-bound connector can add an account", () => {
  const browserBound = installed.filter(isBrowserBinding);
  assert.equal(browserBound.length, 3);
  for (const source of browserBound) {
    assert.deepEqual(browserConnectSupport(source.connector_id, installed), { browserBound: true, canAddAccount: true }, source.connector_id);
  }
});

test("an installed browser-bound connector outside the old key list can add an account", () => {
  // The old console gate read a connector-key list, which rejected this one.
  assert.equal(isSupportedBrowserCollectorConnector("acme-shop"), false);
  assert.equal(browserConnectSupport("acme-shop", installed).canAddAccount, true);
});

test("a registry-URL connector id matches the installed bare key", () => {
  assert.equal(browserConnectSupport("https://registry.pdpp.dev/connectors/reddit", installed).canAddAccount, true);
  assert.equal(browserConnectSupport("amazon", installed).canAddAccount, true);
});

test("connectors without a browser binding do not use the browser-session flow", () => {
  assert.deepEqual(browserConnectSupport("github", installed), { browserBound: false, canAddAccount: false });
  assert.deepEqual(browserConnectSupport("imessage", installed), { browserBound: false, canAddAccount: false });
  assert.deepEqual(browserConnectSupport("not-installed", installed), { browserBound: false, canAddAccount: false });
  assert.deepEqual(browserConnectSupport("", installed), { browserBound: false, canAddAccount: false });
  assert.deepEqual(browserConnectSupport(null, installed), { browserBound: false, canAddAccount: false });
});

test("a known scaffold stays browser-bound but cannot add an account", () => {
  const sources = [{ bindings: { browser: {} }, connector_id: "anthropic" }];
  assert.deepEqual(browserConnectSupport("anthropic", sources), { browserBound: true, canAddAccount: false });
});

test("browser-session routes gate on the binding-derived support, not a key list", () => {
  for (const file of ["page.tsx", "start/route.ts", "launch/page.tsx", "launch/start/route.ts", "launch/recover/route.ts"]) {
    const src = readFileSync(new URL(file, BROWSER_SESSION_DIR), "utf8");
    assert.match(src, /loadBrowserConnectSupport\(connectorId\)/, file);
    assert.doesNotMatch(src, /isSupportedBrowserCollectorConnector|isBrowserBoundConnector/, file);
  }
});
