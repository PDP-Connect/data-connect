// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The sidebar theme toggle must go through next-themes. It used to edit <html>
 * only, so `pdpp-theme` was never stored and any full page load (for example
 * submitting the Add a source search form) fell back to the OS theme.
 *
 * Each test loads the real shell bridge inside the real ThemeProvider the way
 * a browser loads a page: the server renders first and cannot see the
 * browser's theme, the inline script in that HTML applies the stored or OS
 * theme, then React hydrates.
 */

import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { JSDOM } from "jsdom";
import { PathnameContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import React, { act, createElement } from "react";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";

const THEME_KEY = "pdpp-theme";

const GLOBAL_NAMES = [
  "window",
  "self",
  "document",
  "navigator",
  "localStorage",
  "HTMLElement",
  "Element",
  "Node",
  "Text",
  "Event",
  "KeyboardEvent",
  "MouseEvent",
  "CustomEvent",
  "MutationObserver",
  "StorageEvent",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "IS_REACT_ACT_ENVIRONMENT",
];

// The console tsconfig keeps `jsx: preserve`, so tsx compiles the vendored
// components with the classic runtime and expects a global `React`.
(globalThis as { React?: typeof React }).React = React;

const noop = () => undefined;

interface BrowserState {
  /** The OS colour scheme preference. */
  osPrefersDark: boolean;
  /** What the browser already holds under `pdpp-theme`; it survives page loads. */
  storedTheme?: string | null;
}

interface Page {
  close: () => Promise<void>;
  /** The label on the sidebar toggle. */
  label: () => string | null | undefined;
  /** The theme painted on <html>. */
  paintedTheme: () => string | null;
  press: () => Promise<void>;
  storedTheme: () => string | null;
}

// Opening a page replaces the browser globals, so only one is open at a time.
let openPage: Page | undefined;

afterEach(async () => {
  await openPage?.close();
  openPage = undefined;
});

// The live strip pulls in server actions that need the Next runtime; it is
// irrelevant here.
mock.module(new URL("./live-provider.tsx", import.meta.url).href, {
  exports: { LiveStatusStrip: () => null },
});

let modules: ReturnType<typeof importModules> | undefined;

async function importModules() {
  // next-themes decides "am I on the server" when it is imported, so import it
  // only after the DOM globals exist.
  const { ThemeProvider } = await import("@pdpp/operator-ui/components/theme/theme-provider");
  const { CommandPaletteProvider } = await import("@pdpp/operator-ui/components/command-palette");
  const { RecordroomShellWithPalette } = await import("./recordroom-shell-with-palette.tsx");
  return { CommandPaletteProvider, RecordroomShellWithPalette, ThemeProvider };
}

async function loadPage({ osPrefersDark, storedTheme }: BrowserState): Promise<Page> {
  await openPage?.close();
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    runScripts: "outside-only",
    url: "http://localhost/",
  });
  const win = dom.window;
  const container = win.document.getElementById("root");
  assert.ok(container);

  // The server has no browser: it sees no OS preference and no stored theme.
  let osDark = false;
  win.matchMedia = (query: string) =>
    ({
      addEventListener: noop,
      addListener: noop,
      dispatchEvent: () => false,
      matches: osDark && query.includes("prefers-color-scheme: dark"),
      media: query,
      removeEventListener: noop,
      removeListener: noop,
    }) as unknown as MediaQueryList;
  win.requestAnimationFrame = (callback: FrameRequestCallback) => win.setTimeout(() => callback(Date.now()), 0);
  win.cancelAnimationFrame = (id: number) => win.clearTimeout(id);

  const globalObject = globalThis as Record<string, unknown>;
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const name of GLOBAL_NAMES) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalObject, name));
    Object.defineProperty(globalObject, name, {
      configurable: true,
      value: name === "IS_REACT_ACT_ENVIRONMENT" ? true : (win as unknown as Record<string, unknown>)[name],
      writable: true,
    });
  }

  const problems: string[] = [];
  let root: Root | undefined;
  let closed = false;

  const page: Page = {
    async close() {
      if (closed) {
        return;
      }
      closed = true;
      if (root) {
        await act(() => {
          root?.unmount();
        });
      }
      // next-themes removes its transition-suppression <style> in a 1 ms timer
      // that reads the `document` global when it fires. Let that timer run while
      // this page's globals are still installed; otherwise it removes the node
      // from the next page's document and throws an uncaught NotFoundError.
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      for (const [name, descriptor] of previous) {
        if (descriptor === undefined) {
          delete globalObject[name];
        } else {
          Object.defineProperty(globalObject, name, descriptor);
        }
      }
      win.close();
    },
    label: () => container.querySelector(".rr-side__theme")?.textContent,
    paintedTheme: () => win.document.documentElement.getAttribute("data-theme"),
    async press() {
      const toggle = container.querySelector<HTMLButtonElement>(".rr-side__theme");
      assert.ok(toggle);
      await act(() => {
        toggle.click();
      });
    },
    storedTheme: () => win.localStorage.getItem(THEME_KEY),
  };
  openPage = page;

  modules ??= importModules();
  const { CommandPaletteProvider, RecordroomShellWithPalette, ThemeProvider } = await modules;
  const app = () =>
    createElement(
      PathnameContext.Provider,
      { value: "/" },
      createElement(
        ThemeProvider,
        null,
        createElement(CommandPaletteProvider, null, createElement(RecordroomShellWithPalette, null, "content"))
      )
    );

  container.innerHTML = renderToString(app());

  // The browser now loads that HTML. next-themes' inline script runs while the
  // page parses, before React hydrates.
  osDark = osPrefersDark;
  if (storedTheme) {
    win.localStorage.setItem(THEME_KEY, storedTheme);
  }
  const inlineScript = container.querySelector("script");
  assert.ok(inlineScript, "the theme provider renders its inline script");
  win.eval(inlineScript.textContent ?? "");

  await act(() => {
    root = hydrateRoot(container, app(), { onRecoverableError: (error) => problems.push(String(error)) });
  });
  assert.deepEqual(problems, [], "hydration against the browser's theme reports no mismatch");
  return page;
}

