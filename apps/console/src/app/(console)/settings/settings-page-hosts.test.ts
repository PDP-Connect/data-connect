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
    stub("./remote-access-setting.tsx", "RemoteAccessSetting", "remote-access")
    stub("./owner-password-setting.tsx", "OwnerPasswordSetting", "owner-password")
    stub("./owner-sessions-setting.tsx", "OwnerSessionsSetting", "owner-sessions")
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
        hasValidLocalOwnerCredentialRevealProofCookie: async () => false,
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

async function render(managedDesktopHost: boolean): Promise<string> {
  const { default: SettingsPage } = await loadPage()
  const previous = process.env.PDPP_MANAGED_DESKTOP_HOST
  process.env.PDPP_MANAGED_DESKTOP_HOST = managedDesktopHost ? "1" : "0"
  try {
    return renderToStaticMarkup(await SettingsPage())
  } finally {
    if (previous === undefined) delete process.env.PDPP_MANAGED_DESKTOP_HOST
    else process.env.PDPP_MANAGED_DESKTOP_HOST = previous
  }
}

test("an unmanaged server host renders Remote access and Attach a desktop app but not Desktop or Vault recovery", async () => {
  const html = await render(false)
  assert.match(html, /Remote access/)
  assert.match(html, /data-widget="remote-access"/)
  assert.match(html, /Attach a desktop app/)
  assert.match(html, /data-widget="desktop-pairing"/)
  assert.doesNotMatch(html, /data-widget="desktop-settings"/, "Desktop widget must not render on a server")
  assert.doesNotMatch(html, /data-widget="recovery-key"/, "recovery widget must not render on a server")
  assert.doesNotMatch(html, /Vault recovery code/)
  assert.doesNotMatch(html, /Control how DataConnect starts on this computer/)
})

test("a managed desktop host renders the Desktop and Vault recovery sections alongside Remote access", async () => {
  const html = await render(true)
  assert.match(html, /data-widget="remote-access"/)
  assert.match(html, /Control how DataConnect starts on this computer/)
  assert.match(html, /data-widget="desktop-settings"/)
  assert.match(html, /Vault recovery code/)
  assert.match(html, /data-widget="recovery-key"/)
})
