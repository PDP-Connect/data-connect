// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { act } from "react";
export async function copySupport(container: Element): Promise<string> {
  const copied: string[] = [];
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: { writeText: async (text: string) => { copied.push(text); } } } });
  const buttons = [...container.querySelectorAll<HTMLButtonElement>("button")].filter(button => button.textContent === "Copy details for support" || button.textContent === "Copied");
  assert.ok(buttons.length, "support copy is offered");
  for (const button of buttons) await act(async () => button.click());
  return copied.join("\n");
}
