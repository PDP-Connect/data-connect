// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict"
import test from "node:test"
import {
  offRemoteAccessConfig,
  privacyBadgeForPosture,
  remoteAccessRequiresOwnerPassword,
  validateUserSuppliedOrigin,
} from "./remote-access.ts"

test("user-supplied origins normalize the four reachability fields", () => {
  assert.deepEqual(
    validateUserSuppliedOrigin(" https://vault.example.com:8443/ "),
    {
      ok: true,
      origin: "https://vault.example.com:8443",
      host: "vault.example.com",
      fields: {
        PDPP_REFERENCE_ORIGIN: "https://vault.example.com:8443",
        PDPP_TRUSTED_HOSTS: "vault.example.com",
        PDPP_TRUSTED_PROXIES: "",
        PDPP_BIND_HOST: "127.0.0.1",
      },
    }
  )
})

test("origin validation refuses paths, non-HTTPS values, credentials, and loopback", () => {
  for (const value of [
    "https://vault.example.com/mcp",
    "http://vault.example.com",
    "https://user:secret@vault.example.com",
    "https://127.0.0.1:8443",
    "vault.example.com",
  ]) {
    const result = validateUserSuppliedOrigin(value)
    assert.equal(result.ok, false, value)
  }
})

test("every posture carries an explicit non-unknown privacy badge", () => {
  for (const posture of ["off", "my_devices_only", "public_url"] as const) {
    assert.match(
      privacyBadgeForPosture(posture),
      /^Provider (cannot|can) read your data$/
    )
  }
})

test("remote posture selection requires an owner password in either remote direction", () => {
  assert.equal(
    remoteAccessRequiresOwnerPassword("off", "my_devices_only"),
    true
  )
  assert.equal(remoteAccessRequiresOwnerPassword("off", "public_url"), true)
  assert.equal(remoteAccessRequiresOwnerPassword("public_url", "off"), false)
})

test("off is a loopback-only empty contract", () => {
  assert.deepEqual(offRemoteAccessConfig(), {
    posture: "off",
    provider: null,
    fields: {
      PDPP_REFERENCE_ORIGIN: null,
      PDPP_TRUSTED_HOSTS: "",
      PDPP_TRUSTED_PROXIES: "",
      PDPP_BIND_HOST: "127.0.0.1",
    },
  })
})