test("the toggle stores the chosen theme under pdpp-theme", async () => {
  const page = await loadPage({ osPrefersDark: true });
  assert.equal(page.label(), "Dark");
  assert.equal(page.storedTheme(), null);

  await page.press();
  assert.equal(page.storedTheme(), "light");
  assert.equal(page.paintedTheme(), "light");
  assert.equal(page.label(), "Light");

  await page.press();
  assert.equal(page.storedTheme(), "dark");
  assert.equal(page.paintedTheme(), "dark");
  assert.equal(page.label(), "Dark");
});

for (const osPrefersDark of [true, false]) {
  const os = osPrefersDark ? "dark" : "light";
  const chosen = osPrefersDark ? "light" : "dark";

  test(`a full page load keeps a ${chosen} theme chosen on a ${os} OS`, async () => {
    const first = await loadPage({ osPrefersDark });
    await first.press();
    const storedTheme = first.storedTheme();
    await first.close();

    // Submitting the Add a source search form is a full page load.
    const second = await loadPage({ osPrefersDark, storedTheme });
    assert.equal(second.paintedTheme(), chosen);
    assert.equal(second.label(), chosen === "dark" ? "Dark" : "Light");
  });
}

for (const osPrefersDark of [true, false]) {
  for (const storedTheme of [null, "light", "dark"]) {
    const os = osPrefersDark ? "dark" : "light";
    const expected = storedTheme ?? os;

    test(`loads a ${expected} page on a ${os} OS holding ${storedTheme ?? "no"} stored theme`, async () => {
      // loadPage fails on any hydration mismatch: the server HTML it hydrates
      // could not see this browser's theme.
      const page = await loadPage({ osPrefersDark, storedTheme });
      assert.equal(page.paintedTheme(), expected);
      assert.equal(page.label(), expected === "dark" ? "Dark" : "Light");
    });
  }
}
