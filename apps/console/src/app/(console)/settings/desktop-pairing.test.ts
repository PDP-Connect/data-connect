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

const KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"
const FINGERPRINT = "MMG4-2KLG-YQZW-NEIS"
const LINK = `https://x.example/settings#code=ABCD-EFGH-JKLM&key=${KEY}`

function body(overrides: Record<string, unknown> = {}) {
  return {
    code: "ABCD-EFGH-JKLM",
    expires_at: "2026-11-17T12:10:00.000Z",
    expires_in_seconds: 600,
    link: LINK,
    object: "desktop_pairing",
    server_fingerprint: FINGERPRINT,
    server_origin: "https://x.example",
    server_public_key: KEY,
    ...overrides,
  }
}

test("a well-formed pairing response parses", () => {
  assert.deepEqual(parseDesktopPairingResponse(body()), {
    code: "ABCD-EFGH-JKLM",
    expiresAt: "2026-11-17T12:10:00.000Z",
    expiresInSeconds: 600,
    link: LINK,
    serverFingerprint: FINGERPRINT,
    serverOrigin: "https://x.example",
    serverPublicKey: KEY,
  })
})

test("a link on a path other than /settings still parses when origin, code and key match", () => {
  const link = `https://x.example/anything?x=1#code=ABCD-EFGH-JKLM&key=${KEY}`
  assert.equal(parseDesktopPairingResponse(body({ link }))?.link, link)
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
    // A link on another origin, in another scheme, or carrying another code or key.
    body({ link: `https://evil.example/settings#code=ABCD-EFGH-JKLM&key=${KEY}` }),
    body({ link: `http://x.example/settings#code=ABCD-EFGH-JKLM&key=${KEY}` }),
    body({ link: `other://x.example/settings#code=ABCD-EFGH-JKLM&key=${KEY}` }),
    body({ link: `https://x.example/settings#code=WXYZ-WXYZ-WXYZ&key=${KEY}` }),
    body({ link: `https://x.example/settings#code=ABCD-EFGH-JKLM&key=${KEY.replace("A", "B")}` }),
    body({ link: "https://x.example/settings#code=ABCD-EFGH-JKLM" }),
    // The code and key must be in the fragment, not the query.
    body({ link: `https://x.example/settings?code=ABCD-EFGH-JKLM&key=${KEY}` }),
    body({ server_public_key: undefined }),
    body({ server_public_key: "short" }),
    body({ server_public_key: `${KEY}=` }),
    body({ server_fingerprint: undefined }),
    body({ server_fingerprint: "MMG4-2KLG-YQZW" }),
    body({ server_fingerprint: "mmg4-2klg-yqzw-neis" }),
    body({ server_fingerprint: "MMG4-2KLG-YQZW-NEI1" }),
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
