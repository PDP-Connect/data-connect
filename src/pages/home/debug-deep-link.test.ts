// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest"
import { resolveDebugDeepLinkRoute } from "./debug-deep-link"

describe("resolveDebugDeepLinkRoute", () => {
  it("routes a supported https link to the connect page", () => {
    expect(
      resolveDebugDeepLinkRoute(
        "https://example.test/connect?sessionId=supported-test&appId=rickroll"
      )
    ).toMatch(/^\/connect\?.*sessionId=supported-test/)
  })

  it("ignores the removed vana scheme", () => {
    expect(
      resolveDebugDeepLinkRoute(
        "vana://connect?sessionId=legacy-test&appId=rickroll"
      )
    ).toBeNull()
  })

  it("ignores empty, invalid and parameterless input", () => {
    expect(resolveDebugDeepLinkRoute("   ")).toBeNull()
    expect(resolveDebugDeepLinkRoute("not a url")).toBeNull()
    expect(resolveDebugDeepLinkRoute("https://example.test/connect")).toBeNull()
  })
})
