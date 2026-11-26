// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { JSDOM } from "jsdom";
import * as React from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { settingsPracticeNames } from "./settings-practice.ts";
const live = async () => { throw Error("Practice called a live loader or action"); };
mock.module("server-only", { namedExports: {} });
mock.module("next/navigation", { namedExports: { useRouter: () => ({ refresh() {} }), usePathname: () => "/settings", useSearchParams: () => new URLSearchParams() } });
mock.module(new URL("../components/recordroom-shell-with-palette.tsx", import.meta.url).href, { namedExports: { RecordroomShellWithPalette: ({ children }: { children: React.ReactNode }) => createElement("div", null, children) } });
mock.module(new URL("../lib/owner-credential-client.ts", import.meta.url).href, { namedExports: { hasValidLocalOwnerCredentialRevealProofCookie: live } });
mock.module(new URL("./settings-summary-data.ts", import.meta.url).href, { namedExports: { loadSettingsSummary: live } });
mock.module(new URL("./owner-password-data.ts", import.meta.url).href, { namedExports: { loadOwnerPasswordSet: live, loadOwnerPasswordSource: live } });
mock.module(new URL("./owner-sessions-data.ts", import.meta.url).href, { namedExports: { loadOwnerSessionInventory: live } });
mock.module(new URL("./owner-password-first-setup-actions.ts", import.meta.url).href, { namedExports: { canOpenOwnerPasswordWindowAction: async () => true, requestOwnerPasswordWindowAction: live } });
mock.module(new URL("./owner-password-actions.ts", import.meta.url).href, { namedExports: { changeOwnerPasswordAction: live, requestDesktopOwnerPasswordChangeAction: live } });
mock.module(new URL("./owner-credential-actions.ts", import.meta.url).href, { namedExports: { revealOwnerCredentialAction: live } });
mock.module(new URL("./recovery-key-actions.ts", import.meta.url).href, { namedExports: { exportRecoveryKitAction: live } });
mock.module(new URL("./desktop-settings-actions.ts", import.meta.url).href, { namedExports: { loadAppConfigAction: live, saveAppConfigFieldAction: live, loadAutostartAction: live, setAutostartAction: live } });
mock.module(new URL("./desktop-pairing-actions.ts", import.meta.url).href, { namedExports: { createDesktopPairingAction: live } });
mock.module(new URL("./owner-sessions-actions.ts", import.meta.url).href, { namedExports: { revokeAllOwnerSessionsAction: live, revokeOtherOwnerSessionsAction: live, revokeOwnerSessionAction: live } });
mock.module(new URL("./reachability-client.ts", import.meta.url).href, { namedExports: { requestReachability: live } });
for (const demo of settingsPracticeNames) test(`Settings ${demo}: plain page, no raw diagnostics, five rows before Show all`, async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: `http://localhost/settings?demo=${demo}` });
  Object.assign(globalThis, { React, window: dom.window, self: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, HTMLButtonElement: dom.window.HTMLButtonElement });
  const container = dom.window.document.querySelector('#root')!;
  const root = createRoot(container);
  try {
    const { default: SettingsPage } = await import("./page.tsx");
    const page = await SettingsPage({ searchParams: Promise.resolve({ demo }) });
    await act(async () => root.render(page));
    await act(async () => {});
    const text = container.textContent ?? '';
    assert.equal(container.querySelector('details'), null);
    assert.doesNotMatch(text, /\b(?:exporter|heartbeat|stale|bearer|enrollment|revoked|VAPID|jitter|PDPP|Personal Server|keychain|connector|readiness|deployment|origin)\b/i);
    assert.doesNotMatch(text, /\b(?:PDPP_|DATACONNECT_)|Code:|\b[a-z]+_[a-z]+_[a-z]+\b/);
    assert.equal([...container.querySelectorAll('button')].filter(row => row.textContent === 'Revoke access token').length, 0);
    assert.ok((text.match(/Chrome on Linux/g)?.length ?? 0) <= 5);
    if (demo === 'sessions-thirteen') assert.match(text, /Show all 13/);
    if (demo.startsWith('server')) assert.doesNotMatch(text, /Quit and reopen/);
    // Practice controls may explain their simulated action but must never call the live actions above.
    for (const label of ['Show password', 'Set password', 'Change password', 'Show recovery code']) {
      const button = [...container.querySelectorAll('button')].find(row => row.textContent === label);
      if (button) await act(async () => button.click());
    }
  } catch (error) { console.error(demo, error); throw error; } finally { await act(async () => root.unmount()); dom.window.close(); }
});
