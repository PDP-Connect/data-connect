// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement, type ReactElement } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { ShellThemeButton, ShellThemeProvider } from "./shell-theme.tsx";

async function withThemeButton(
  element: ReactElement,
  check: (html: HTMLElement, button: HTMLButtonElement) => Promise<void>
) {
  const dom = new JSDOM('<!doctype html><html data-theme="dark" class="dark"><body><div id="host"></div></body></html>');
  const globals = {
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
    MutationObserver: dom.window.MutationObserver,
    window: dom.window,
  };
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries(globals)) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, value, writable: true });
  }
  const doc = dom.window.document;
  const host = doc.querySelector("#host");
  assert.ok(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(element));
    const button = host.querySelector("button");
    assert.ok(button);
    await check(doc.documentElement, button);
  } finally {
    await act(async () => root.unmount());
    for (const [name, descriptor] of previous) {
      if (descriptor) {
        Object.defineProperty(globalThis, name, descriptor);
      } else {
        Reflect.deleteProperty(globalThis, name);
      }
    }
    dom.window.close();
  }
}

test("the shell footer follows externally painted theme changes", async () => {
  await withThemeButton(createElement(ShellThemeButton), async (html, button) => {
    assert.equal(button.textContent, "Dark");
    await act(async () => {
      html.setAttribute("data-theme", "light");
      html.classList.remove("dark");
    });
    assert.equal(button.textContent, "Light");
    assert.equal(button.title, "Switch to dark");
  });
});

test("the shell footer requests the provider theme without writing the DOM", async () => {
  const requested: string[] = [];
  const element = createElement(ShellThemeProvider, {
    children: createElement(ShellThemeButton),
    setTheme: next => requested.push(next),
  });
  await withThemeButton(element, async (html, button) => {
    await act(async () => button.click());
    assert.deepEqual(requested, ["light"]);
    assert.equal(html.getAttribute("data-theme"), "dark");
    assert.equal(html.classList.contains("dark"), true);
    assert.equal(button.textContent, "Dark");
  });
});

test("the server renders a neutral label and hydration settles on the painted theme", async () => {
  const markup = renderToString(createElement(ShellThemeButton));
  assert.match(markup, />Theme</);
  assert.doesNotMatch(markup, /Switch to/);

  const dom = new JSDOM(`<!doctype html><html data-theme="light"><body><div id="host">${markup}</div></body></html>`);
  const globals = {
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
    MutationObserver: dom.window.MutationObserver,
    window: dom.window,
  };
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries(globals)) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, value, writable: true });
  }
  const host = dom.window.document.querySelector("#host");
  assert.ok(host);
  const errors: unknown[] = [];
  let root: ReturnType<typeof hydrateRoot> | undefined;
  try {
    await act(async () => {
      root = hydrateRoot(host, createElement(ShellThemeButton), { onRecoverableError: error => errors.push(error) });
    });
    const button = host.querySelector("button");
    assert.ok(button);
    assert.deepEqual(errors, []);
    assert.equal(button.textContent, "Light");
    assert.equal(button.title, "Switch to dark");
  } finally {
    await act(async () => root?.unmount());
    for (const [name, descriptor] of previous) {
      if (descriptor) {
        Object.defineProperty(globalThis, name, descriptor);
      } else {
        Reflect.deleteProperty(globalThis, name);
      }
    }
    dom.window.close();
  }
});
