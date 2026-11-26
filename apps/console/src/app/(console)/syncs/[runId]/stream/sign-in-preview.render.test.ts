// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { JSDOM } from "jsdom";
import * as React from "react";
import * as navigation from "next/navigation";
import { flowPreview, previewFacts, previewStatus, previewStates } from "../../../connect/flow-preview.ts";
import { bannedCopyProblems } from "../../../sources/add/banned-copy.ts";
const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "http://localhost/" });
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "Element", "Node", "Text", "Event", "MouseEvent", "MutationObserver", "getComputedStyle"] as const) Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
Object.assign(globalThis, { React, self: dom.window, IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: (fn: FrameRequestCallback) => setTimeout(() => fn(0), 0), cancelAnimationFrame: clearTimeout });
dom.window.matchMedia = (media: string) => ({ media, matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }) as unknown as MediaQueryList;
mock.module("server-only", { namedExports: {} });
const visited: string[] = [];
const router = { refresh() {}, replace(href: string) { visited.push(href); } };
mock.module("next/navigation", { namedExports: { ...navigation, useRouter: () => router } });
mock.module("../../../components/recordroom-shell-with-palette.tsx", { namedExports: { RecordroomShellWithPalette: ({ children }: { children: React.ReactNode }) => React.createElement("main", { "data-testid": "normal-frame" }, children) } });
let root: import("react-dom/client").Root;
let SignInPreview: typeof import("./sign-in-preview.tsx").SignInPreview;
let LaunchPresentation: typeof import("../../../connect/browser-session/[connectorId]/launch/launch-panel.tsx").LaunchPresentation;
let FirstSyncBody: typeof import("../../../connect/status/[connectionId]/first-sync-body.tsx").FirstSyncBody;
let firstSyncOutcome: typeof import("../../../connect/status/[connectionId]/first-sync-outcome.ts").firstSyncOutcome;
test.before(async () => {
  const { createRoot } = await import("react-dom/client");
  ({ SignInPreview } = await import("./sign-in-preview.tsx"));
  ({ LaunchPresentation } = await import("../../../connect/browser-session/[connectorId]/launch/launch-panel.tsx"));
  ({ FirstSyncBody } = await import("../../../connect/status/[connectionId]/first-sync-body.tsx"));
  ({ firstSyncOutcome } = await import("../../../connect/status/[connectionId]/first-sync-outcome.ts"));
  const host = dom.window.document.getElementById("root");
  assert.ok(host);
  root = createRoot(host);
});
async function render(view: React.ReactNode) { await React.act(async () => { root.render(view); }); }

test("practice draws the real full-screen dialog, controls and panel without a browser", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("practice attempted a network call"); };
  try {
    for (const state of previewStates.browser.filter(state => state.startsWith("browser-") || state === "stop-question")) {
      await render(React.createElement(SignInPreview, { key: state, state }));
      const dialog = dom.window.document.querySelector('[role="dialog"]');
      assert.ok(dialog, state);
      assert.match(dialog.className, /pdpp-stream-dialog/);
      assert.match(dialog.textContent ?? "", /Sample page, not a real sign-in/);
      assert.equal(dialog.querySelectorAll("canvas,video").length, 0);
      assert.ok(dialog.querySelector('button[aria-label="Stop signing in"]'));
      assert.deepEqual(bannedCopyProblems(dialog.innerHTML), [], state);
      const panel = dialog.querySelector('form[aria-label="Finish signing in"]');
      if (state === "stop-question") assert.ok(dialog.querySelector('[role="alertdialog"]'));
      else {
        assert.match(panel?.querySelector("h1")?.textContent ?? "", /Sign in to Northwind/);
        assert.equal(dialog.querySelectorAll("h1").length, 1);
        if (state === "browser-code") assert.ok(panel?.querySelector('input[autocomplete="one-time-code"]'));
        if (state === "browser-step") assert.match(panel?.textContent ?? "", /Done/);
        if (state === "browser-code-rejected") assert.match(panel?.querySelector('[role="alert"]')?.textContent ?? "", /did not accept that code/);
      }
    }
  } finally { globalThis.fetch = originalFetch; await render(null); }
});

test("Page A, Page B and Page C put the step below the heading in the same header", async () => {
  const views = [
    React.createElement(LaunchPresentation, { connectorId: "northwind", displayName: "Northwind", onRetry() {}, state: { starting: true, networkLost: false, error: null } }),
    ...["card", "opening", "signed-in", "needs-details", "approve"].map(state => React.createElement(SignInPreview, { key: state, state })),
    React.createElement(FirstSyncBody, { connectionId: flowPreview.connectionId, connectorId: "northwind", name: "Northwind", outcome: firstSyncOutcome(previewStatus("copying-nothing-yet"), "Northwind", previewFacts("copying-nothing-yet")), resumeAction() {} }),
  ];
  for (const view of views) {
    await render(view);
    const header = dom.window.document.querySelector("header");
    assert.ok(header);
    assert.ok(header.querySelector("h1"));
    assert.match(header.innerHTML, /<\/h1>[\s\S]*Step [12] of 2/);
  }
  await render(React.createElement(SignInPreview, { state: "needs-details" }));
  assert.ok(dom.window.document.querySelector('[data-testid="normal-frame"] form input[type="password"]'));
  assert.equal(dom.window.document.querySelectorAll("h1,h2").length, 1);
  assert.match(dom.window.document.body.textContent ?? "", /for this sign-in only. It does not keep them/);
  await render(null);
});

test.after(async () => { await React.act(async () => root.unmount()); dom.window.close(); });
