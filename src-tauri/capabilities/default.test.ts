// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

interface CapabilityDocument {
  platforms?: string[]
  permissions: Array<string | { identifier: string; allow?: unknown[] }>
}

describe("default desktop capabilities", () => {
  it("keeps updater and process permissions out of the shared capability", () => {
    const filePath = resolve(
      process.cwd(),
      "src-tauri/capabilities/default.json"
    )
    const document = JSON.parse(
      readFileSync(filePath, "utf-8")
    ) as CapabilityDocument

    const stringPermissions = document.permissions.filter(
      permission => typeof permission === "string"
    )

    expect(stringPermissions).not.toContain("updater:allow-check")
    expect(stringPermissions).not.toContain("updater:allow-download")
    expect(stringPermissions).not.toContain("updater:allow-install")
    expect(stringPermissions).not.toContain("process:allow-restart")
  })

  it("allows clipboard manager text writes", () => {
    const filePath = resolve(
      process.cwd(),
      "src-tauri/capabilities/default.json"
    )
    const document = JSON.parse(
      readFileSync(filePath, "utf-8")
    ) as CapabilityDocument

    const hasWriteTextPermission = document.permissions.some(
      permission => permission === "clipboard-manager:allow-write-text"
    )

    expect(hasWriteTextPermission).toBe(true)
  })
})

describe("console window capabilities", () => {
  const filePath = resolve(
    process.cwd(),
    "src-tauri/capabilities/console.json"
  )
  const document = JSON.parse(
    readFileSync(filePath, "utf-8")
  ) as CapabilityDocument

  it("scopes the capability to the console window only", () => {
    expect(document.windows).toEqual(["console"])
  })

  it("grants core:default so the console can invoke app commands", () => {
    const stringPermissions = document.permissions.filter(
      permission => typeof permission === "string"
    )

    expect(stringPermissions).toContain("core:default")
  })

  it("does not grant filesystem or shell access the console does not need", () => {
    const stringPermissions = document.permissions.filter(
      (permission): permission is string => typeof permission === "string"
    )

    const hasFsOrShell = stringPermissions.some(
      permission => permission.startsWith("fs:") || permission.startsWith("shell:")
    )

    expect(hasFsOrShell).toBe(false)
  })
})

describe("remote-access commands reachable from the console window", () => {
  const capabilityFiles = ["default.json", "console.json"].map(name => ({
    name,
    document: JSON.parse(
      readFileSync(
        resolve(process.cwd(), "src-tauri/capabilities", name),
        "utf-8"
      )
    ) as CapabilityDocument,
  }))

  const remoteAccessCommands = [
    "get_remote_access_config",
    "inspect_remote_access",
    "set_remote_access_config",
    "configure_remote_access",
  ]

  it.each(remoteAccessCommands)(
    "grants the console window access to %s",
    command => {
      const grantedToConsole = capabilityFiles.some(({ document }) => {
        const windows = document.windows ?? []
        const matchesConsole = windows.some(
          pattern => pattern === "console" || pattern === "*"
        )
        const hasCoreDefault = document.permissions.some(
          permission => permission === "core:default"
        )
        return matchesConsole && hasCoreDefault
      })

      // The remote-access commands are plain app commands with no
      // dedicated per-command ACL identifiers (no permissions/ directory,
      // no AppManifest::commands in build.rs), so reachability from a
      // window is governed by core:default plus window membership, not by
      // a command-specific permission string. This test pins that the
      // console window is a member of some capability granting core:default.
      expect(grantedToConsole).toBe(true)
      void command
    }
  )
})
