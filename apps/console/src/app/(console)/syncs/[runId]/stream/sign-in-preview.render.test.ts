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
let ResolvedSurface: typeof import("./stream-viewer.tsx").ResolvedSurface;
let SignInPreview: typeof import("./sign-in-preview.tsx").SignInPreview;
let LaunchPresentation: typeof import("../../../connect/browser-session/[connectorId]/launch/launch-panel.tsx").LaunchPresentation;
let FirstSyncBody: typeof import("../../../connect/status/[connectionId]/first-sync-body.tsx").FirstSyncBody;
let firstSyncOutcome: typeof import("../../../connect/status/[connectionId]/first-sync-outcome.ts").firstSyncOutcome;
test.before(async () => {
  const { createRoot } = await import("react-dom/client");
  ({ ResolvedSurface } = await import("./stream-viewer.tsx"));
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
    React.createElement(FirstSyncBody, { connectionId: flowPreview.connectionId, connectorId: "northwind", name: "Northwind", outcome: firstSyncOutcome(previewStatus("copying"), "Northwind", previewFacts("copying")), resumeAction() {} }),
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

test("copying has no live counts and uses the same moving mark as opening", async () => {
  for (const state of ["copying"]) {
    await render(React.createElement(FirstSyncBody, { connectionId: flowPreview.connectionId, connectorId: "northwind", name: "Northwind", outcome: firstSyncOutcome(previewStatus(state), "Northwind", previewFacts(state)), resumeAction() {} }));
    assert.doesNotMatch(dom.window.document.body.textContent ?? "", /So far|See what has arrived/);
    assert.ok(dom.window.document.querySelector('[role="status"] .animate-spin'));
  }
  await render(null);
});

test("all page practice states use honest copy and the plain card has its fallback", async () => {
  for (const state of previewStates.browser.filter(state => !state.startsWith("browser-") && state !== "stop-question")) {
    await render(React.createElement(SignInPreview, { key: state, state }));
    assert.deepEqual(bannedCopyProblems(dom.window.document.body.innerHTML), [], state);
    if (state === "card-plain") assert.match(dom.window.document.body.textContent ?? "", /This is Northwind's own sign-in page/);
    if (state === "approve") assert.match(dom.window.document.body.textContent ?? "", /Northwind app on your phone/);
    if (state === "needs-details-rejected") assert.match(dom.window.document.querySelector('[role="alert"]')?.textContent ?? "", /did not accept those sign-in details/);
  }
  await render(React.createElement(SignInPreview, { key: "code", state: "browser-code" }));
  let dialog = dom.window.document.querySelector('[role="dialog"]');
  const hide = dialog?.querySelector('button[aria-label="Hide instructions"]');
  assert.ok(hide);
  await React.act(async () => { hide.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
  dialog = dom.window.document.querySelector('[role="dialog"]');
  assert.equal(dialog?.querySelector("h1"), null);
  const show = Array.from(dialog?.querySelectorAll("button") ?? []).find(button => button.textContent?.includes("Show instructions"));
  assert.ok(show);
  await React.act(async () => { show.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
  assert.ok(dialog?.querySelector("h1"));
  await render(null);
});

test("the real signed-in page continues after two seconds or immediately on Continue", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  visited.length = 0;
  const href = "/connect/status/sample-account?run_id=sample-copy";
  await render(React.createElement(ResolvedSurface, { connector: flowPreview.connector, runId: flowPreview.runId, statusHref: href }));
  await React.act(async () => { t.mock.timers.tick(1999); });
  assert.deepEqual(visited, []);
  await React.act(async () => { t.mock.timers.tick(1); });
  assert.deepEqual(visited, [href]);
  await render(null);
  visited.length = 0;
  await render(React.createElement(ResolvedSurface, { connector: flowPreview.connector, runId: flowPreview.runId, statusHref: href }));
  const button = Array.from(dom.window.document.querySelectorAll("button")).find(node => node.textContent === "Continue");
  assert.ok(button);
  await React.act(async () => { button.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
  assert.deepEqual(visited, [href]);
  await render(null);
  visited.length = 0;
  await render(React.createElement(ResolvedSurface, { connector: flowPreview.connector, preview: true, runId: flowPreview.runId, statusHref: href }));
  await React.act(async () => { t.mock.timers.tick(5000); });
  assert.deepEqual(visited, []);
  await render(null);
});

test("finished pages keep the shared heading wrapper, button gaps and missing-row indent", async () => {
  for (const state of ["connected-missing-some", "stopped"]) {
    await render(React.createElement(FirstSyncBody, { connectionId: flowPreview.connectionId, connectorId: "northwind", name: "Northwind", outcome: firstSyncOutcome(previewStatus(state), "Northwind", previewFacts(state)), resumeAction() {} }));
    const header = dom.window.document.querySelector("header");
    assert.ok(header);
    assert.ok(header.querySelector("h1"));
    assert.doesNotMatch(header.textContent ?? "", /Step /);
    if (state === "connected-missing-some") {
      const missingRow = dom.window.document.querySelector('[aria-label="Didn\'t come"] li');
      assert.ok(missingRow);
      assert.ok(missingRow.classList.contains("px-3"));
      assert.match(missingRow.textContent ?? "", /the next time DataConnect checks Northwind/);
    } else {
      const start = Array.from(dom.window.document.querySelectorAll("a")).find(node => node.textContent === "Start again");
      assert.ok(start);
      const buttons = start.parentElement;
      assert.ok(buttons);
      assert.ok(buttons.classList.contains("gap-2"));
      assert.ok(buttons.classList.contains("flex-wrap"));
    }
  }
  await render(null);
});

test.after(async () => { await React.act(async () => root.unmount()); dom.window.close(); });

// Phone walk: the sign-in helper can be moved between the bottom and the top, shrinks to a small pill, and its text can scroll.
test("the sign-in helper moves between bottom and top and is small when hidden", async () => {
  await render(React.createElement(SignInPreview, { key: "browser-code-move", state: "browser-code" }));
  const zone = () => Array.from(dom.window.document.querySelectorAll('[data-slot="interaction"]')).at(0);
  assert.equal(zone()?.getAttribute("data-position"), "bottom");
  const press = async (label: string) => {
    const button = Array.from(zone()?.querySelectorAll("button") ?? []).find(node => node.textContent?.includes(label));
    assert.ok(button, label);
    await React.act(async () => { button.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
  };
  await press("Move to top");
  assert.equal(zone()?.getAttribute("data-position"), "top");
  await press("Hide instructions");
  assert.equal(zone()?.getAttribute("data-collapsed"), "true");
  assert.equal(zone()?.getAttribute("data-position"), "top", "position is kept while hidden");
  await press("Move to bottom");
  assert.equal(zone()?.getAttribute("data-position"), "bottom");
  await render(null);
});

test("the helper's text area scrolls instead of growing past the screen, and the hidden form is a small pill", async () => {
  const { readFile } = await import("node:fs/promises");
  const css = await readFile(new URL("./stream.css", import.meta.url), "utf8");
  assert.match(css, /\[data-slot="interaction"\]\s*\.pdpp-stream-toast-bubble\s*\{[^}]*max-block-size:[^;]*;[^}]*overflow-y:\s*auto/);
  assert.match(css, /\[data-slot="interaction"\]\[data-position="top"\]\s*\{[^}]*inset-block-start/);
  assert.match(css, /\[data-slot="interaction"\]\[data-collapsed="true"\]\s*\{[^}]*inset-inline:\s*auto/);
});
