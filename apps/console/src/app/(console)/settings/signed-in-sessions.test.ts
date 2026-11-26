// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { JSDOM } from "jsdom";
import * as React from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { buildSettingsPractice } from "./settings-practice.ts";
const calls: string[] = [];
mock.module("next/navigation", { namedExports: { usePathname: () => "/settings", useSearchParams: () => new URLSearchParams(), useRouter: () => ({ refresh() {} }) } });
mock.module(new URL("./owner-sessions-actions.ts", import.meta.url).href, { namedExports: {
  revokeAllOwnerSessionsAction: async () => { calls.push("all"); return { ok: true }; },
  revokeOtherOwnerSessionsAction: async () => { calls.push("others"); return { ok: true }; },
  revokeOwnerSessionAction: async (id: string) => { calls.push(id); return { ok: true }; },
} });
test('five sign-ins initially, Show all reveals thirteen, confirmation gates every sign-out call', async () => {
  calls.length = 0;
  const dom = new JSDOM('<div id="root"></div>');
  Object.assign(globalThis, { React, window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, HTMLButtonElement: dom.window.HTMLButtonElement });
  const { SignedInSessions } = await import("./signed-in-sessions.tsx");
  const container = dom.window.document.querySelector('#root'); assert.ok(container);
  const root = createRoot(container);
  const practice = buildSettingsPractice('sessions-thirteen'); assert.ok(practice);
  const sessions = practice.inventory.sessions;
  const press = async (label: string) => { const button = [...container.querySelectorAll('button')].find(row => row.textContent === label); assert.ok(button); await act(async () => button.click()); };
  try {
    await act(async () => root.render(createElement(SignedInSessions, { sessions })));
    assert.equal(container.textContent?.match(/Chrome on Linux/g)?.length, 5);
    assert.equal(container.querySelector('details'), null);
    assert.doesNotMatch(container.textContent ?? '', /192\.168\./);
    await press('Show all 13');
    assert.equal(container.textContent?.match(/Chrome on Linux/g)?.length, 13);
    for (const label of ['Sign out everywhere else', 'Sign out all devices', 'Sign out']) {
      const previous = calls.length;
      await press(label); assert.equal(calls.length, previous);
      assert.ok(container.querySelector('[role=alertdialog]'));
      await press('Confirm sign out'); assert.equal(calls.length, previous + 1);
    }
    assert.equal(calls[0], 'others'); assert.equal(calls[1], 'all');
    assert.equal(calls[2], sessions[0]?.id);
  } finally { await act(async () => root.unmount()); dom.window.close(); }
});
