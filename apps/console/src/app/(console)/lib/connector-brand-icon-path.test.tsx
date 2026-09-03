// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict"
import test from "node:test"
import { sameOriginConnectorBrandIndex } from "./connector-brand-icon-path.ts"

test("ConnectorIcon receives only same-origin brand asset paths from the console index", () => {
  const connectorIndex = sameOriginConnectorBrandIndex({
    brandIcons: {
      amazon: {
        url: "/connector-brand-icons/amazon.svg",
      },
      rejected: {
        url: "https://third-party.example.test/rejected.svg",
      },
    },
  })
  const connectorIconSrc = connectorIndex.brandIcons.amazon?.url

  assert.equal(connectorIconSrc, "/connector-brand-icons/amazon.svg")
  assert.ok(connectorIconSrc)
  assert.equal(
    new URL(connectorIconSrc, "https://owner.example.test").origin,
    "https://owner.example.test"
  )
  assert.equal(connectorIndex.brandIcons.rejected, undefined)
})
