// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { ConsolePortSetting } from "./console-port-setting.tsx"
import type { ConsolePortStatus } from "./remote-access.ts"

const HERE = fileURLToPath(new URL(".", import.meta.url))

function render(status: ConsolePortStatus, pinnedPort: number | null = null): string {
  return renderToStaticMarkup(
    createElement(ConsolePortSetting, {
      busy: false,
      onPin: async () => null,
      pinnedPort,
      status,
    })
  )
}

test("a moved console names both ports in an alert", () => {
  const html = render({ kind: "moved", port: 41000, stablePort: 7664 })
  assert.match(html, /role="alert"/)
  assert.match(html, /Port 7664 was in use/)
  assert.match(html, /http:\/\/127\.0\.0\.1:41000/)
})

test("the address the owner must paste is shown with a copy control", () => {
  const html = render({ kind: "kept", port: 7664 })
  assert.match(html, /select-all[^>]*>http:\/\/127\.0\.0\.1:7664</)
  assert.match(html, />Copy</)
  assert.match(html, /keeps this port across restarts/)
  assert.match(html, /Pin a port/)
  assert.doesNotMatch(html, />Unpin</)
})

test("a pinned port offers Unpin", () => {
  const html = render({ kind: "pinned", port: 38739 }, 38739)
  assert.match(html, /Pinned\./)
  assert.match(html, />Unpin</)
})

test("a host without the desktop supervisor gets no stability claim and no pin control", () => {
  const html = render({ kind: "environment", port: 3000 })
  assert.match(html, /environment sets this port/)
  assert.doesNotMatch(html, /Pin a port/)
})

test("the port control has no provider-specific branch", async () => {
  // Comments may name providers; code may not branch on them.
  const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
  const source = code(await readFile(`${HERE}console-port-setting.tsx`, "utf8"))
  assert.doesNotMatch(source, /["'](ngrok|cloudflare_tunnel|user_supplied_origin)["']|\bprovider\b/)
  const setting = code(await readFile(`${HERE}remote-access-setting.tsx`, "utf8"))
  const site = setting.slice(setting.indexOf("{effectiveConsolePort != null ? ("), setting.indexOf("<ConsolePortSetting"))
  assert.ok(site.length > 0, "ConsolePortSetting must be rendered")
  assert.doesNotMatch(site, /provider/, "ConsolePortSetting must not be gated on a provider id")
})
