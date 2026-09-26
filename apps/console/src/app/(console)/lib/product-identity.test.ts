// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict"
import test from "node:test"
import { getProductIdentity } from "./product-identity.ts"

test("the console product identity is always DataConnect", () => {
  const identity = getProductIdentity()
  assert.equal(identity.name, "DataConnect")
  assert.equal(identity.protocolName, "PDPP")
  assert.equal(identity.version, "0.7.56")
})
