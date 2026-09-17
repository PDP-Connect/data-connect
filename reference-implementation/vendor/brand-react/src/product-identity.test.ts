// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict"
import test from "node:test"
import { DATACONNECT_PRODUCT_IDENTITY } from "./product-identity.ts"

test("the shared console identity is always DataConnect", () => {
  assert.deepEqual(DATACONNECT_PRODUCT_IDENTITY, {
    build: "operator console",
    description: "The DataConnect desktop console for your personal data.",
    name: "DataConnect",
    protocolName: "PDPP",
    version: "0.7.54",
  })
})
