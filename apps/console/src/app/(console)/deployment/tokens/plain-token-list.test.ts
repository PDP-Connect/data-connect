// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict"
import test, { mock } from "node:test"
import { JSDOM } from "jsdom"
import * as React from "react"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { buildTokenPractice, tokenGroups } from "./token-model.ts"
mock.module("server-only", { namedExports: {} })
import * as navigation from "next/navigation"
mock.module("next/navigation", {
  namedExports: { ...navigation, useRouter: () => ({ refresh() {} }) },
})
mock.module(
  new URL("../../settings/owner-sessions-actions.ts", import.meta.url).href,
  { namedExports: { revokeOwnerBearerAction: async () => ({ ok: true }) } }
)
mock.module(new URL("./actions.ts", import.meta.url).href, {
  namedExports: {
    renameOwnerTokenAction: async () => {},
    revokeOwnerClientTokenAction: async () => {},
    revokeOwnerTokenAction: async () => {},
  },
})
test("large token groups show five before Show all, with a bulk removal confirmation", async () => {
  const dom = new JSDOM('<div id="root"></div>')
  Object.assign(globalThis, {
    React,
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  const root = createRoot(dom.window.document.getElementById("root")!)
  const { PlainTokenList } = await import("./plain-token-list.tsx")
  const sample = buildTokenPractice("many")!
  const groups = tokenGroups(sample.clients, sample.details, sample.owners)
  const buttons = () => [...dom.window.document.querySelectorAll("button")]
  try {
    await act(async () =>
      root.render(
        React.createElement(PlainTokenList, { groups, practice: true })
      )
    )
    await act(async () =>
      buttons()
        .find(button => button.textContent === "Show them")!
        .click()
    )
    assert.equal(dom.window.document.querySelectorAll("li li").length, 6)
    const all = buttons().find(button => button.textContent === "Show all 73")
    assert.ok(all)
    await act(async () => all.click())
    assert.equal(dom.window.document.querySelectorAll("li li").length, 73)
    assert.ok(buttons().some(button => button.textContent === "Remove all 73"))
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})
