// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Behavior of the source page's Sync button when the reference refuses a run.
 *
 * Owner report (Chase, phone, dark mode): tapping "Refresh now" on a source
 * whose connector had no verified install showed the raw server sentence in a
 * red caption that was absolutely positioned and right-anchored, so it ran off
 * the left edge and painted over the runs strip below. These tests pin that a
 * `connector_not_installed` refusal reads as plain copy with an Install
 * action, that install failures are shown in place, and that every run-start
 * message flows in the layout instead of floating over it.
 */

import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { mock, test } from "node:test";
import * as React from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

type RunResult =
  | { ok: false; reason: "connector_not_installed"; connector_id: string; message: string }
  | { ok: false; reason: "error"; phase: "after_server"; reached_server: true; message: string };

let runResult: RunResult = {
  connector_id: "chase",
  message: "This connector isn't installed on this server yet, so it can't sync.",
  ok: false,
  reason: "connector_not_installed",
};
let installResult: { ok: true } | { ok: false; message: string } = { ok: true };
const installCalls: { connectorKey: string; routeId: string }[] = [];
let refreshCalls = 0;

const harness = (async () => {
  Object.assign(globalThis, { React });
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
  Object.assign(globalThis, {
    document: dom.window.document,
    Event: dom.window.Event,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    MouseEvent: dom.window.MouseEvent,
    Node: dom.window.Node,
    window: dom.window,
  });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
  mock.module("next/navigation", {
    namedExports: {
      redirect: () => {},
      usePathname: () => "/sources/cin_chase",
      useRouter: () => ({ refresh: () => refreshCalls++ }),
    },
  });
  mock.module(new URL("../actions.ts", import.meta.url).href, {
    namedExports: { runConnectorNowAction: async () => runResult },
  });
  mock.module(new URL("./install-connector-action.ts", import.meta.url).href, {
    namedExports: {
      installConnectorForSourceAction: async (connectorKey: string, routeId: string) => {
        installCalls.push({ connectorKey, routeId });
        return installResult;
      },
    },
  });
  const { SyncNowButton } = await import("./sync-now-button.tsx");
  return { dom, SyncNowButton };
})();

async function mounted(props: Record<string, unknown>, run: (container: HTMLElement) => Promise<void>) {
  const { dom, SyncNowButton } = await harness;
  dom.window.sessionStorage.clear();
  const container = dom.window.document.createElement("div");
  dom.window.document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        createElement(SyncNowButton, {
          connectionId: "cin_chase",
          connectorId: "chase",
          displayName: "Chase",
          idleLabel: "Refresh now",
          initialRunning: false,
          ...props,
        })
      )
    );
    await run(container);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find((item) => item.textContent?.trim() === label);
  assert.ok(found, `expected button: ${label} (have: ${[...container.querySelectorAll("button")].map((b) => b.textContent).join(", ")})`);
  return found;
}

test("a connector_not_installed refusal reads as plain copy with an Install action", async () => {
  runResult = {
    connector_id: "chase",
    message: "This connector isn't installed on this server yet, so it can't sync.",
    ok: false,
    reason: "connector_not_installed",
  };
  installCalls.length = 0;
  await mounted({}, async (container) => {
    await act(async () => button(container, "Refresh now").click());
    const prompt = container.querySelector('[data-testid="connector-not-installed-inline"]');
    assert.ok(prompt, "the inline install prompt renders after the refusal");
    assert.match(prompt.textContent ?? "", /Chase isn't installed on this server yet, so it can't sync\./);
    assert.doesNotMatch(container.textContent ?? "", /reference server rejected|reference fixture|verified install/);
    button(container, "Install Chase");
    assert.equal(installCalls.length, 0, "nothing installs until the owner presses Install");
  });
});

test("Install calls the owner install action with the connector key and shows a failure plainly", async () => {
  installCalls.length = 0;
  refreshCalls = 0;
  await mounted({}, async (container) => {
    await act(async () => button(container, "Refresh now").click());

    installResult = { message: "no verified update target for chase.", ok: false };
    await act(async () => button(container, "Install Chase").click());
    assert.deepEqual(installCalls, [{ connectorKey: "chase", routeId: "cin_chase" }]);
    assert.equal(
      container.querySelector('[role="alert"]')?.textContent,
      "Couldn't install Chase: no verified update target for chase."
    );
    assert.equal(refreshCalls, 0, "a failed install does not pretend the state changed");

    installResult = { ok: true };
    await act(async () => button(container, "Install Chase").click());
    assert.equal(installCalls.length, 2);
    assert.equal(refreshCalls, 1, "a successful install re-reads the page state");
    assert.equal(
      container.querySelector('[data-testid="connector-not-installed-inline"]'),
      null,
      "a successful install removes the inline not-installed prompt even if this component is preserved"
    );
  });
});

test("when the page already shows the install notice, a refusal restates the reason without a second Install button", async () => {
  await mounted({ installPromptShown: true }, async (container) => {
    await act(async () => button(container, "Refresh now").click());
    assert.equal(container.querySelector('[data-testid="connector-not-installed-inline"]'), null);
    assert.equal(
      [...container.querySelectorAll("button")].filter((b) => b.textContent?.startsWith("Install")).length,
      0
    );
    const toast = container.querySelector('[role="status"]');
    assert.equal(toast?.textContent?.trim(), "Chase isn't installed on this server yet, so it can't sync.");
  });
});

test("a run-start error flows below the button and wraps instead of floating over the page", async () => {
  runResult = {
    message: "x".repeat(400),
    ok: false,
    phase: "after_server",
    reached_server: true,
    reason: "error",
  };
  await mounted({}, async (container) => {
    await act(async () => button(container, "Refresh now").click());
    const toast = container.querySelector('[role="status"]');
    assert.ok(toast, "the error renders");
    const classes = toast.className.split(/\s+/);
    // The old caption was `absolute top-full right-0 w-max`: it reserved no
    // space and grew leftward past the viewport edge on narrow screens.
    for (const floating of ["absolute", "right-0", "w-max", "text-right"]) {
      assert.ok(!classes.includes(floating), `run-start message must not use ${floating}`);
    }
    assert.ok(classes.includes("break-words"), "long messages wrap inside their box");
    const wrapper = toast.parentElement;
    assert.ok(wrapper?.className.includes("flex-col"), "the message stacks under the button in normal flow");
    assert.ok(wrapper?.className.includes("max-w-full"), "the wrapper never exceeds its container");
  });
});
