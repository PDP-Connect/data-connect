// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict"
import { mock, test } from "node:test"
import * as React from "react"
import { createElement } from "react"
Object.assign(globalThis, { React })
import { renderToStaticMarkup } from "react-dom/server"

type Setting = typeof import("./owner-password-setting.tsx")

let loaded: Promise<Setting> | null = null

// The real component with the router and the server actions replaced: a
// render calls neither, but importing them needs a Next.js request.
function loadSetting(): Promise<Setting> {
  loaded ??= (async () => {
    mock.module("next/navigation", {
      namedExports: { useRouter: () => ({ refresh: () => {} }) },
    })
    mock.module(new URL("./owner-password-actions.ts", import.meta.url).href, {
      namedExports: {
        changeOwnerPasswordAction: async () => ({ ok: true }),
        requestDesktopOwnerPasswordChangeAction: async () => ({ ok: true }),
      },
    })
    mock.module(
      new URL("./owner-password-first-setup-actions.ts", import.meta.url).href,
      { namedExports: { requestOwnerPasswordWindowAction: async () => ({ ok: true }) } }
    )
    mock.module(
      new URL("./owner-credential-actions.ts", import.meta.url).href,
      {
        namedExports: {
          revealOwnerCredentialAction: async () => ({
            ok: true,
            password: "unused",
          }),
        },
      }
    )
    return await import("./owner-password-setting.tsx")
  })()
  return loaded
}

async function render(
  props: Parameters<Setting["OwnerPasswordSetting"]>[0]
): Promise<string> {
  const { OwnerPasswordSetting } = await loadSetting()
  return renderToStaticMarkup(createElement(OwnerPasswordSetting, props))
}

test("generated and chosen desktop passwords have distinct states and local actions", async () => {
  const generated = await render({ canReveal: true, passwordSet: false, source: "desktop" })
  assert.match(generated, /DataConnect made a password for you/)
  assert.match(generated, /Show password/)
  assert.match(generated, /Set password/)
  const chosen = await render({ canReveal: true, passwordSet: true, source: "desktop" })
  assert.match(chosen, /You chose this password/)
  assert.match(chosen, /Change password/)
})
test("a browser reaching the desktop gets directions without unusable controls", async () => {
  const html = await render({ canReveal: false, source: "desktop" })
  assert.match(html, /Change or show the password in the DataConnect app/)
  assert.doesNotMatch(html, /<button/)
})
test("environment passwords say where to change them without technical names or folds", async () => {
  for (const managedDesktop of [true, false]) {
    const html = await render({ managedDesktop, source: "env" })
    assert.match(html, /This password is set where DataConnect was installed/)
    assert.doesNotMatch(html, /<details|PDPP_|DATACONNECT_|<button/)
  }
})
test("setup passwords keep the current, new and confirmation form", async () => {
  const html = await render({ source: "app" })
  for (const label of ["Current password", "New password", "Confirm new password", "Change password"]) assert.ok(html.includes(label))
})
