// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict"
import { test } from "node:test"
import {
  countdownLabel,
  formatCountdown,
  parseDesktopPairingResponse,
  secondsRemaining,
} from "./desktop-pairing.ts"

function body(overrides: Record<string, unknown> = {}) {
  return {
    code: "ABCD-EFGH-JKLM",
    expires_at: "2026-11-17T12:10:00.000Z",
    expires_in_seconds: 600,
    link: "vana://attach?server=https%3A%2F%2Fx.example&code=ABCD-EFGH-JKLM",
    object: "desktop_pairing",
    server_origin: "https://x.example",
    ...overrides,
  }
}

test("a well-formed pairing response parses", () => {
  assert.deepEqual(parseDesktopPairingResponse(body()), {
    code: "ABCD-EFGH-JKLM",
    expiresAt: "2026-11-17T12:10:00.000Z",
    expiresInSeconds: 600,
    link: "vana://attach?server=https%3A%2F%2Fx.example&code=ABCD-EFGH-JKLM",
    serverOrigin: "https://x.example",
  })
})

test("malformed pairing responses are rejected", () => {
  const bad: unknown[] = [
    null,
    "text",
    [],
    body({ object: "something_else" }),
    body({ code: "abcd-efgh-jklm" }),
    body({ code: "ABCD-EFGH-JKL0" }), // 0 and 1 are not in the alphabet
    body({ code: "ABCDEFGHJKLM" }),
    body({ code: 7 }),
    body({ link: "https://evil.example/attach?code=ABCD-EFGH-JKLM" }),
    body({ link: "vana://other?code=ABCD-EFGH-JKLM" }),
    body({ link: "vana://attach?server=https%3A%2F%2Fx.example&code=WXYZ-WXYZ-WXYZ" }),
    body({ expires_at: "not a date" }),
    body({ expires_at: undefined }),
    body({ expires_in_seconds: 0 }),
    body({ expires_in_seconds: "600" }),
    body({ server_origin: "javascript:alert(1)" }),
    body({ server_origin: "nope" }),
  ]
  for (const candidate of bad) {
    assert.equal(
      parseDesktopPairingResponse(candidate),
      null,
      JSON.stringify(candidate)
    )
  }
})

test("secondsRemaining rounds up and never goes below zero", () => {
  assert.equal(secondsRemaining(10_000, 0), 10)
  assert.equal(secondsRemaining(10_000, 9_001), 1)
  assert.equal(secondsRemaining(10_000, 10_000), 0)
  assert.equal(secondsRemaining(10_000, 99_000), 0)
})

test("formatCountdown pads seconds", () => {
  assert.equal(formatCountdown(582), "9:42")
  assert.equal(formatCountdown(600), "10:00")
  assert.equal(formatCountdown(65), "1:05")
  assert.equal(formatCountdown(9), "0:09")
  assert.equal(formatCountdown(-4), "0:00")
})

test("countdownLabel flips to the expired text at zero", () => {
  assert.equal(countdownLabel(582), "Expires in 9:42")
  assert.equal(countdownLabel(1), "Expires in 0:01")
  assert.equal(countdownLabel(0), "Expired. Create a new code.")
})
