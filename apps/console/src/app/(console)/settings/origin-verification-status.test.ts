// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { OriginVerificationStatus } from "./origin-verification-status.tsx"
import type { OriginVerificationDisplay } from "./remote-access.ts"

function render(binding: OriginVerificationDisplay["binding"]): string {
  return renderToStaticMarkup(
    createElement(OriginVerificationStatus, {
      consolePort: 7664,
      display: { agentExited: false, binding, reading: { kind: "unverified" } },
      origin: "https://vault.example.com",
    })
  )
}

test("an owner-maintained binding with a link renders it next to the instruction", () => {
  const html = render({
    kind: "owner_maintained",
    where_to_set: "the route (Tunnels > this tunnel > Routes)",
    action_url: "https://dash.example.com/?to=/:account/tunnels",
  })
  assert.match(html, /Set it in the route \(Tunnels &gt; this tunnel &gt; Routes\)/)
  assert.match(html, /<a href="https:\/\/dash\.example\.com\/\?to=\/:account\/tunnels"[^>]*>Open in browser<\/a>/)
  assert.match(html, /select-all[^>]*>http:\/\/127\.0\.0\.1:7664</)
})

test("an owner-maintained binding without a link renders the instruction alone", () => {
  const html = render({
    kind: "owner_maintained",
    where_to_set: "the upstream (target) setting of your reverse proxy",
    action_url: null,
  })
  assert.match(html, /Set it in the upstream \(target\) setting of your reverse proxy/)
  assert.match(html, /select-all[^>]*>http:\/\/127\.0\.0\.1:7664</)
  assert.doesNotMatch(html, /<a /)
})
