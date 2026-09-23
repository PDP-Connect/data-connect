// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict"
import test from "node:test"
import { OWNER_AUTH_COOKIE_NAME } from "pdpp-reference-implementation/owner-session-constants"
import proxy, { isAllowedConsoleHostFor } from "./proxy.ts"

test("loopback bind host allows any request Host (regression guard: today's default posture)", () => {
  assert.equal(isAllowedConsoleHostFor("127.0.0.1:3001", "", []), true)
  assert.equal(isAllowedConsoleHostFor("127.0.0.1:3001", "127.0.0.1", []), true)
  assert.equal(isAllowedConsoleHostFor("attacker.example:3001", "127.0.0.1", []), true)
  assert.equal(isAllowedConsoleHostFor("attacker.example:3001", "localhost", []), true)
})

test("LAN bind host allows a request naming the bind address itself", () => {
  assert.equal(
    isAllowedConsoleHostFor("192.168.1.42:3001", "192.168.1.42", ["192.168.1.42"]),
    true
  )
})

test("LAN bind host allows a request naming a trusted host", () => {
  assert.equal(
    isAllowedConsoleHostFor("192.168.1.42:3001", "192.168.1.42", ["192.168.1.42", "vault.local"]),
    true
  )
})

test("LAN bind host rejects an attacker-controlled Host (DNS-rebinding shape)", () => {
  assert.equal(
    isAllowedConsoleHostFor("attacker.example:3001", "192.168.1.42", ["192.168.1.42"]),
    false
  )
})

test("LAN bind host rejects a request naming a different LAN address than the one bound", () => {
  assert.equal(
    isAllowedConsoleHostFor("192.168.1.99:3001", "192.168.1.42", ["192.168.1.42"]),
    false
  )
})

test("Host comparison ignores the port and is case-insensitive", () => {
  assert.equal(isAllowedConsoleHostFor("VAULT.LOCAL:8443", "192.168.1.42", ["vault.local"]), true)
})

function settingsRequest(cookie?: string): Parameters<typeof proxy>[0] {
  const headers = new Headers({ host: "console.test" })
  if (cookie) {
    headers.set("cookie", `${OWNER_AUTH_COOKIE_NAME}=${cookie}`)
  }

  const url = new URL("http://console.test/settings")
  return {
    headers,
    nextUrl: url,
    cookies: {
      get(name: string) {
        const value = headers
          .get("cookie")
          ?.split(";")
          .map(part => part.trim())
          .find(part => part.startsWith(`${name}=`))
          ?.slice(name.length + 1)
        return value ? { name, value } : undefined
      },
    },
  } as Parameters<typeof proxy>[0]
}

test("settings redirects signed-out owners and lets signed-in owners through", () => {
  const signedOut = proxy(settingsRequest())
  assert.equal(signedOut.status, 307)
  assert.equal(new URL(signedOut.headers.get("location") ?? "").pathname, "/owner/login")

  const signedIn = proxy(settingsRequest("session"))
  assert.equal(signedIn.status, 200)
  assert.equal(signedIn.headers.get("location"), null)
})
