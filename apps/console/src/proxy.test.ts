// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict"
import test from "node:test"
import { isAllowedConsoleHostFor } from "./proxy.ts"

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
  assert.equal(
    isAllowedConsoleHostFor("VAULT.LOCAL:8443", "192.168.1.42", ["vault.local"]),
    true
  )
})
