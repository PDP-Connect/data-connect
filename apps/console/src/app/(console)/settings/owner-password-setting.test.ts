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

test("a desktop-managed password says DataConnect keeps it, not that an env var sets it", async () => {
  const html = await render({ canReveal: true, source: "desktop" })
  assert.match(html, /keeps it in your system\s+keychain/)
  assert.match(html, /Reveal password/)
  assert.match(html, /Set a new password/)
  assert.match(html, /Your computer asks you to confirm first\./)
  assert.match(html, /signs out every other browser and\s+command-line token/)
  assert.doesNotMatch(html, /PDPP_OWNER_PASSWORD/)
})

test("reveal appears only where the desktop webview can prove it is local", async () => {
  const html = await render({ canReveal: false, source: "desktop" })
  assert.doesNotMatch(html, /Reveal password/)
  assert.match(html, /Set a new password/)
})

test("on Linux the desktop copy says there is no OS prompt yet and change stays available", async () => {
  const html = await render({
    canReveal: true,
    linuxNoOsPrompt: true,
    source: "desktop",
  })
  assert.match(html, /No OS prompt on Linux yet\./)
  assert.match(html, /Reveal password/)
  assert.match(html, /<button[^>]*type="button"[^>]*>Set a new password</)
  assert.doesNotMatch(html, /<button[^>]*disabled=""[^>]*>Set a new password</)
})

test("an operator's PDPP_OWNER_PASSWORD keeps the env copy", async () => {
  const html = await render({ source: "env" })
  assert.match(
    html,
    /Password change is disabled because this install uses\s+<code>PDPP_OWNER_PASSWORD<\/code>/
  )
  assert.match(html, /restart the server/)
})

test("a desktop started with an owner password env var names both variables and DataConnect", async () => {
  const html = await render({ managedDesktop: true, source: "env" })
  assert.match(html, /DATACONNECT_OWNER_PASSWORD/)
  assert.match(html, /restart DataConnect/)
  assert.doesNotMatch(html, /restart the server/)
})
