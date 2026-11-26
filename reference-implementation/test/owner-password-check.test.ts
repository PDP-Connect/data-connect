// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict"
import test from "node:test"

import { createOwnerPasswordCheck } from "../server/owner-password-check.ts"
import { createOwnerPasswordVerifier } from "../server/owner-password-verifier.ts"

const PASSWORD = "a-long-enough-password"
const req = { headers: {}, socket: { remoteAddress: "203.0.113.9" } }

test("checks the stored verifier with the sign-in verifier", async () => {
  const verifier = await createOwnerPasswordVerifier(PASSWORD)
  const check = createOwnerPasswordCheck({ loginRateLimit: {}, store: { readVerifier: async () => verifier } })
  assert.equal(await check.isSet(), true)
  assert.deepEqual(await check.check(req, PASSWORD), { status: "ok" })
  assert.deepEqual(await check.check(req, "wrong-password-entirely"), { status: "invalid" })
})

test("checks a plain configured password", async () => {
  const check = createOwnerPasswordCheck({ loginRateLimit: {}, password: PASSWORD })
  assert.equal(await check.isSet(), true)
  assert.deepEqual(await check.check(req, PASSWORD), { status: "ok" })
  assert.deepEqual(await check.check(req, `${PASSWORD}x`), { status: "invalid" })
})

test("reports no password set when neither a password nor a verifier exists", async () => {
  const check = createOwnerPasswordCheck({ loginRateLimit: {}, store: { readVerifier: async () => null } })
  assert.equal(await check.isSet(), false)
})

test("locks out after the sign-in attempt budget and clears on success", async () => {
  const verifier = await createOwnerPasswordVerifier(PASSWORD)
  const check = createOwnerPasswordCheck({
    loginRateLimit: { max: 2, maxLocal: 2, windowMs: 60_000 },
    store: { readVerifier: async () => verifier },
  })
  assert.deepEqual(await check.check(req, "bad-one-bad-one-bad"), { status: "invalid" })
  assert.deepEqual(await check.check(req, "bad-two-bad-two-bad"), { status: "invalid" })
  const locked = await check.check(req, PASSWORD)
  assert.equal(locked.status, "rate_limited")
})

test("a right password resets the throttle", async () => {
  const verifier = await createOwnerPasswordVerifier(PASSWORD)
  const check = createOwnerPasswordCheck({
    loginRateLimit: { max: 2, maxLocal: 2, windowMs: 60_000 },
    store: { readVerifier: async () => verifier },
  })
  await check.check(req, "bad-one-bad-one-bad")
  assert.deepEqual(await check.check(req, PASSWORD), { status: "ok" })
  assert.deepEqual(await check.check(req, "bad-two-bad-two-bad"), { status: "invalid" })
})

test("throttle disabled with loginRateLimit false", async () => {
  const verifier = await createOwnerPasswordVerifier(PASSWORD)
  const check = createOwnerPasswordCheck({ loginRateLimit: false, store: { readVerifier: async () => verifier } })
  for (let i = 0; i < 300; i++) {
    assert.deepEqual(await check.check(req, "bad-one-bad-one-bad"), { status: "invalid" })
  }
})
