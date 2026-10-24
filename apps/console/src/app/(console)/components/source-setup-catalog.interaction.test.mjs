// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Drives the real catalog component in a DOM: typing filters the list in the
// browser and mirrors the query into the URL without a navigation.

import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { JSDOM } from "jsdom";
import * as navigation from "next/navigation";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  pretendToBeVisual: true,
  url: "http://localhost/sources/add",
});
for (const name of [
  "window",
  "self",
  "document",
  "navigator",
  "HTMLElement",
  "Element",
  "Node",
  "Text",
  "Event",
  "KeyboardEvent",
  "MouseEvent",
  "CustomEvent",
  "MutationObserver",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
]) {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    value: name === "window" || name === "self" ? dom.window : dom.window[name],
    writable: true,
  });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = (query) => ({
  addEventListener() {},
  addListener() {},
  matches: false,
  media: query,
  removeEventListener() {},
  removeListener() {},
});
const React = await import("react");
globalThis.React = React;
mock.module("server-only", { exports: {} });
const navigationExports = { ...navigation, useRouter: () => ({ refresh() {} }) };
mock.module("next/navigation", { exports: { ...navigationExports, default: navigationExports } });
const { render, fireEvent, cleanup, within, act } = await import("@testing-library/react");
const { SourceSetupCatalog } = await import("./source-setup-catalog.tsx");

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/sources/add");
});

function entry(connectorKey, displayName, publicTier = "supported") {
  return {
    acquisitionPaths: [],
    connectorKey,
    deploymentReadiness: { blockers: [], guidance: null, state: "ready" },
    displayName,
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
    registrationStatus: "registered",
    runbookPath: null,
    setupDescription: null,
    setupHelpText: null,
    setupModality: "static_secret",
    supportState: "supported",
  };
}

const catalog = [entry("alpha", "Alpha"), entry("beta", "Beta"), entry("gamma", "Gamma", "preview")];
const owned = {
  beta: [
    {
      connectionId: "c1",
      displayName: "Beta account",
      latestImportFile: null,
      latestImportStatus: null,
      status: "active",
      totalRecords: 12,
    },
  ],
};

const rows = (container) => [...container.querySelectorAll('[data-testid^="source-setup-"][data-tier]')].map((el) => el.dataset.testid);

test("typing filters the loaded catalog and updates the URL without a page load", () => {
  const view = render(React.createElement(SourceSetupCatalog, { catalog, query: "" }));
  assert.deepEqual(rows(view.container), ["source-setup-alpha", "source-setup-beta", "source-setup-gamma"]);

  const input = view.getByLabelText("Search data sources");
  fireEvent.change(input, { target: { value: "gam" } });

  assert.deepEqual(rows(view.container), ["source-setup-gamma"]);
  assert.equal(window.location.search, "?source_q=gam", "the query is mirrored into the URL");
  assert.equal(view.container.querySelector("form[action]"), null, "search is not a navigating form");

  fireEvent.change(input, { target: { value: "" } });
  assert.equal(window.location.search, "", "clearing the query clears the URL parameter");
  assert.equal(rows(view.container).length, 3);
});

test("submitting the search form does not navigate", () => {
  const view = render(React.createElement(SourceSetupCatalog, { catalog, query: "" }));
  const form = view.container.querySelector("form");
  const notCancelled = fireEvent.submit(form);
  assert.equal(notCancelled, false, "submit is default-prevented");
});

test("sources the owner already has are listed apart from the ones to add", () => {
  const view = render(React.createElement(SourceSetupCatalog, { catalog, existingSourcesByConnector: owned, query: "" }));
  const yours = view.getByTestId("your-sources");
  assert.deepEqual(rows(yours), ["source-setup-beta"]);
  assert.ok(within(view.container).getByText("Your sources"));
  assert.ok(within(view.container).getByText("Add a source"));
  const addList = [...view.container.querySelectorAll('[data-testid="source-setup-list"]')].at(-1);
  assert.deepEqual(rows(addList), ["source-setup-alpha", "source-setup-gamma"]);
});

test("a source needing an update is marked in Your sources", () => {
  const lifecycle = {
    beta: {
      catalog: { connector_id: "beta", connector_key: "beta", digest: "sha256:new", latest: true, version: "2.0.0", bindings: {} },
      installed: { connector_id: "beta", digest: "sha256:old", version: "1.0.0", bindings: {} },
    },
  };
  const view = render(
    React.createElement(SourceSetupCatalog, {
      catalog,
      existingSourcesByConnector: owned,
      installLifecycleByConnector: lifecycle,
      query: "",
    })
  );
  const badge = within(view.getByTestId("your-sources")).getByTestId("source-update-badge");
  assert.match(badge.textContent, /Update available/);
  assert.match(view.container.textContent, /1 needs an update/);
});

test("the works-on-this-device filter removes rows with no setup path", () => {
  const scaffold = { ...entry("ghost", "Ghost", "preview"), disposition: "unknown_unsupported", ownerActionable: false };
  const view = render(React.createElement(SourceSetupCatalog, { catalog: [...catalog, scaffold], query: "" }));
  assert.ok(view.getByTestId("unavailable-connectors-disclosure"));
  fireEvent.click(view.getByTestId("works-here-filter"));
  assert.equal(view.queryByTestId("unavailable-connectors-disclosure"), null);
});

test("back/forward and a new source_q prop replace the query shown", () => {
  window.history.replaceState(null, "", "/sources/add?source_q=alp");
  const view = render(React.createElement(SourceSetupCatalog, { catalog, query: "alp" }));
  assert.deepEqual(rows(view.container), ["source-setup-alpha"]);

  const input = view.getByLabelText("Search data sources");
  fireEvent.change(input, { target: { value: "gam" } });
  assert.deepEqual(rows(view.container), ["source-setup-gamma"]);

  // Back: the browser restores the earlier URL and fires popstate.
  window.history.replaceState(null, "", "/sources/add?source_q=alp");
  act(() => {
    window.dispatchEvent(new window.PopStateEvent("popstate"));
  });
  assert.equal(input.value, "alp");
  assert.deepEqual(rows(view.container), ["source-setup-alpha"]);

  // Forward to a URL with no query clears it.
  window.history.replaceState(null, "", "/sources/add");
  act(() => {
    window.dispatchEvent(new window.PopStateEvent("popstate"));
  });
  assert.equal(input.value, "");
  assert.equal(rows(view.container).length, 3);

  // Navigation that keeps the component mounted passes a new prop.
  view.rerender(React.createElement(SourceSetupCatalog, { catalog, query: "bet" }));
  assert.equal(input.value, "bet");
  assert.deepEqual(rows(view.container), ["source-setup-beta"]);
});
