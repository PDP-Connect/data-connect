// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { mock, test } from "node:test";
import * as React from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { ConnectorInstallRowModel } from "../lib/connector-install-presentation.ts";

let uninstallResult: { ok: boolean; message?: string } = { message: "Connector still has sources.", ok: false };
let uninstallCalls = 0;
let refreshCalls = 0;
let confirmResult = false;

const components = (async () => {
  Object.assign(globalThis, { React });
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
  Object.assign(globalThis, {
    document: dom.window.document,
    Event: dom.window.Event,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    MouseEvent: dom.window.MouseEvent,
    Node: dom.window.Node,
    window: dom.window,
  });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
  dom.window.confirm = () => confirmResult;
  mock.module("next/navigation", {
    namedExports: {
      usePathname: () => "/sources",
      redirect: () => {},
      useRouter: () => ({ refresh: () => refreshCalls++ }),
    },
  });
  mock.module("next/cache", {
    namedExports: { revalidatePath: () => {} },
  });
  mock.module(new URL("../lib/dashboard-access.ts", import.meta.url).href, {
    namedExports: { requireDashboardAccess: async () => {} },
  });
  mock.module(new URL("../lib/connection-control-result.ts", import.meta.url).href, {
    namedExports: { profilePurgeSentence: () => "" },
  });
  mock.module(new URL("../lib/delete-connection-with-run-cancel.ts", import.meta.url).href, {
    namedExports: { deleteConnectionWithRunCancel: async () => ({ status: "deleted" }) },
  });
  mock.module(new URL("../lib/operator-runs.ts", import.meta.url).href, {
    namedExports: {
      cancelRun: async () => ({}),
      deleteConnection: async () => ({}),
      deleteConnectionSchedule: async () => ({}),
      deleteConnectorSchedule: async () => ({}),
      pauseConnection: async () => ({}),
      pauseConnectionSchedule: async () => ({}),
      pauseConnectorSchedule: async () => ({}),
      purgeConnectionBrowserProfile: async () => ({}),
      reactivateConnection: async () => ({}),
      resumeConnection: async () => ({}),
      resumeConnectionSchedule: async () => ({}),
      resumeConnectorSchedule: async () => ({}),
      revokeConnection: async () => ({}),
      runConnectorNow: async () => ({}),
      saveConnectionSchedule: async () => ({}),
      saveConnectorSchedule: async () => ({}),
      setConnectionDisplayName: async () => ({}),
    },
  });
  mock.module(new URL("./add/connector-install-actions.ts", import.meta.url).href, {
    namedExports: {
      installConnectorAction: async () => ({ ok: true }),
      uninstallConnectorAction: async () => {
        uninstallCalls += 1;
        return uninstallResult;
      },
      updateConnectorAction: async () => ({ ok: true }),
    },
  });
  const { ConnectorInstallRow } = await import("./add/connector-install-row.tsx");
  return { ConnectorInstallRow, dom };
})();

async function mounted<T>(element: ReturnType<typeof createElement>, run: (container: HTMLElement) => Promise<T>) {
  const { dom } = await components;
  const container = dom.window.document.createElement("div");
  dom.window.document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(element));
    return await run(container);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find((item) => item.textContent?.trim() === label);
  assert.ok(found, `expected button: ${label}`);
  return found;
}

test("connector row confirms uninstall and displays refusal or success without optimistic removal", async () => {
  const { ConnectorInstallRow } = await components;
  const model = {
    action: null,
    activationLabel: "Installed",
    activationState: "active",
    connectorId: "github",
    connectorKey: "github",
    hostBlockReason: null,
    installedDigest: "sha256:abc…xyz",
    installedDigestFull: "sha256:abcdef",
    installedVersion: "1.0.0",
    targetVersion: null,
    tier: "supported",
  } as ConnectorInstallRowModel;
  uninstallCalls = 0;
  refreshCalls = 0;
  confirmResult = false;
  await mounted(createElement(ConnectorInstallRow, { model }), async (container) => {
    const uninstall = button(container, "Uninstall");
    await act(async () => uninstall.click());
    assert.equal(uninstallCalls, 0);
    assert.equal(container.querySelector('[data-testid="connector-package-status"]')?.textContent, "Installed");

    confirmResult = true;
    uninstallResult = { message: "Connector still has sources.", ok: false };
    await act(async () => uninstall.click());
    assert.equal(uninstallCalls, 1);
    // RAISE-RULES 4: keep raw server error text in Details and show fixed plain copy in the row.
    assert.equal(container.querySelector('[role="alert"]')?.textContent, "Couldn't complete this action. Try again.");
    assert.ok([...container.querySelectorAll("details")].some((details) => details.textContent?.includes("Connector still has sources.")));
    assert.equal(container.querySelector('[data-testid="connector-package-status"]')?.textContent, "Installed");

    uninstallResult = { ok: true };
    await act(async () => uninstall.click());
    assert.equal(uninstallCalls, 2);
    assert.equal(container.querySelector('[role="status"]')?.textContent, "Uninstall complete. Refreshing status…");
    assert.equal(refreshCalls, 1);
  });
});

test("Add-page package controls use explicit primary and Details presentations", async () => {
  const { ConnectorInstallRow } = await components;
  const installModel = {
    action: { digest: "sha256:target", kind: "install", version: "1.0.0" },
    activationLabel: "Available",
    activationState: "not_installed",
    connectorId: "github",
    connectorKey: "github",
    hostBlockReason: null,
    installedDigest: null,
    installedDigestFull: null,
    installedVersion: null,
    targetVersion: "1.0.0",
    tier: "supported",
  } as ConnectorInstallRowModel;
  await mounted(createElement(ConnectorInstallRow, { model: installModel, presentation: "primary-action" }), async (container) => {
    assert.equal(container.querySelectorAll("button").length, 1);
    button(container, "Install");
    assert.equal(container.querySelector('[data-testid="connector-package-status"]'), null);
    assert.equal(container.querySelector("details"), null);
  });

  const updateModel = {
    ...installModel,
    action: { digest: "sha256:target", kind: "update", version: "2.0.0" },
    activationLabel: "Update available",
    activationState: "update_available",
    installedDigest: "sha256:old",
    installedDigestFull: "sha256:old-full",
    installedVersion: "1.0.0",
    targetVersion: "2.0.0",
  } as ConnectorInstallRowModel;
  // Add-page repair decision 2: package status and secondary controls stay in the one Details fold.
  await mounted(createElement(ConnectorInstallRow, { model: updateModel, presentation: "details-actions" }), async (container) => {
    assert.equal(container.querySelectorAll("button").length, 2);
    button(container, "Update");
    button(container, "Uninstall");
    assert.equal(container.querySelector('[data-testid="connector-package-status"]'), null);
    assert.equal(container.querySelector("details"), null);
  });
  await mounted(createElement(ConnectorInstallRow, { model: updateModel, presentation: "uninstall-only" }), async (container) => {
    assert.equal(container.querySelectorAll("button").length, 1);
    button(container, "Uninstall");
  });
});
