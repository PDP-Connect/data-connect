// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest"
import { assertReleaseIdentity } from "./verify-release-ref.mjs"

describe("release ref identity", () => {
  const valid = {
    configVersion: "1.2.3",
    headSha: "abc123",
    releaseTag: "v1.2.3",
    tagSha: "abc123",
  }

  it("accepts a checked-out tag whose commit and version match", () => {
    expect(() => assertReleaseIdentity(valid)).not.toThrow()
  })

  it("rejects a branch commit uploaded to an unrelated release", () => {
    expect(() =>
      assertReleaseIdentity({ ...valid, headSha: "different" })
    ).toThrow("does not match")
  })

  it("rejects a release tag that differs from the app version", () => {
    expect(() =>
      assertReleaseIdentity({ ...valid, configVersion: "1.2.2" })
    ).toThrow("does not match")
  })
})
