// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict"
import test, { mock } from "node:test"

class Refused extends Error {
  constructor(
    readonly code: string,
    readonly status: number
  ) {
    super(`refused ${code}`)
  }
}

let received: unknown[] = []
let outcome: () => Promise<string> = async () => "CODE"

mock.module("server-only", { namedExports: {} })
mock.module(new URL("../lib/dashboard-access.ts", import.meta.url).href, {
  namedExports: { requireDashboardAccess: async () => {} },
})
mock.module(new URL("../lib/recovery-key-client.ts", import.meta.url).href, {
  namedExports: {
    RecoveryKitExportRefusedError: Refused,
    exportRecoveryKitCode: async (...args: unknown[]) => {
      received = args
      return await outcome()
    },
  },
})

test("passes the password through and returns the code", async () => {
  outcome = async () => "0200-0000-036B-6579-E5EA"
  const { exportRecoveryKitAction } = await import("./recovery-key-actions.ts")
  assert.deepEqual(await exportRecoveryKitAction("my-password-my-password"), {
    code: "0200-0000-036B-6579-E5EA",
    ok: true,
  })
  assert.deepEqual(received, ["my-password-my-password"])
})

for (const [code, status, reason, sentence] of [
  ["owner_password_invalid", 401, "wrong", "That password isn't right."],
  ["owner_password_required", 401, "wrong", "That password isn't right."],
  ["owner_password_not_set", 409, "not-set", "Choose a password first."],
  ["owner_login_rate_limited", 429, "too-many", "Too many tries. Wait a little, then try again."],
] as const) {
  test(`maps ${code} to its sentence and returns no code`, async () => {
    outcome = async () => {
      throw new Refused(code, status)
    }
    const { exportRecoveryKitAction } = await import("./recovery-key-actions.ts")
    const result = await exportRecoveryKitAction("typed-typed-typed-typed")
    assert.deepEqual(result, { message: sentence, ok: false, reason })
    assert.doesNotMatch(JSON.stringify(result), /typed-typed/)
  })
}

test("any other failure keeps its raw text for support and never carries the password", async () => {
  outcome = async () => {
    throw new Error("Cannot reach resource server")
  }
  const { exportRecoveryKitAction } = await import("./recovery-key-actions.ts")
  const result = await exportRecoveryKitAction("typed-typed-typed-typed")
  assert.deepEqual(result, { message: "Cannot reach resource server", ok: false, reason: "failed" })
})

test("an empty password is refused before any request", async () => {
  received = []
  const { exportRecoveryKitAction } = await import("./recovery-key-actions.ts")
  const result = await exportRecoveryKitAction("")
  assert.equal(result.ok, false)
  assert.deepEqual(received, [])
})
