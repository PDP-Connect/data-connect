// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict"
import test, { mock } from "node:test"
import { JSDOM } from "jsdom"
import * as React from "react"
import { act, createElement } from "react"

mock.module(new URL("./recovery-key-actions.ts", import.meta.url).href, {
  namedExports: {
    exportRecoveryKitAction: async () => {
      throw new Error("practice must not call the live action")
    },
  },
})

type Result =
  | { ok: true; code: string }
  | { ok: false; reason: "wrong" | "not-set" | "too-many" | "failed"; message: string }

async function mountSetting(
  props: Record<string, unknown>,
  run: (ctx: {
    container: Element
    press: (label: string) => Promise<void>
    type: (value: string) => Promise<void>
    submit: () => Promise<void>
  }) => Promise<void>
) {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost/settings" })
  Object.assign(globalThis, {
    HTMLButtonElement: dom.window.HTMLButtonElement,
    HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    Element: dom.window.Element,
    React,
    document: dom.window.document,
    window: dom.window,
  })
  const container = dom.window.document.querySelector("#root")
  assert.ok(container)
  // Loaded after the page globals exist, so React detects input events.
  const { createRoot } = await import("react-dom/client")
  const root = createRoot(container)
  const { RecoveryKeySetting } = await import("./recovery-key-setting.tsx")
  try {
    await act(async () => root.render(createElement(RecoveryKeySetting, props)))
    await run({
      container,
      press: async label => {
        const button = [...container.querySelectorAll("button")].find(row => row.textContent?.startsWith(label))
        assert.ok(button, `no button "${label}" in: ${container.textContent}`)
        await act(async () => button.click())
      },
      submit: async () => {
        const form = container.querySelector("form")
        assert.ok(form)
        await act(async () => {
          form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }))
        })
      },
      type: async value => {
        const input = container.querySelector("input")
        assert.ok(input)
        const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")?.set
        await act(async () => {
          setter?.call(input, value)
          input.dispatchEvent(new dom.window.Event("input", { bubbles: true }))
        })

      },
    })
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
}

const PASSWORD = "do-not-keep-this-password"

test("pressing the button opens the password field in place and asks nothing yet", async () => {
  let calls = 0
  await mountSetting({ exportKit: async () => { calls++; return { ok: true, code: "X" } } }, async ({ container, press }) => {
    assert.equal(container.querySelector("input"), null)
    await press("Show recovery code")
    assert.match(container.textContent ?? "", /Enter your password to show your recovery code/)
    assert.equal(container.querySelector("input")?.getAttribute("type"), "password")
    assert.ok([...container.querySelectorAll("button")].some(row => row.textContent === "Show recovery code"))
    assert.ok([...container.querySelectorAll("button")].some(row => row.textContent === "Cancel"))
    assert.equal(calls, 0)
  })
})

test("Cancel closes the field without a call", async () => {
  let calls = 0
  await mountSetting({ exportKit: async () => { calls++; return { ok: true, code: "X" } } }, async ({ container, press }) => {
    await press("Show recovery code")
    await press("Cancel")
    assert.equal(container.querySelector("input"), null)
    assert.equal(calls, 0)
  })
})

test("the right password shows the code, clears the field and keeps the password out of the page", async () => {
  const seen: string[] = []
  const exportKit = async (password: string): Promise<Result> => { seen.push(password); return { ok: true, code: "0200-0000-036B-6579-E5EA" } }
  await mountSetting({ exportKit }, async ({ container, press, type, submit }) => {
    await press("Show recovery code")
    await type(PASSWORD)
    await submit()
    assert.deepEqual(seen, [PASSWORD])
    assert.match(container.textContent ?? "", /0200-0000-036B-6579-E5EA/)
    assert.doesNotMatch(container.innerHTML, new RegExp(PASSWORD, "u"))
    assert.equal(container.querySelector("input"), null)
  })
})

test("a wrong password shows the sentence, clears the field and shows no code", async () => {
  const exportKit = async (): Promise<Result> => ({ ok: false, reason: "wrong", message: "That password isn't right." })
  await mountSetting({ exportKit }, async ({ container, press, type, submit }) => {
    await press("Show recovery code")
    await type(PASSWORD)
    await submit()
    assert.match(container.textContent ?? "", /That password isn't right\./)
    assert.equal((container.querySelector("input") as HTMLInputElement | null)?.value, "")
    assert.doesNotMatch(container.innerHTML, new RegExp(PASSWORD, "u"))
    assert.equal(container.querySelector("pre"), null)
  })
})

test("no password set says to choose one and links to sign-in settings", async () => {
  const exportKit = async (): Promise<Result> => ({ ok: false, reason: "not-set", message: "Choose a password first." })
  await mountSetting({ exportKit }, async ({ container, press, type, submit }) => {
    await press("Show recovery code")
    await type(PASSWORD)
    await submit()
    assert.match(container.textContent ?? "", /Choose a password first\./)
    assert.equal(container.querySelector('a[href="/settings/sign-in"]')?.textContent?.length ? true : false, true)
    assert.doesNotMatch(container.innerHTML, new RegExp(PASSWORD, "u"))
  })
})

test("a password DataConnect made adds the pointer to Password and sign-in", async () => {
  await mountSetting({ passwordSource: "desktop" }, async ({ container, press }) => {
    await press("Show recovery code")
    assert.match(container.textContent ?? "", /You can see your password under Password and sign-in\./)
    assert.ok(container.querySelector('a[href="/settings/sign-in"]'))
  })
  await mountSetting({ passwordSource: "app" }, async ({ container, press }) => {
    await press("Show recovery code")
    assert.doesNotMatch(container.textContent ?? "", /You can see your password under/)
  })
})

test("an unknown failure keeps its raw text out of the page body", async () => {
  const exportKit = async (): Promise<Result> => ({ ok: false, reason: "failed", message: "internal_failure_code /private/host/path" })
  await mountSetting({ exportKit }, async ({ container, press, type, submit }) => {
    await press("Show recovery code")
    await type(PASSWORD)
    await submit()
    assert.match(container.textContent ?? "", /Could not show the recovery code\. Try again\./)
    assert.doesNotMatch(container.textContent ?? "", /internal_failure_code/)
  })
})

for (const [state, expected] of [
  ["asking", /Enter your password to show your recovery code/],
  ["wrong", /That password isn't right\./],
  ["no-password", /Choose a password first\./],
  ["shown", /0200-0000-036B-6579-E5EA/],
] as const) {
  test(`practice state ${state} renders its own words and never calls the live action`, async () => {
    await mountSetting({ practice: true, practiceState: state }, async ({ container, type, submit }) => {
      assert.match(container.textContent ?? "", expected)
      if (state !== "shown") {
        await type(PASSWORD)
        await submit()
        assert.doesNotMatch(container.innerHTML, new RegExp(PASSWORD, "u"))
      }
    })
  })
}
