// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { JSDOM } from "jsdom";
import * as React from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { settingsPracticeNames } from "./settings-practice.ts";

// Every practice state that showed Remote access or Password and sign-in on Settings shows it on the new page.
let liveCalls = 0;
const live = async () => { liveCalls++; throw Error("Practice called a live loader or action"); };
mock.module("server-only", { namedExports: {} });
mock.module("next/navigation", { namedExports: { useRouter: () => ({ refresh() {} }), usePathname: () => "/settings", useSearchParams: () => new URLSearchParams() } });
mock.module(new URL("../components/recordroom-shell-with-palette.tsx", import.meta.url).href, { namedExports: { RecordroomShellWithPalette: ({ children }: { children: React.ReactNode }) => createElement("main", null, children) } });
mock.module(new URL("../lib/owner-credential-client.ts", import.meta.url).href, { namedExports: { hasValidLocalOwnerCredentialRevealProofCookie: live } });
mock.module(new URL("./settings-summary-data.ts", import.meta.url).href, { namedExports: { loadSettingsSummary: live } });
mock.module(new URL("./owner-password-data.ts", import.meta.url).href, { namedExports: { loadOwnerPasswordSet: live, loadOwnerPasswordSource: live } });
mock.module(new URL("./owner-sessions-data.ts", import.meta.url).href, { namedExports: { loadOwnerSessionInventory: live } });
mock.module(new URL("./owner-password-first-setup-actions.ts", import.meta.url).href, { namedExports: { canOpenOwnerPasswordWindowAction: live, requestOwnerPasswordWindowAction: live } });
mock.module(new URL("./owner-password-actions.ts", import.meta.url).href, { namedExports: { changeOwnerPasswordAction: live, requestDesktopOwnerPasswordChangeAction: live } });
mock.module(new URL("./owner-credential-actions.ts", import.meta.url).href, { namedExports: { revealOwnerCredentialAction: live } });
mock.module(new URL("./recovery-key-actions.ts", import.meta.url).href, { namedExports: { exportRecoveryKitAction: live } });
mock.module(new URL("./owner-sessions-actions.ts", import.meta.url).href, { namedExports: { revokeAllOwnerSessionsAction: live, revokeOtherOwnerSessionsAction: live, revokeOwnerSessionAction: live } });
mock.module(new URL("./reachability-client.ts", import.meta.url).href, { namedExports: { requestReachability: live } });

async function mount(path: string, demo: string, run: (container: Element, text: string) => Promise<void> | void) {
  liveCalls = 0;
  const dom = new JSDOM('<div id="root"></div>', { url: `http://localhost${path}?demo=${demo}` });
  Object.assign(globalThis, { React, window: dom.window, self: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, HTMLButtonElement: dom.window.HTMLButtonElement });
  const container = dom.window.document.querySelector("#root"); assert.ok(container);
  const root = createRoot(container);
  try {
    const { default: Page } = await import(`.${path.replace("/settings", "")}/page.tsx`);
    await act(async () => root.render(await Page({ searchParams: Promise.resolve({ demo }) })));
    await act(async () => {});
    await run(container, container.textContent ?? "");
    assert.equal(liveCalls, 0, "practice never calls a live action");
  } finally { await act(async () => root.unmount()); dom.window.close(); }
}

for (const demo of settingsPracticeNames) {
  test(`/settings/remote-access ${demo}: shows the remote access block on its own page`, () => mount("/settings/remote-access", demo, (container, text) => {
    assert.equal(container.querySelectorAll("main").length, 1);
    assert.ok(container.querySelector("#remote-access"), "keeps the #remote-access anchor");
    assert.ok(container.querySelector('a[href="/settings"]'), "links back to Settings");
    assert.equal(container.querySelector("details"), null);
    if (demo.startsWith("server")) assert.match(text, /set up where DataConnect is installed|DataConnect is reached at/);
    else assert.match(text, /Off|On|Turn on|Turning on|Needs your action|did not turn on|Choose your own password|Sign in|ngrok|lost track|may still|Connecting|Checked this computer/);
    if (demo === "off" || demo === "choose") assert.ok([...container.querySelectorAll("button")].some(b => b.textContent?.startsWith("Turn on")));
    if (demo === "desktop-fresh") { assert.doesNotMatch(text, /Step 1/); assert.match(text, /To turn on remote access, choose your own password first/); }
    if (demo === "on-private") { assert.match(text, /Works on your devices/); assert.doesNotMatch(text, /Next: connect ChatGPT/); }
    if (demo === "on-public") assert.doesNotMatch(text, /Copy details for support/);
    if (demo === "off-unconfirmed") { assert.equal((text.match(/couldn.t confirm/g) ?? []).length, 1); assert.doesNotMatch(text, /Works from the internet/); }
    assert.doesNotMatch(text, /Password and sign-in|Where you.re signed in/);
  }));
  test(`/settings/sign-in ${demo}: shows password, sign-ins and nothing else on its own page`, () => mount("/settings/sign-in", demo, async (container, text) => {
    assert.equal(container.querySelectorAll("main").length, 1);
    assert.ok(container.querySelector('a[href="/settings"]'), "links back to Settings");
    assert.ok(container.querySelector("#owner-password"), "keeps the #owner-password anchor");
    assert.match(text, /Where you.re signed in/);
    assert.match(text, /Signed in on \d+ devices/);
    if (demo === "sessions-thirteen") assert.match(text, /Show all 13/);
    if (demo === "desktop-fresh") assert.match(text, /DataConnect made a password for you/);
    assert.doesNotMatch(text, /Turn on|Your address/);
    for (const label of ["Show password", "Choose a password", "Change password"]) {
      const button = [...container.querySelectorAll("button")].find(row => row.textContent === label);
      if (button) await act(async () => button.click());
    }
  }));
}
