// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test, { mock } from "node:test";
import * as navigation from "next/navigation";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ConnectorCatalogEntry } from "../lib/connection-catalog.ts";

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

async function render(installCatalogTransientlyUnavailable: boolean): Promise<string> {
  const { SourceSetupCatalog } = await catalogModule;
  return renderToStaticMarkup(
    createElement(SourceSetupCatalog, {
      action: "/sources/add",
      catalog: [reddit],
      installCatalogTransientlyUnavailable,
      // The page builds this from the empty catalog a busy snapshot returns.
      installLifecycleByConnector: {},
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
