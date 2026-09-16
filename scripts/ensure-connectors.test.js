// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest"
import { connectorDirectoryFromResourceKey } from "./ensure-connectors.js"

describe("ensure connectors resource detection", () => {
  it("requires both glob and directory resource mappings", () => {
    expect(
      connectorDirectoryFromResourceKey("../connectors/collection-profiles/")
    ).toBe("collection-profiles")
    expect(connectorDirectoryFromResourceKey("../connectors/github/**/*")).toBe(
      "github"
    )
  })

  it("ignores non-connector resource mappings", () => {
    expect(connectorDirectoryFromResourceKey("../connectors/lock.json")).toBe(
      undefined
    )
    expect(connectorDirectoryFromResourceKey("connectors/github/**/*")).toBe(
      undefined
    )
  })
})
