// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

// The recovery-code route lives on the resource server app. Its password check reads the owner password
// store; if startServer does not hand that store to buildRsApp, an install whose password lives in the store
// (a password the owner chose) is told "no password set" and can never export its recovery code.
test("startServer gives the resource server app the owner password store and verifier", () => {
  const source = readFileSync(new URL("../server/index.ts", import.meta.url), "utf8")
  const start = source.indexOf("const rsApp = buildRsApp({")
  assert.ok(start > 0, "buildRsApp call not found")
  const call = source.slice(start, source.indexOf("\n  });", start))
  assert.match(call, /ownerPasswordVerifierStore: ownerPasswordStore/)
  assert.match(call, /ownerAuthPasswordVerifier: ownerPasswordVerifier/)
})
