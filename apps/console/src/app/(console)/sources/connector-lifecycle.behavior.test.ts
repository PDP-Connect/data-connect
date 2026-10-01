// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { mock, test } from "node:test";
import * as React from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

let resetCalls = 0;
let runCalls = 0;
let resetFailure: Error | null = null;

const component = (async () => {
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
  mock.module("next/navigation", {
    namedExports: {
      redirect: () => {},
      usePathname: () => "/sources",
      useRouter: () => ({ refresh: () => {} }),
    },
  });
  mock.module("next/cache", { namedExports: { revalidatePath: () => {} } });
  mock.module(new URL("../lib/dashboard-access.ts", import.meta.url).href, {
    namedExports: { requireDashboardAccess: async () => {} },
  });
  mock.module(new URL("../lib/connection-control-result.ts", import.meta.url).href, {
    namedExports: { profilePurgeSentence: () => "" },
  });
  mock.module(new URL("../lib/delete-connection-with-run-cancel.ts", import.meta.url).href, {
    namedExports: { deleteConnectionWithRunCancel: async () => ({ status: "deleted" }) },
  });
  mock.module(new URL("../lib/ref-client.ts", import.meta.url).href, {
    namedExports: { listConnectorSummaries: async () => ({ data: [] }) },
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
      resetConnectionState: async () => {
        resetCalls += 1;
        if (resetFailure) throw resetFailure;
        return { run_id: "run-reset-1" };
      },
      resumeConnection: async () => ({}),
      resumeConnectionSchedule: async () => ({}),
      resumeConnectorSchedule: async () => ({}),
      revokeConnection: async () => ({}),
      runConnectionNow: async () => {
        runCalls += 1;
        return { run_id: "run-extra" };
      },
      runConnectorNow: async () => ({}),
      saveConnectionSchedule: async () => ({}),
      saveConnectorSchedule: async () => ({}),
      setConnectionDisplayName: async () => ({}),
    },
  });
  return { ConnectionDangerZone: (await import("./[connector]/connection-danger-zone.tsx")).ConnectionDangerZone, dom };
})();

test("reset control requires confirmation and reports refusal or success", async () => {
  const { ConnectionDangerZone, dom } = await component;
  const container = dom.window.document.createElement("div");
  dom.window.document.body.append(container);
  const root = createRoot(container);
  resetCalls = 0;
  runCalls = 0;
  resetFailure = new Error("A collection run is already active.");
  try {
    await act(async () => root.render(createElement(ConnectionDangerZone, { connectionId: "source-1" })));
    const button = [...container.querySelectorAll("button")].find((item) => item.textContent?.trim() === "Reset and re-sync");
    assert.ok(button);
    assert.equal(button.disabled, true);
    const checkbox = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((input) =>
      input.closest("label")?.textContent?.includes("Clear sync state and start a full sync")
    );
    assert.ok(checkbox);
    await act(async () => checkbox.click());
    assert.equal(button.disabled, false);
    await act(async () => button.click());
    assert.equal(resetCalls, 1);
    assert.equal(runCalls, 0);
    assert.equal(container.querySelector('[role="alert"]')?.textContent, "A collection run is already active.");

    resetFailure = null;
    await act(async () => button.click());
    assert.equal(resetCalls, 2);
    assert.equal(runCalls, 0);
    assert.match(container.querySelector('[role="status"]')?.textContent ?? "", /Full sync started/);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
