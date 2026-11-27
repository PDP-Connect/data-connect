// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, test } from "node:test";
import userEvent from "@testing-library/user-event";
import { JSDOM } from "jsdom";
import { PathnameContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import React, { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

interface BrowserGlobals {
  dom: JSDOM;
  host: HTMLDivElement;
  restore: () => void;
  root: Root;
}

let browser: BrowserGlobals | undefined;

const noop = () => false;

function globalValue(name: string, dom: JSDOM, windowObject: Record<string, unknown>) {
  if (name === "window" || name === "self") {
    return dom.window;
  }
  if (name === "document") {
    return dom.window.document;
  }
  if (name === "IS_REACT_ACT_ENVIRONMENT") {
    return true;
  }
  if (name === "React") {
    return React;
  }
  return windowObject[name];
}

function installBrowserGlobals(): BrowserGlobals {
  const dom = new JSDOM("<!doctype html><html data-theme=dark><body></body></html>", {
    url: "http://localhost/",
  });
  Object.defineProperty(dom.window, "innerWidth", { configurable: true, value: 390 });
  const style = dom.window.document.createElement("style");
  style.textContent = [
    readFileSync(new URL("./shell.css", import.meta.url), "utf8"),
    // JSDOM does not apply the shell's max-width media rule.
    ".rr-head { display: flex; }",
    ".rr-menu-btn { display: inline-flex; }",
  ].join("\n");
  dom.window.document.head.append(style);
  const host = dom.window.document.createElement("div");
  dom.window.document.body.append(host);

  const globalObject = globalThis as Record<string, unknown>;
  const windowObject = dom.window as unknown as Record<string, unknown>;
  const previous = new Map<string, PropertyDescriptor | undefined>();
  dom.window.matchMedia = (query: string) =>
    ({
      matches: query.includes("prefers-reduced-motion: reduce"),
      media: query,
      onchange: null,
      addListener: noop,
      removeListener: noop,
      addEventListener: noop,
      removeEventListener: noop,
      dispatchEvent() {
        return false;
      },
    }) as MediaQueryList;
  dom.window.requestAnimationFrame = (callback: FrameRequestCallback) =>
    dom.window.setTimeout(() => callback(Date.now()), 0);
  dom.window.cancelAnimationFrame = (id: number) => dom.window.clearTimeout(id);
  const globals = [
    "window",
    "self",
    "document",
    "navigator",
    "HTMLElement",
    "Element",
    "Node",
    "Text",
    "Event",
    "KeyboardEvent",
    "MouseEvent",
    "CustomEvent",
    "MutationObserver",
    "getComputedStyle",
    "requestAnimationFrame",
    "cancelAnimationFrame",
    "IS_REACT_ACT_ENVIRONMENT",
    "React",
  ];
  for (const name of globals) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalObject, name));
    Object.defineProperty(globalObject, name, {
      configurable: true,
      value: globalValue(name, dom, windowObject),
      writable: true,
    });
  }

  const restore = () => {
    browser = undefined;
    for (const [name, descriptor] of previous) {
      if (descriptor === undefined) {
        delete globalObject[name];
      } else {
        Object.defineProperty(globalObject, name, descriptor);
      }
    }
    dom.window.close();
  };

  const root = createRoot(host);
  browser = { dom, host, restore, root };
  return browser;
}

