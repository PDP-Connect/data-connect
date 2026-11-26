// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { JSDOM } from "jsdom";
import * as React from "react";
import { act, createElement } from "react";
import { buildSourcePracticeModel } from "./source-page-practice.ts";

const dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost" });
Object.assign(globalThis, { React, document: dom.window.document, window: dom.window, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
const confirmations: unknown[] = [];
mock.module("next/navigation", { namedExports: { usePathname: () => "/sources", useRouter: () => ({ refresh() {} }) } });
mock.module(new URL("./config-actions.ts", import.meta.url).href, {
  namedExports: {
    confirmConfigAction: async (input: unknown) => { confirmations.push(input); throw new Error("unexpected confirmation"); },
    proposeConfigAction: async () => { throw new Error("unexpected proposal"); },
  },
});

async function mounted(state: string, check: (container: HTMLDivElement) => Promise<void>) {
  const { ConnectionConfiguration } = await import("./connection-configuration.tsx");
  const { createRoot } = await import("react-dom/client");
  const model = buildSourcePracticeModel(state);
  assert.ok(model?.configuration);
  const container = dom.window.document.createElement("div");
  dom.window.document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(ConnectionConfiguration, { config: model.configuration!, revisions: model.configRevisions, connectionId: model.connectionId, connectorId: model.connectorId })));
    await check(container);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
}

function button(container: HTMLElement, label: string) {
  return [...container.querySelectorAll("button")].find((node) => node.textContent?.trim() === label);
}

test("Cancel appears after an edit and restores the saved number without a request", async () => {
  await mounted("settings-choices", async (container) => {
    assert.equal(button(container, "Cancel"), undefined);
    const input = container.querySelector<HTMLInputElement>('input[type="number"]');
    const setValue = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")?.set;
    assert.ok(input && setValue);
    const saved = input.value;
    await act(async () => {
      setValue.call(input, "90");
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      input.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    });
    assert.ok(button(container, "Cancel"));
    await act(async () => button(container, "Cancel")?.click());
    assert.equal(input.value, saved);
    assert.equal(button(container, "Cancel"), undefined);
  });
});

test("Don't change dismisses the question without confirming its stored proposal", async () => {
  confirmations.length = 0;
  await mounted("settings-question", async (container) => {
    assert.ok(button(container, "Confirm"));
    assert.match(container.textContent ?? "", /You gave this reason/);
    await act(async () => button(container, "Don't change")?.click());
    assert.equal(button(container, "Confirm"), undefined);
    assert.deepEqual(confirmations, []);
    assert.ok(container.querySelector('input[type="number"]'));
  });
});
