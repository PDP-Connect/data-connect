// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict"
import { mock, test } from "node:test"
import { createElement } from "react"
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

test("desktop password copy describes local storage without naming a storage mechanism", async () => {
  const html = await render({ canReveal: true, source: "desktop" })
  assert.match(html, /stores this password on this computer for signing in\s+on other devices/)
  assert.match(html, /Reveal password/)
  assert.match(html, /Change password/)
  // RAISE-RULES.md 4: use plain words for the access this password ends.
  assert.match(html, /signs out other browser sessions and\s+access tokens/)
  assert.match(html, /Make sure no one else can see your screen/)
  assert.doesNotMatch(html, /keychain/)
  assert.equal((html.match(/signing in\s+on other devices/g) ?? []).length, 1)
  assert.doesNotMatch(html, /PDPP_OWNER_PASSWORD/)
})

test("reveal appears only where the desktop webview can prove it is local", async () => {
  const html = await render({ canReveal: false, source: "desktop" })
  assert.doesNotMatch(html, /Reveal password/)
  assert.match(html, /Change password/)
})

test("the desktop copy omits the Linux OS prompt message and change stays available", async () => {
  const html = await render({
    canReveal: true,
    source: "desktop",
  })
  assert.match(html, /Reveal password/)
  assert.match(html, /<button[^>]*type="button"[^>]*>Change password</)
  assert.doesNotMatch(html, /No OS prompt on Linux yet\./)
})

test("an operator's PDPP_OWNER_PASSWORD keeps the env copy", async () => {
  const html = await render({ source: "env" })
  // DIRECTION.md Values: keep monospace environment names inside folded Details.
  assert.match(html, /Change this password in the server environment, then restart the server\./)
  assert.match(html, /<details>[\s\S]*<code>PDPP_OWNER_PASSWORD<\/code>[\s\S]*<\/details>/)
  assert.match(
    html,
    /Password changes are disabled while\s+<code>PDPP_OWNER_PASSWORD<\/code> is set\./
  )
})

test("a desktop started with an owner password env var names both variables and DataConnect", async () => {
  const html = await render({ managedDesktop: true, source: "env" })
  // RAISE-RULES.md 2 and DIRECTION.md Values: show one plain instruction and fold technical names.
  assert.match(html, /Change this password in the server environment, then restart DataConnect\./)
  assert.match(html, /<details>[\s\S]*DATACONNECT_OWNER_PASSWORD[\s\S]*PDPP_OWNER_PASSWORD[\s\S]*<\/details>/)
  assert.match(html, /DATACONNECT_OWNER_PASSWORD/)
  assert.match(html, /restart DataConnect/)
})

test("the desktop button says Set password until the owner has set one, then Change password", async () => {
  const unset = await render({ canReveal: true, passwordSet: false, source: "desktop" })
  assert.match(unset, /<button[^>]*type="button"[^>]*>Set password</)
  assert.doesNotMatch(unset, /Change password/)
  const set = await render({ canReveal: true, passwordSet: true, source: "desktop" })
  assert.match(set, /<button[^>]*type="button"[^>]*>Change password</)
  assert.doesNotMatch(set, /Set password/)
  const unspecified = await render({ canReveal: true, source: "desktop" })
  assert.match(unspecified, />Change password</)
})
