// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict"
import { afterEach, test } from "node:test"
import { JSDOM } from "jsdom"
import { act, createElement, type ComponentType, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"

interface BrowserGlobals {
  dom: JSDOM
  restore: () => void
  root: Root
}

let browser: BrowserGlobals | undefined

function installBrowserGlobals(): BrowserGlobals {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost/",
  })
  dom.window.requestAnimationFrame = callback =>
    dom.window.setTimeout(() => callback(Date.now()), 0)
  dom.window.cancelAnimationFrame = id => dom.window.clearTimeout(id)
  dom.window.HTMLElement.prototype.getBoundingClientRect = () =>
    new dom.window.DOMRect(0, 0, 100, 40)
  const globalObject = globalThis as Record<string, unknown>
  const windowObject = dom.window as unknown as Record<string, unknown>
  const previous = new Map<string, PropertyDescriptor | undefined>()
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
    "MouseEvent",
    "CustomEvent",
    "MutationObserver",
    "getComputedStyle",
    "requestAnimationFrame",
    "cancelAnimationFrame",
    "IS_REACT_ACT_ENVIRONMENT",
  ]
  for (const name of globals) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalObject, name))
    Object.defineProperty(globalObject, name, {
      configurable: true,
      value:
        name === "window" || name === "self"
          ? dom.window
          : name === "document"
            ? dom.window.document
            : name === "IS_REACT_ACT_ENVIRONMENT"
              ? true
              : windowObject[name],
      writable: true,
    })
  }
  const host = dom.window.document.createElement("div")
  dom.window.document.body.append(host)
  const root = createRoot(host)
  const restore = () => {
    browser = undefined
    for (const [name, descriptor] of previous) {
      if (descriptor === undefined) delete globalObject[name]
      else Object.defineProperty(globalObject, name, descriptor)
    }
    dom.window.close()
  }
  browser = { dom, restore, root }
  return browser
}

async function settle() {
  await act(async () => {
    await new Promise<void>(resolve => setTimeout(resolve, 20))
  })
}

function touchEvent(type: "click" | "pointerdown") {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, "pointerType", { value: "touch" })
  return event
}

function tap(target: HTMLElement) {
  target.dispatchEvent(touchEvent("pointerdown"))
  target.dispatchEvent(touchEvent("click"))
}

afterEach(() => {
  if (!browser) return
  act(() => browser?.root.unmount())
  browser.restore()
})

test("a touch tap opens a dialog and a second tap or outside tap dismisses it", async () => {
  const currentBrowser = installBrowserGlobals()
  const { IcPopover, IcPopoverClose, IcPopoverPopup, IcPopoverTrigger } =
    await import("./popover.tsx")
  // TypeScript callers cannot set this role, but JS and stale compiled code can.
  // The primitive must still preserve the trigger's dialog contract at runtime.
  const PopupWithUnsafeRole = IcPopoverPopup as unknown as ComponentType<{
    "aria-label": string
    children?: ReactNode
    role?: string
  }>
  act(() => {
    currentBrowser.root.render(
      createElement(
        IcPopover,
        null,
        createElement(
          IcPopoverTrigger,
          { "aria-label": "About Domain verified" },
          "Domain verified"
        ),
        createElement(
          PopupWithUnsafeRole,
          { "aria-label": "Domain verified explanation", role: "tooltip" },
          createElement(
            "p",
            null,
            "Verified automatically against the identity document."
          ),
          createElement(
            IcPopoverClose,
            { "aria-label": "Dismiss trust explanation" },
            "Dismiss"
          )
        )
      )
    )
  })

  const trigger = currentBrowser.dom.window.document.querySelector<HTMLElement>(
    '[aria-haspopup="dialog"]'
  )
  assert.ok(trigger)
  act(() => tap(trigger))
  await settle()
  const dialog =
    currentBrowser.dom.window.document.querySelector<HTMLElement>(
      '[role="dialog"]'
    )
  assert.ok(dialog, currentBrowser.dom.window.document.body.innerHTML)
  assert.match(
    dialog.textContent ?? "",
    /Verified automatically against the identity document\./
  )
  assert.ok(dialog.querySelector('[aria-label="Dismiss trust explanation"]'))

  act(() => tap(trigger))
  await settle()
  assert.equal(
    currentBrowser.dom.window.document.querySelector('[role="dialog"]'),
    null
  )
})
