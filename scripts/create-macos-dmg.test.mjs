// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest"
import { createMacosDmg } from "./create-macos-dmg.mjs"

describe("macOS DMG creation", () => {
  it("retries resource-busy failures and detaches only the exact output image", async () => {
    const calls = []
    let createAttempts = 0
    const run = vi.fn((command, args) => {
      calls.push([command, args])
      if (command === "hdiutil" && args[0] === "create") {
        createAttempts += 1
        return createAttempts === 1
          ? { status: 1, stderr: "hdiutil: create failed - Resource busy" }
          : { status: 0, stdout: "created" }
      }
      if (command === "hdiutil" && args[0] === "info") {
        return { status: 0, stdout: "plist bytes" }
      }
      if (command === "plutil") {
        return {
          status: 0,
          stdout: JSON.stringify({
            images: [
              {
                "image-path": "/runner/out/DataConnect.dmg",
                "system-entities": [
                  { "dev-entry": "/dev/disk7" },
                  { "dev-entry": "/dev/disk7s1" },
                ],
              },
              {
                "image-path": "/runner/out/unrelated.dmg",
                "system-entities": [{ "dev-entry": "/dev/disk9" }],
              },
            ],
          }),
        }
      }
      return { status: 0 }
    })
    const remove = vi.fn()
    const sleep = vi.fn()

    await createMacosDmg({
      volumeName: "DataConnect",
      sourceFolder: "/runner/staging",
      outputPath: "/runner/out/DataConnect.dmg",
      run,
      remove,
      sleep,
    })

    expect(createAttempts).toBe(2)
    expect(calls).toContainEqual(["hdiutil", ["detach", "/dev/disk7"]])
    expect(calls).not.toContainEqual(["hdiutil", ["detach", "/dev/disk9"]])
    expect(calls).not.toContainEqual(["hdiutil", ["detach", "/dev/disk7s1"]])
    expect(remove).toHaveBeenCalledWith("/runner/out/DataConnect.dmg", {
      force: true,
    })
    expect(sleep).toHaveBeenCalledWith(2_000)
  })

  it("does not retry unrelated failures", async () => {
    const run = vi.fn(() => ({ status: 1, stderr: "permission denied" }))

    await expect(
      createMacosDmg({
        volumeName: "DataConnect",
        sourceFolder: "/runner/staging",
        outputPath: "/runner/out/DataConnect.dmg",
        run,
      })
    ).rejects.toThrow("permission denied")
    expect(run).toHaveBeenCalledTimes(1)
  })

  it("stops after three resource-busy attempts with bounded cleanup and backoff", async () => {
    const calls = []
    const run = vi.fn((command, args) => {
      calls.push([command, args])
      if (command === "hdiutil" && args[0] === "create") {
        return { status: 1, stderr: "hdiutil: create failed - Resource busy" }
      }
      if (command === "hdiutil" && args[0] === "info") {
        return { status: 0, stdout: "plist bytes" }
      }
      if (command === "plutil") {
        return {
          status: 0,
          stdout: JSON.stringify({
            images: [
              {
                "image-path": "/runner/out/DataConnect.dmg",
                "system-entities": [
                  { "dev-entry": "/dev/disk7" },
                  { "dev-entry": "/dev/disk7s1" },
                ],
              },
              {
                "image-path": "/runner/out/unrelated.dmg",
                "system-entities": [{ "dev-entry": "/dev/disk9" }],
              },
            ],
          }),
        }
      }
      return { status: 0 }
    })
    const remove = vi.fn()
    const sleep = vi.fn()

    await expect(
      createMacosDmg({
        volumeName: "DataConnect",
        sourceFolder: "/runner/staging",
        outputPath: "/runner/out/DataConnect.dmg",
        run,
        remove,
        sleep,
      })
    ).rejects.toThrow("Resource busy")

    expect(
      calls.filter(
        ([command, args]) => command === "hdiutil" && args[0] === "create"
      )
    ).toHaveLength(3)
    expect(
      calls.filter(
        ([command, args]) =>
          command === "hdiutil" &&
          args[0] === "detach" &&
          args[1] === "/dev/disk7"
      )
    ).toHaveLength(2)
    expect(calls).not.toContainEqual(["hdiutil", ["detach", "/dev/disk9"]])
    expect(calls).not.toContainEqual(["hdiutil", ["detach", "/dev/disk7s1"]])
    expect(remove).toHaveBeenCalledTimes(2)
    expect(sleep.mock.calls).toEqual([[2_000], [4_000]])
  })
})
