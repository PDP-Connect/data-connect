// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest"
import { getAppRegistryEntries, getAppRegistryEntry } from "./registry"
import { isExternalAppRegistryEntry } from "./registry-types"

describe("app registry data access", () => {
  it("declares Timeline as a PDPP reader", () => {
    expect(getAppRegistryEntry("timeline")?.dataAccess).toEqual({
      protocol: "pdpp",
      capabilities: ["personal-data-read"],
    })
  })

  it("keeps current submitted external apps on the Vana grant/session path", () => {
    const submittedApps = getAppRegistryEntries().filter(
      isExternalAppRegistryEntry
    )

    expect(submittedApps.length).toBeGreaterThan(0)
    expect(submittedApps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          dataAccess: {
            protocol: "vana-grant-session",
            capabilities: ["grant-session"],
          },
        }),
      ])
    )
    expect(
      submittedApps.every(
        app => app.dataAccess.protocol === "vana-grant-session"
      )
    ).toBe(true)
  })
})
