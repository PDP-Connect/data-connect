// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import * as React from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { NotificationsRow } from "./notifications-row.tsx";
for (const state of ['unsupported','on','off','failed'] as const) test(`notification summary reads this browser: ${state}`, async () => {
  const dom = new JSDOM('<div id="root"></div>');
  Object.assign(globalThis, { React, window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const container = dom.window.document.querySelector('#root'); assert.ok(container);
  if (state !== 'unsupported') {
    Object.defineProperty(dom.window, 'Notification', { configurable: true, value: { permission: 'granted' } });
    Object.defineProperty(dom.window, 'PushManager', { configurable: true, value: {} });
    Object.assign(globalThis, { Notification: { permission: 'granted' } });
  }
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { serviceWorker: { getRegistration: async () => { if (state === 'failed') throw Error('unavailable'); return { pushManager: { getSubscription: async () => state === 'on' ? {} : null } }; } } } });
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(NotificationsRow)));
    const expected = { unsupported: 'Not available in this browser', on: 'On for this browser', off: 'Off', failed: 'Could not check this browser' }[state];
    assert.ok(container.textContent?.includes(expected));
    assert.equal(container.querySelector('a')?.getAttribute('href'), '/notifications');
  } finally { await act(async () => root.unmount()); dom.window.close(); }
});
