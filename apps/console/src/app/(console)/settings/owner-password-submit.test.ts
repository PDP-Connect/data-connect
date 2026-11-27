// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
// Enter in a password field submits the form even while the button is
// disabled, so a second Enter during a save must not send a second change.
import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { JSDOM } from "jsdom";
import * as React from "react";
import { act, createElement } from "react";

const calls: Array<[string, string]> = [];
let release!: () => void;
const held = new Promise<void>((resolve) => {
  release = resolve;
});

mock.module("next/navigation", { namedExports: { useRouter: () => ({ refresh: () => {} }) } });
mock.module(new URL("./owner-password-actions.ts", import.meta.url).href, {
  namedExports: {
    changeOwnerPasswordAction: async (current: string, next: string) => {
      calls.push([current, next]);
      await held;
      return { ok: true };
    },
    requestDesktopOwnerPasswordChangeAction: async () => ({ ok: true }),
  },
});
mock.module(new URL("./owner-password-first-setup-actions.ts", import.meta.url).href, {
  namedExports: { requestOwnerPasswordWindowAction: async () => ({ ok: true }) },
});
mock.module(new URL("./owner-credential-actions.ts", import.meta.url).href, {
  namedExports: { revealOwnerCredentialAction: async () => ({ ok: true, password: "unused" }) },
});

test("two submits during one in-flight change send one request and keep the success message", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://127.0.0.1:3000/settings" });
  Object.assign(globalThis, {
    React,
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement,
  });
  // react-dom decides at load time whether the DOM supports input events, so it loads after the globals.
  const { createRoot } = await import("react-dom/client");
  const { OwnerPasswordSetting } = await import("./owner-password-setting.tsx");
  const container = dom.window.document.querySelector("#root")!;
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(OwnerPasswordSetting, { passwordSet: true, source: "app" })));
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!;
    const fill = async (input: Element, value: string) =>
      act(async () => {
        setter.call(input, value);
        input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      });
    const [current, next, confirm] = [...container.querySelectorAll("input")];
    await fill(current!, "the-current-password");
    await fill(next!, "a-new-password-of-length");
    await fill(confirm!, "a-new-password-of-length");
    const form = container.querySelector("form")!;
    const submit = () => form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    await act(async () => {
      submit();
      submit();
    });
    await act(async () => {
      submit();
    });
    release();
    await act(async () => {
      await held;
    });
    assert.equal(calls.length, 1);
    assert.match(container.textContent ?? "", /Password changed\./);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});
