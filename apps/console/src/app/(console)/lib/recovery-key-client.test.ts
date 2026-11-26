// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict"
import test, { mock } from "node:test"

class FakeHttpError extends Error {
  constructor(
    readonly path: string,
    readonly status: number,
    readonly body: string
  ) {
    super(body)
  }
}
class FakeUnreachable extends Error {}

mock.module("server-only", { namedExports: {} })
mock.module(new URL("./owner-token.ts", import.meta.url).href, {
  namedExports: {
    getOwnerToken: async () => "owner-token",
    getRsInternalUrl: () => "http://rs.test",
    ReferenceServerUnreachableError: FakeUnreachable,
    ResourceServerHttpError: FakeHttpError,
  },
})
mock.module(new URL("./verify-session.ts", import.meta.url).href, {
  namedExports: { verifyDashboardSession: async () => {} },
})

const realFetch = globalThis.fetch
test.afterEach(() => {
  globalThis.fetch = realFetch
})

function fakeFetch(status: number, body: unknown, seen: { init?: RequestInit; url?: string } = {}) {
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    seen.url = url
    seen.init = init
    return new Response(JSON.stringify(body), { status })
  }) as typeof fetch
  return seen
}

test("sends the password once in the JSON body and returns the code", async () => {
  const seen = fakeFetch(200, { data: { code: "0200-0000-036B-6579-E5EA" }, object: "recovery_kit_export" })
  const { exportRecoveryKitCode } = await import("./recovery-key-client.ts")
  assert.equal(await exportRecoveryKitCode("hunter2-hunter2-hunter2"), "0200-0000-036B-6579-E5EA")
  assert.equal(seen.url, "http://rs.test/v1/owner/recovery-kit/export")
  assert.equal(seen.init?.method, "POST")
  assert.deepEqual(JSON.parse(String(seen.init?.body)), { password: "hunter2-hunter2-hunter2" })
  const headers = seen.init?.headers as Record<string, string>
  assert.equal(headers["Content-Type"], "application/json")
  assert.equal(headers.Authorization, "Bearer owner-token")
})

test("a refusal carries the server's stable error code and never echoes the password", async () => {
  fakeFetch(401, { error: { code: "owner_password_invalid", message: "That password is not right." } })
  const { exportRecoveryKitCode, RecoveryKitExportRefusedError } = await import("./recovery-key-client.ts")
  await assert.rejects(exportRecoveryKitCode("secret-secret-secret"), (err: unknown) => {
    assert.ok(err instanceof RecoveryKitExportRefusedError)
    assert.equal(err.code, "owner_password_invalid")
    assert.equal(err.status, 401)
    assert.doesNotMatch(`${err.message}${JSON.stringify(err)}`, /secret-secret-secret/)
    return true
  })
})
