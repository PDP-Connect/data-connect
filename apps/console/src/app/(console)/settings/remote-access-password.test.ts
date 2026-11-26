// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict"
import test, { mock } from "node:test"
import { JSDOM } from "jsdom"
import * as React from "react"
import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import type { requestReachability } from "./reachability-client.ts"

const windowCalls: string[] = []
mock.module(new URL("./reachability-client.ts", import.meta.url).href, {
  namedExports: { requestReachability: async () => { throw new Error("Use the test transport") } },
})
mock.module(new URL("./owner-password-first-setup-actions.ts", import.meta.url).href, {
  namedExports: {
    requestOwnerPasswordWindowAction: async () => {
      windowCalls.push(dom?.window.location.hash ?? "")
      return { ok: true }
    },
  },
})

let dom: JSDOM | null = null

async function mount(passwordSet: boolean | undefined, hash = "") {
  dom = new JSDOM('<div id="root"></div>', { url: `http://localhost/settings${hash}` })
  Object.assign(globalThis, { React, window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, HTMLButtonElement: dom.window.HTMLButtonElement })
  const request = (async (url: string) => ({
    ok: true,
    data:
      url.startsWith("/catalog") ? { providers: [] }
      : url === "/state" ? { routes: [], reasons: {}, starting: false, ...(passwordSet === undefined ? {} : { passwordSet }) }
      : url === "/host-settings" ? { known: false, reason: "unavailable" }
      : {},
  })) as unknown as typeof requestReachability
  const root = createRoot(dom.window.document.querySelector("#root")!)
  const { RemoteAccessSetting } = await import("./remote-access-setting.tsx")
  await act(async () => root.render(createElement(RemoteAccessSetting, { request })))
  await act(async () => {})
  return {
    window: dom.window,
    container: dom.window.document.querySelector("#root")!,
    async stop() {
      await act(async () => root.unmount())
      dom?.window.close()
    },
  }
}

test("step 1 shows only while no password is set, and nothing can be turned on", async () => {
  const screen = await mount(false)
  try {
    const text = screen.container.textContent ?? ""
    assert.match(text, /Step 1: Set a password/)
    assert.match(text, /only\s+thing stopping them/)
    assert.doesNotMatch(text, /Step 2 of 2|Turn on remote access/)
    assert.doesNotMatch(text, /Password saved/)
  } finally {
    await screen.stop()
  }
})

test("with a password set there is no step 1 and step 2 is open", async () => {
  for (const passwordSet of [true, undefined]) {
    const screen = await mount(passwordSet)
    try {
      assert.doesNotMatch(screen.container.textContent ?? "", /Set a password|Password saved/)
      assert.match(screen.container.textContent ?? "", /Step 2 of 2/)
      assert.match(screen.container.textContent ?? "", /Turn on/)
    } finally {
      await screen.stop()
    }
  }
})

test("coming back from the password restart shows the saved note once and clears the fragment", async () => {
  const screen = await mount(true, "#remote-access")
  try {
    assert.match(screen.container.textContent ?? "", /Password saved ✓/)
    assert.equal(screen.window.location.hash, "")
    assert.equal(screen.window.location.pathname, "/settings")
  } finally {
    await screen.stop()
  }
})

test("Set password records the return fragment before the native window opens", async () => {
  windowCalls.length = 0
  const screen = await mount(false)
  try {
    const button = [...screen.container.querySelectorAll("button")].find(item => item.textContent === "Set password")!
    await act(async () => button.dispatchEvent(new screen.window.MouseEvent("click", { bubbles: true })))
    assert.deepEqual(windowCalls, ["#remote-access"])
  } finally {
    await screen.stop()
  }
})
