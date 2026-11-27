// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict"
import test, { mock } from "node:test"
import * as React from "react"
import { renderToStaticMarkup } from "react-dom/server"
Object.assign(globalThis, { React })
mock.module("server-only", { namedExports: {} })
mock.module(
  new URL("../../components/recordroom-shell-with-palette.tsx", import.meta.url)
    .href,
  {
    namedExports: {
      RecordroomShellWithPalette: ({
        children,
      }: {
        children: React.ReactNode
      }) => React.createElement("main", null, children),
    },
  }
)
mock.module(
  new URL("../../sources/add/add-source-catalog-read.ts", import.meta.url).href,
  {
    namedExports: {
      readAddSourceCatalog: async () => {
        throw Error("catalog read failed (500): manifest request failed")
      },
    },
  }
)
test("a catalog read failure renders recovery text rather than rejecting the page", async () => {
  const { default: Page } = await import("./page.tsx")
  const html = renderToStaticMarkup(await Page())
  assert.match(html, /could not be loaded/i)
  assert.match(html, /Copy details for support/)
  assert.match(html, /<a [^>]*href="\/settings\/packages"[^>]*>Try again<\/a>/)
  assert.doesNotMatch(html, /manifest request|\(500\)/)
})
