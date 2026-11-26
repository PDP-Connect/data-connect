// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { JSDOM } from "jsdom";
import * as React from "react";
import { act, createElement } from "react";


const calls: string[] = [];
const dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost" });
Object.assign(globalThis, { React, document: dom.window.document, window: dom.window, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
mock.module("next/navigation", { namedExports: { usePathname: () => "/sources", useRouter: () => ({ refresh() {} }) } });
mock.module(new URL("./actions.ts", import.meta.url).href, { namedExports: {
  deleteConnectionAction: async () => {}, revokeConnectionAction: async () => {},
  resetAndSyncConnectionAction: async (id: string) => { calls.push(id); return { ok: true }; },
} });
const component = import("./connection-danger-zone.tsx");
async function mounted(run: (container: HTMLDivElement) => Promise<void>, activeRunId: string | null = null) {
  const container = dom.window.document.createElement("div");
  dom.window.document.body.append(container);
  const { createRoot } = await import("react-dom/client");
  const { ConnectionDangerZone } = await component;
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(ConnectionDangerZone, { connectionId: "cin_test", displayName: "Northwind, work", activeRunId })));
    await run(container);
  } finally { await act(async () => root.unmount()); container.remove(); }
}
async function click(container: HTMLElement, text: string) {
  const buttons = [...container.querySelectorAll("button")].filter((button) => button.textContent?.trim() === text);
  assert.ok(buttons.length, text);
  await act(async () => buttons.at(-1)?.click());
}
test("copy again requires confirmation; Cancel makes no request", async () => {
  calls.length = 0;
  await mounted(async (container) => {
    await click(container, "Copy everything again");
    assert.ok(container.querySelector('[role="alertdialog"]'));
    assert.deepEqual(calls, []);
    await click(container, "Cancel");
    assert.deepEqual(calls, []);
    await click(container, "Copy everything again");
    await click(container, "Copy everything again");
    assert.deepEqual(calls, ["cin_test"]);
  });
});
test("disconnect asks and posts the same fields", async () => {
  await mounted(async (container) => {
    assert.equal(container.querySelector("form"), null);
    await click(container, "Disconnect and keep the records");
    const form = container.querySelector("form");
    assert.ok(form);
    const fields = new dom.window.FormData(form);
    assert.equal(fields.get("connection_id"), "cin_test");
    assert.equal(fields.get("confirm_revoke"), "yes");
    await click(container, "Cancel");
    assert.equal(container.querySelector("form"), null);
  });
});
test("delete confirms by name, then posts the original id and active run", async () => {
  await mounted(async (container) => {
    await click(container, "Delete and erase the records");
    const input = container.querySelector<HTMLInputElement>("#confirm-delete-input");
    const submit = container.querySelector<HTMLButtonElement>('button[type="submit"]');
    const form = container.querySelector("form");
    assert.ok(input && submit && form);
    assert.ok(submit.disabled);
    assert.equal(submit.textContent, "Stop the sync and delete");
    const setValue = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")?.set;
    assert.ok(setValue);
    for (const [typed, enabled] of [["cin_test", false], ["Northwind", false], ["Northwind, work", true]] as const) {
      await act(async () => { setValue.call(input, typed); input.dispatchEvent(new dom.window.Event("input", { bubbles: true })); input.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
      assert.equal(!submit.disabled, enabled, typed);
      const fields = new dom.window.FormData(form);
      assert.equal(fields.get("confirm_delete"), enabled ? "cin_test" : "");
      assert.equal(fields.get("connection_id"), "cin_test");
      assert.equal(fields.get("cancel_run_id"), "run_test");
    }
  }, "run_test");
});
