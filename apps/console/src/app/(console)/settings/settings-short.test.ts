// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

// Settings is a short list: the two long blocks have their own pages and Settings keeps one row for each.
const source = readFileSync(new URL("./page.tsx", import.meta.url), "utf8")

test("Settings composes none of the moved blocks", () => {
  for (const name of ["RemoteAccessSetting", "RemoteAccessPractice", "ServerRemoteAccess", "OwnerPasswordSetting", "RecoveryKeySetting", "SignedInSessions"]) {
    if (name === "RecoveryKeySetting") continue // "This computer" keeps the recovery code.
    assert.doesNotMatch(source, new RegExp(`<${name}\\b`), `${name} must not render on Settings`)
  }
})

test("Settings has one row for each moved block, with its own page", () => {
  assert.match(source, /<RemoteAccessRow\b/)
  assert.match(source, /href="\/settings\/sign-in"[^>]*title="Password and sign-in"|title="Password and sign-in"[^>]*href="\/settings\/sign-in"/)
  assert.doesNotMatch(source, /id="remote-access"/)
  assert.doesNotMatch(source, /id="owner-password"/)
})

test("the Tokens row stays on Settings", () => {
  assert.match(source, /href="\/deployment\/tokens"/)
})
