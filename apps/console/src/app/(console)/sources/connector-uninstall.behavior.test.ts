// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { mock, test } from "node:test";
import * as React from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { PackageRow } from "../settings/packages/package-rows-model.ts";

let uninstallResult: { ok: boolean; message?: string } = { message: "Connector still has sources.", ok: false };
let uninstallCalls = 0;
let refreshCalls = 0;
let confirmResult = false;
let updateCalls = 0;

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
      updateConnectorAction: async () => {
        updateCalls += 1;
        return { ok: true };
      },
    },
  });
  const { PackageTable } = await import("../settings/packages/package-table.tsx");
  return { PackageTable, dom };
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

const row: PackageRow = {
  canUninstall: true,
  connectorId: "github",
  connectorKey: "github",
  displayName: "GitHub",
  icon: null,
  updateTo: null,
  version: "1.0.0",
};

// Design "Data source packages": Uninstall asks first, a refusal shows plain copy with the server's words one step away.
test("package table confirms uninstall and displays refusal or success without optimistic removal", async () => {
  const { PackageTable } = await components;
  uninstallCalls = 0;
  refreshCalls = 0;
  confirmResult = false;
  await mounted(createElement(PackageTable, { rows: [row] }), async (container) => {
    const uninstall = button(container, "Uninstall");
    await act(async () => uninstall.click());
    assert.equal(uninstallCalls, 0);

    confirmResult = true;
    uninstallResult = { message: "Connector still has sources.", ok: false };
    await act(async () => uninstall.click());
    assert.equal(uninstallCalls, 1);
    assert.match(container.querySelector('[role="alert"]')?.textContent ?? "", /Couldn't complete this\. Try again\./);
    assert.ok([...container.querySelectorAll("details")].some((details) => details.textContent?.includes("Something went wrong.")));
    assert.doesNotMatch(container.textContent ?? "", /Connector still has sources/);
    assert.ok(container.querySelector('[data-testid="package-row-github"]'));

    uninstallResult = { ok: true };
    await act(async () => uninstall.click());
    assert.equal(uninstallCalls, 2);
    assert.equal(refreshCalls, 1);
  });
});

test("package table offers Update only when a newer version exists, and it calls the update action", async () => {
  const { PackageTable } = await components;
  updateCalls = 0;
  await mounted(createElement(PackageTable, { rows: [{ ...row, updateTo: "2.0.0" }] }), async (container) => {
    await act(async () => button(container, "Update").click());
    assert.equal(updateCalls, 1);
  });
  await mounted(createElement(PackageTable, { rows: [row] }), async (container) => {
    assert.equal([...container.querySelectorAll("button")].some((item) => item.textContent?.trim() === "Update"), false);
  });
  await mounted(createElement(PackageTable, { rows: [{ ...row, canUninstall: false }] }), async (container) => {
    assert.equal([...container.querySelectorAll("button")].some((item) => item.textContent?.trim() === "Uninstall"), false);
  });
});
