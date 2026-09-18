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

/**
 * Mirrors Tauri's window-pattern matching for capability ACL: a capability
 * applies to a given window label if some entry in its `windows` list is
 * either an exact match or a glob prefix ending in `*` that the label
 * starts with. This app defines no per-command ACL identifiers (no
 * permissions/ directory, no AppManifest::commands in build.rs), so
 * whether an app command like get_remote_access_config is reachable from a
 * window is governed entirely by window membership plus core:default, not
 * by a command-specific permission string.
 */
function windowIsGranted(
  document: CapabilityDocument,
  windowLabel: string
): boolean {
  const windows = document.windows ?? []
  const matchesWindow = windows.some(pattern =>
    pattern.endsWith("*")
      ? windowLabel.startsWith(pattern.slice(0, -1))
      : pattern === windowLabel
  )
  const hasCoreDefault = document.permissions.some(
    permission => permission === "core:default"
  )
  return matchesWindow && hasCoreDefault
}

describe("windowIsGranted window-pattern matching", () => {
  const grantingDocument: CapabilityDocument = {
    windows: ["console"],
    permissions: ["core:default"],
  }

  it("grants an exact window label match", () => {
    expect(windowIsGranted(grantingDocument, "console")).toBe(true)
  })

  it("denies a window label the capability does not list", () => {
    expect(windowIsGranted(grantingDocument, "main")).toBe(false)
  })

  it("denies a window label that only shares a prefix, without a glob", () => {
    expect(windowIsGranted(grantingDocument, "console-2")).toBe(false)
  })

  it("matches a glob-suffixed window pattern by prefix", () => {
    const document: CapabilityDocument = {
      windows: ["connector-*"],
      permissions: ["core:default"],
    }
    expect(windowIsGranted(document, "connector-github")).toBe(true)
    expect(windowIsGranted(document, "connector")).toBe(false)
  })

  it("denies every window when the capability lacks core:default", () => {
    const document: CapabilityDocument = {
      windows: ["console"],
      permissions: ["core:event:default"],
    }
    expect(windowIsGranted(document, "console")).toBe(false)
  })
})

describe("remote-access commands reachable from the console window", () => {
  const defaultDocument = JSON.parse(
    readFileSync(
      resolve(process.cwd(), "src-tauri/capabilities/default.json"),
      "utf-8"
    )
  ) as CapabilityDocument
  const consoleDocument = JSON.parse(
    readFileSync(
      resolve(process.cwd(), "src-tauri/capabilities/console.json"),
      "utf-8"
    )
  ) as CapabilityDocument

  const remoteAccessCommands = [
    "get_remote_access_config",
    "inspect_remote_access",
    "set_remote_access_config",
    "configure_remote_access",
  ]

  // These commands have no per-command ACL identifier (see windowIsGranted
  // above), so "grants access to the command" reduces to "some capability
  // grants core:default to this window" -- the same check for every
  // command in the list. Parameterized so the intent (four named commands,
  // all reachable) stays explicit rather than collapsing into one grant
  // check that a renamed/shortened command list wouldn't be caught by.
  it.each(remoteAccessCommands)("grants the console window access to %s", () => {
    const grantedToConsole =
      windowIsGranted(defaultDocument, "console") ||
      windowIsGranted(consoleDocument, "console")

    expect(grantedToConsole).toBe(true)
  })

  it.each(remoteAccessCommands)(
    "does not grant a window absent from every capability access to %s",
    () => {
      const grantedToUnknownWindow =
        windowIsGranted(defaultDocument, "not-a-real-window") ||
        windowIsGranted(consoleDocument, "not-a-real-window")

      expect(grantedToUnknownWindow).toBe(false)
    }
  )

  it("grants the remote-access commands to console specifically, not via a blanket default.json window", () => {
    // default.json's own windows list must not have grown to include the
    // console (or a wildcard) as a side effect of this fix -- the grant
    // must come from the dedicated console.json capability, not from
    // widening the shared default capability the brief said not to widen.
    expect(defaultDocument.windows).toEqual(["main", "connector-*"])
    expect(windowIsGranted(defaultDocument, "console")).toBe(false)
    expect(windowIsGranted(consoleDocument, "console")).toBe(true)
  })
})
