// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { mock, test } from "node:test"

// A stand-in RI that answers GET /owner/password with `riSource`.
let riSource = "app"
let riRequests = 0
const ri = createServer((request, response) => {
  riRequests += 1
  assert.equal(request.url, "/owner/password")
  response.setHeader("Content-Type", "application/json")
  response.end(JSON.stringify({ object: "owner_password", source: riSource }))
})

let loaded: Promise<typeof import("./owner-password-data.ts")> | null = null

// Loads the real loader with only its session and URL helpers replaced,
// pointed at the stand-in RI.
function loadOwnerPasswordData(): Promise<
  typeof import("./owner-password-data.ts")
> {
  loaded ??= (async () => {
    await new Promise<void>(resolve => ri.listen(0, "127.0.0.1", resolve))
    const riUrl = `http://127.0.0.1:${(ri.address() as AddressInfo).port}`
    mock.module("server-only", { namedExports: {} })
    mock.module(new URL("../lib/dashboard-access.ts", import.meta.url).href, {
      namedExports: { requireDashboardAccess: async () => {} },
    })
    mock.module(new URL("../lib/login-redirect.ts", import.meta.url).href, {
      namedExports: {
        redirectToOwnerLogin: async () => {
          throw new Error("unexpected login redirect")
        },
      },
    })
    mock.module(new URL("../lib/owner-token.ts", import.meta.url).href, {
      namedExports: {
        getAsInternalUrl: () => riUrl,
        withOwnerSessionCookie: async (init: RequestInit = {}) => init,
      },
    })
    return await import("./owner-password-data.ts")
  })()
  return loaded
}

test.after(() => ri.close())

// The console used to answer "desktop" from its own environment. In
// v0.7.59 that environment lacked the flags, so it asked the RI, which said
// "env". The RI is now the one source, whatever the console's environment.
test("the console takes the owner password source from the RI, not from its own environment", async () => {
  const saved = {
    host: process.env.PDPP_MANAGED_DESKTOP_HOST,
    source: process.env.PDPP_OWNER_PASSWORD_SOURCE,
  }
  process.env.PDPP_MANAGED_DESKTOP_HOST = "1"
  process.env.PDPP_OWNER_PASSWORD_SOURCE = "desktop_generated"
  const { loadOwnerPasswordSource } = await loadOwnerPasswordData()
  try {
    riSource = "app"
    assert.equal(await loadOwnerPasswordSource(), "app")
    riSource = "env"
    assert.equal(await loadOwnerPasswordSource(), "env")
    riSource = "desktop"
    assert.equal(await loadOwnerPasswordSource(), "desktop")
    assert.equal(riRequests, 3)
  } finally {
    for (const [name, value] of [
      ["PDPP_MANAGED_DESKTOP_HOST", saved.host],
      ["PDPP_OWNER_PASSWORD_SOURCE", saved.source],
    ] as const) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
})

test("the console accepts the RI's desktop source without any desktop flags of its own", async () => {
  delete process.env.PDPP_MANAGED_DESKTOP_HOST
  delete process.env.PDPP_OWNER_PASSWORD_SOURCE
  const { loadOwnerPasswordSource } = await loadOwnerPasswordData()
  riSource = "desktop"
  assert.equal(await loadOwnerPasswordSource(), "desktop")
})
