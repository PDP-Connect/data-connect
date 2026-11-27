// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
// Copy diagnostics: a clipboard that refuses, or is missing, says so.
import assert from "node:assert/strict"
import test from "node:test"
import { JSDOM } from "jsdom"
import * as React from "react"
import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import { ErrorNotice, ReachabilityFailure, toDisplayError } from "./diagnostics.tsx"
import { publicError } from "./reachability-errors.ts"

async function withClipboard(clipboard: unknown, run: (screen: { press: () => Promise<void>; text: () => string }) => Promise<void>) {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" })
  const before = Object.getOwnPropertyDescriptor(globalThis, "navigator")
  Object.assign(globalThis, { React, window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, HTMLButtonElement: dom.window.HTMLButtonElement })
  Object.defineProperty(globalThis, "navigator", { value: { clipboard }, configurable: true })
  const container = dom.window.document.querySelector("#root")!
  const root = createRoot(container)
  const error = toDisplayError(new ReachabilityFailure(publicError("reachability_unavailable")), "load")
  await act(async () => root.render(createElement(ErrorNotice, { error })))
  try {
    await run({
      text: () => container.textContent ?? "",
      press: async () => {
        const button = [...container.querySelectorAll("button")].find((node) => /^Copy diagnostics$|^Copied$/.test(node.textContent ?? ""))
        assert.ok(button, "no Copy diagnostics button")
        await act(async () => button.click())
      },
    })
  } finally {
    await act(async () => root.unmount())
    if (before) Object.defineProperty(globalThis, "navigator", before)
    dom.window.close()
  }
}

test("a clipboard write that rejects shows a failure, not a silent nothing", async () => {
  const unhandled: unknown[] = []
  const record = (reason: unknown) => unhandled.push(reason)
  process.on("unhandledRejection", record)
  try {
    await withClipboard({ writeText: async () => Promise.reject(new Error("denied")) }, async ({ press, text }) => {
      await press()
      await new Promise((resolve) => setTimeout(resolve, 0))
      assert.match(text(), /couldn.t copy/i)
      assert.doesNotMatch(text(), /Copied/)
    })
  } finally {
    process.off("unhandledRejection", record)
  }
  assert.deepEqual(unhandled, [], "the rejection is handled")
})

test("a missing clipboard says it is unavailable", async () => {
  await withClipboard(undefined, async ({ press, text }) => {
    await press()
    assert.match(text(), /clipboard unavailable/i)
  })
})

test("a clipboard that accepts the text shows Copied and no failure", async () => {
  const written: string[] = []
  await withClipboard({ writeText: async (value: string) => void written.push(value) }, async ({ press, text }) => {
    await press()
    assert.match(text(), /Copied/)
    assert.doesNotMatch(text(), /couldn.t copy to the clipboard|clipboard unavailable/i)
    assert.equal(written.length, 1)
    assert.match(written[0]!, /^Code: /)
  })
})
