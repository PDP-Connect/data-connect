// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict"
import { mock, test } from "node:test"
import * as React from "react"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"

// The vendored operator-ui primitives use the classic JSX runtime.
Object.assign(globalThis, { React })

type Page = typeof import("./page.tsx")

let loaded: Promise<Page> | null = null
// Whether the request carries the desktop window's reveal proof cookie.
let revealProof = false

// The real settings page and real Section chrome, rendered per host. Replaced:
// the shell (needs the command-palette context), the data loaders (need a
// Next.js request), and each setting widget (marker stubs; the widgets call
// server actions). What this pins is which widgets the page composes per host.
function loadPage(): Promise<Page> {
  loaded ??= (async () => {
    const stub = (path: string, exportName: string, marker: string) =>
      mock.module(new URL(path, import.meta.url).href, {
        namedExports: {
          [exportName]: () => createElement("div", { "data-widget": marker }),
        },
      })
    mock.module(new URL("./settings-summary-data.ts", import.meta.url).href, { namedExports: { loadSettingsSummary: async () => ({ tokens: 2, collectors: 4, webhooks: 0, updates: 0, publicAddress: null }) } })
    stub("./remote-access-setting.tsx", "RemoteAccessSetting", "remote-access")
    stub("./owner-password-setting.tsx", "OwnerPasswordSetting", "owner-password")
    stub("./signed-in-sessions.tsx", "SignedInSessions", "owner-sessions")
    stub("./desktop-pairing-setting.tsx", "DesktopPairingSetting", "desktop-pairing")
    stub("./desktop-settings-setting.tsx", "DesktopSettingsSetting", "desktop-settings")
    stub("./recovery-key-setting.tsx", "RecoveryKeySetting", "recovery-key")
    mock.module(
      new URL("../components/recordroom-shell-with-palette.tsx", import.meta.url).href,
      {
        namedExports: {
          RecordroomShellWithPalette: ({ children }: { children: React.ReactNode }) =>
            createElement("div", null, children),
        },
      }
    )
    mock.module(new URL("../lib/owner-credential-client.ts", import.meta.url).href, {
      namedExports: {
        hasValidLocalOwnerCredentialRevealProofCookie: async () => revealProof,
      },
    })
    mock.module(new URL("./owner-sessions-data.ts", import.meta.url).href, {
      namedExports: {
        loadOwnerSessionInventory: async () => ({ bearers: [], enabled: true, sessions: [] }),
      },
    })
    mock.module(new URL("./owner-password-data.ts", import.meta.url).href, {
      namedExports: { loadOwnerPasswordSource: async () => "app", loadOwnerPasswordSet: async () => true },
    })
    return await import("./page.tsx")
  })()
  return loaded
}

async function render(managedDesktopHost: boolean, inDesktopWindow = managedDesktopHost): Promise<string> {
  const { default: SettingsPage } = await loadPage()
  const previous = process.env.PDPP_MANAGED_DESKTOP_HOST
  process.env.PDPP_MANAGED_DESKTOP_HOST = managedDesktopHost ? "1" : "0"
  revealProof = inDesktopWindow
  try {
    return renderToStaticMarkup(await SettingsPage({}))
  } finally {
    revealProof = false
    if (previous === undefined) delete process.env.PDPP_MANAGED_DESKTOP_HOST
    else process.env.PDPP_MANAGED_DESKTOP_HOST = previous
  }
}

test("an unmanaged server host renders Remote access and Connect a DataConnect app on another computer but not Desktop or Vault recovery", async () => {
  const html = await render(false)
  assert.match(html, /Remote access/)
  assert.match(html, /Remote access/)
  assert.match(html, /data-widget="desktop-pairing"/)
  assert.match(html, /data-widget="desktop-pairing"/)
  assert.doesNotMatch(html, /data-widget="desktop-settings"/, "Desktop widget must not render on a server")
  assert.doesNotMatch(html, /data-widget="recovery-key"/, "recovery widget must not render on a server")
  assert.doesNotMatch(html, /Recovery code/)
  assert.doesNotMatch(html, /Control how DataConnect starts on the computer that runs it/)
})

test("in the desktop app window a managed desktop host renders the Desktop and Vault recovery sections alongside Remote access", async () => {
  const html = await render(true)
  assert.match(html, /data-widget="remote-access"/)
  assert.match(html, /Control how DataConnect starts on the computer that runs it/)
  assert.match(html, /data-widget="desktop-settings"/)
  assert.match(html, /Recovery code/)
  assert.match(html, /data-widget="recovery-key"/)
})

test("a browser reaching a managed desktop host over remote access still renders the Desktop section", async () => {
  // Owner-password sign-in only, no desktop reveal proof: the case
  // e2e/live-settings.spec.ts drives from a second device.
  const html = await render(true, false)
  assert.match(html, /data-widget="remote-access"/)
  assert.match(html, /data-widget="desktop-settings"/)
  // cc963a0ef8: "this computer" is false from a phone; keep "the computer that runs it".
  assert.match(html, /Control how DataConnect starts on the computer that runs it/)
  assert.match(html, /data-widget="recovery-key"/)
})

test("settings keeps the required section order and links to access tokens", async () => {
  const html = await render(true)
  const order = ["Remote access", "Password and sign-in", "Notifications", "This computer", "Updates", "Advanced", "About"]
  // Brief settings-pages, decision 1: these sections stay in this order; Desktop remains host-gated.
  const positions = order.map((label) => html.indexOf(label))
  assert.ok(positions.every((position) => position >= 0))
  assert.deepEqual(positions, [...positions].sort((left, right) => left - right))
  // Brief settings-pages, decision 3: the Access tokens row opens the unchanged address.
  assert.match(html, /href="\/deployment\/tokens"[\s\S]*?Tokens for scripts and tools/)
})