async function settle() {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

function app(children: ReactNode) {
  return createElement(PathnameContext.Provider, { value: "/" }, children);
}

async function pressTab(user: ReturnType<typeof userEvent.setup>, options?: { shift?: boolean }) {
  await act(async () => user.tab(options));
  await new Promise<void>((resolve) => setTimeout(resolve, 50));
}

afterEach(async () => {
  if (!browser) {
    return;
  }
  await act(async () => browser?.root.unmount());
  browser.restore();
});

test("mobile drawer opens as a named dialog, traps focus, and restores the trigger", async () => {
  const { host } = installBrowserGlobals();
  const currentBrowser = browser;
  assert.ok(currentBrowser);
  const user = userEvent.setup({ delay: null, document: currentBrowser.dom.window.document });
  const { RecordroomShell } = await import("./shell-frame.tsx");
  act(() => {
    currentBrowser.root.render(
      app(createElement(RecordroomShell, null, createElement("button", { type: "button" }, "Outside action")))
    );
  });

  const trigger = host.querySelector<HTMLButtonElement>(".rr-menu-btn");
  assert.ok(trigger);
  trigger.focus();
  await act(async () => user.click(trigger));
  await settle();

  const dialog = currentBrowser.dom.window.document.querySelector<HTMLElement>('[role="dialog"]');
  assert.ok(dialog);
  assert.equal(dialog.getAttribute("aria-label"), "Primary navigation");
  assert.equal(currentBrowser.dom.window.document.activeElement?.closest('[role="dialog"]'), dialog);

  const dialogStyle = currentBrowser.dom.window.getComputedStyle(dialog);
  assert.equal(dialogStyle.position, "fixed");
  assert.equal(dialogStyle.left, "0px");
  assert.equal(dialogStyle.top, "0px");
  assert.equal(dialogStyle.right, "auto");
  assert.equal(dialogStyle.maxWidth, "none");
  assert.equal(dialogStyle.zIndex, "71");
  assert.equal(dialogStyle.transform, "none");

  const close = dialog.querySelector<HTMLButtonElement>('[aria-label="Close navigation"]');
  assert.ok(close);
  const firstNavItem = dialog.querySelector<HTMLAnchorElement>('.rr-nav-item[href="/"]');
  assert.ok(firstNavItem);
  const themeToggle = dialog.querySelector<HTMLButtonElement>(".rr-side__theme");
  assert.ok(themeToggle);
  const outside = host.querySelector<HTMLButtonElement>(".rr-content button");
  assert.ok(outside);
  assert.equal(outside.closest('[role="dialog"]'), null);

  close.focus();
  await settle();
  assert.equal(currentBrowser.dom.window.document.activeElement, close);
  await pressTab(user, { shift: true });
  assert.equal(currentBrowser.dom.window.document.activeElement, themeToggle);
  assert.equal(currentBrowser.dom.window.document.activeElement?.closest('[role="dialog"]'), dialog);

  close.focus();
  await settle();
  assert.equal(currentBrowser.dom.window.document.activeElement, close);
  await pressTab(user);
  assert.equal(currentBrowser.dom.window.document.activeElement, firstNavItem);
  assert.equal(currentBrowser.dom.window.document.activeElement?.closest('[role="dialog"]'), dialog);

  themeToggle.focus();
  await settle();
  assert.equal(currentBrowser.dom.window.document.activeElement, themeToggle);
  await pressTab(user);
  assert.equal(currentBrowser.dom.window.document.activeElement, close);
  assert.equal(currentBrowser.dom.window.document.activeElement?.closest('[role="dialog"]'), dialog);
  assert.notEqual(currentBrowser.dom.window.document.activeElement, outside);

  await act(async () => user.keyboard("{Escape}"));
  await settle();
  const dialogAfterEscape = currentBrowser.dom.window.document.querySelector('[role="dialog"]');
  assert.equal(dialogAfterEscape, null);
  const activeAfterEscape = currentBrowser.dom.window.document.activeElement;
  assert.equal(activeAfterEscape, trigger);
});

test("backdrop and close button dismiss the drawer", async () => {
  const { host } = installBrowserGlobals();
  const currentBrowser = browser;
  assert.ok(currentBrowser);
  const { RecordroomShell } = await import("./shell-frame.tsx");
  act(() => {
    currentBrowser.root.render(app(createElement(RecordroomShell, null, createElement("p", null, "Content"))));
  });

  const trigger = host.querySelector<HTMLButtonElement>(".rr-menu-btn");
  assert.ok(trigger);
  act(() => trigger.click());
  await settle();

  const backdrop = currentBrowser.dom.window.document.querySelector<HTMLElement>(".rr-drawer-overlay");
  assert.ok(backdrop);
  act(() => {
    backdrop.click();
  });
  await settle();
  assert.equal(currentBrowser.dom.window.document.querySelector('[role="dialog"]'), null);

  act(() => trigger.click());
  await settle();
  const close = currentBrowser.dom.window.document.querySelector<HTMLButtonElement>('[aria-label="Close navigation"]');
  assert.ok(close);
  act(() => {
    close.click();
  });
  await settle();
  assert.equal(currentBrowser.dom.window.document.querySelector('[role="dialog"]'), null);
});

test("search in the drawer closes it before opening the jump dialog", async () => {
  const { host } = installBrowserGlobals();
  const currentBrowser = browser;
  assert.ok(currentBrowser);
  const jumps: string[] = [];
  const { RecordroomShell } = await import("./shell-frame.tsx");
  act(() => {
    currentBrowser.root.render(
      app(createElement(RecordroomShell, { onJump: () => jumps.push("opened") }, createElement("p", null, "Content")))
    );
  });

  const trigger = host.querySelector<HTMLButtonElement>(".rr-menu-btn");
  assert.ok(trigger);
  act(() => trigger.click());
  await settle();

  const dialog = currentBrowser.dom.window.document.querySelector<HTMLElement>('[role="dialog"]');
  assert.ok(dialog);
  const search = dialog.querySelector<HTMLButtonElement>(".rr-search-button");
  assert.ok(search);
  await act(async () => {
    await userEvent.setup({ delay: null, document: currentBrowser.dom.window.document }).click(search);
  });
  await settle();

  assert.deepEqual(jumps, ["opened"]);
  assert.equal(currentBrowser.dom.window.document.querySelector('[role="dialog"]'), null);
});

test("touch drag tracks an inert copy before release and commits the accessible dialog afterward", async () => {
  const { host } = installBrowserGlobals();
  const currentBrowser = browser;
  assert.ok(currentBrowser);
  const { document } = currentBrowser.dom.window;
  const { RecordroomShell } = await import("./shell-frame.tsx");
  act(() =>
    currentBrowser.root.render(
      app(createElement(RecordroomShell, null, createElement("button", { type: "button" }, "Page action")))
    )
  );
  const content = host.querySelector<HTMLElement>(".rr-content");
  assert.ok(content);
  const eventWindow = currentBrowser.dom.window;
  function pointer(type: string, x: number, y: number, time: number) {
    const event = new eventWindow.Event(type, {
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperties(event, {
      pointerId: { value: 1 },
      pointerType: { value: "touch" },
      isPrimary: { value: true },
      clientX: { value: x },
      clientY: { value: y },
      timeStamp: { value: time },
    });
    act(() => content?.dispatchEvent(event));
  }
  pointer("pointerdown", 100, 100, 0);
  pointer("pointermove", 108, 100, 20);
  assert.equal(document.querySelector(".rr-drag-panel"), null);
  pointer("pointermove", 220, 100, 300);
  const preview = document.querySelector<HTMLElement>(".rr-drag-panel");
  assert.ok(preview);
  assert.equal(preview.style.transform, "translateX(-180px)");
  assert.equal(preview.getAttribute("aria-hidden"), "true");
  assert.equal(preview.hasAttribute("inert"), true);
  assert.equal(document.querySelector('[role="dialog"]'), null);
  assert.equal(document.querySelector<HTMLElement>(".rr-drag-backdrop")?.style.opacity, "0.4");
  const touchMove = new currentBrowser.dom.window.Event("touchmove", {
    bubbles: true,
    cancelable: true,
  });
  Object.defineProperty(touchMove, "touches", { value: [{}] });
  content.dispatchEvent(touchMove);
  assert.equal(touchMove.defaultPrevented, true);
  pointer("pointermove", 270, 100, 600);
  pointer("pointerup", 270, 100, 800);
  await settle();
  assert.equal(document.querySelector(".rr-drag-panel"), null);
  assert.ok(document.querySelector('[role="dialog"][aria-label="Primary navigation"]'));
  pointer("pointerdown", 270, 100, 1000);
  pointer("pointermove", 100, 100, 1500);
  pointer("pointerup", 100, 100, 1700);
  await settle();
  assert.equal(document.querySelector('[role="dialog"]'), null);
  assert.equal(document.querySelector(".rr-drag-panel"), null);
});
