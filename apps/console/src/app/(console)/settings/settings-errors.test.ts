// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { JSDOM } from "jsdom";
import * as React from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { copySupport } from "./support-copy.fixture.ts";
const fail = async () => ({ ok: false as const, message: 'internal_failure_code /private/host/path' });
mock.module(new URL('./owner-credential-actions.ts', import.meta.url).href, { namedExports: { revealOwnerCredentialAction: fail } });
mock.module(new URL('./recovery-key-actions.ts', import.meta.url).href, { namedExports: { exportRecoveryKitAction: fail } });
mock.module(new URL('./desktop-pairing-actions.ts', import.meta.url).href, { namedExports: { createDesktopPairingAction: fail } });
for (const kind of ['password','recovery','pairing'] as const) test(`${kind} failure keeps raw details in support copy`, async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/settings' });
  Object.assign(globalThis, { React, window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, HTMLButtonElement: dom.window.HTMLButtonElement });
  const container = dom.window.document.querySelector('#root'); assert.ok(container);
  const root = createRoot(container);
  const press = async (label: string) => { const button = [...container.querySelectorAll('button')].find(row => row.textContent === label); assert.ok(button); await act(async () => button.click()); };
  try {
    if (kind === 'password') { const { OwnerCredentialSetting } = await import('./owner-credential-setting.tsx'); await act(async () => root.render(createElement(OwnerCredentialSetting))); await press('Show password'); }
    if (kind === 'recovery') { const { RecoveryKeySetting } = await import('./recovery-key-setting.tsx'); await act(async () => root.render(createElement(RecoveryKeySetting))); await press('Show recovery code'); }
    if (kind === 'pairing') { const { DesktopPairingSetting } = await import('./desktop-pairing-setting.tsx'); await act(async () => root.render(createElement(DesktopPairingSetting))); await press('Connect a DataConnect app on another computer'); await press('Create pairing code'); }
    assert.doesNotMatch(container.textContent ?? '', /internal_failure_code|\/private\/host/);
    assert.equal(container.querySelector('details'), null);
    assert.match(await copySupport(container), /internal_failure_code/);
  } finally { await act(async () => root.unmount()); dom.window.close(); }
});
