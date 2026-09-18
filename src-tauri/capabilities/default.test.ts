// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

interface CapabilityDocument {
  identifier: string
  windows?: string[]
  platforms?: string[]
  permissions: Array<string | { identifier: string; allow?: unknown[] }>
  local?: boolean
  remote?: { urls: string[] }
}

function readCapability(fileName: string): CapabilityDocument {
  return JSON.parse(
    readFileSync(resolve(process.cwd(), "src-tauri/capabilities", fileName), "utf-8")
  ) as CapabilityDocument
}

function stringPermissionsOf(document: CapabilityDocument): string[] {
  return document.permissions.filter(
    (permission): permission is string => typeof permission === "string"
  )
}

// Mirrors Tauri's window-pattern matching for capability ACL: a capability
// applies to a given window label if some entry in its `windows` list is
// either an exact match or a glob prefix ending in `*` that the label
// starts with.
function windowMatches(document: CapabilityDocument, windowLabel: string): boolean {
  const windows = document.windows ?? []
  return windows.some(pattern =>
    pattern.endsWith("*")
      ? windowLabel.startsWith(pattern.slice(0, -1))
      : pattern === windowLabel
  )
}

// Mirrors Tauri's Origin::matches (tauri::ipc::authority): a capability's
// grants apply to a request's origin only through the matching side of the
// capability -- `local` (default true) for Origin::Local requests, or an
// entry in `remote.urls` (URLPattern) for Origin::Remote requests. A
// capability with no `remote` block grants nothing to a remote origin, even
// if the window and permissions otherwise match.
function originMatches(document: CapabilityDocument, isLocalOrigin: boolean): boolean {
  if (isLocalOrigin) {
    return document.local ?? true
  }
  return (document.remote?.urls ?? []).includes("http://127.0.0.1:*")
}

// build.rs declares an AppManifest with build.rs's APP_COMMANDS list, which
// autogenerates an `allow-$command` permission (hyphenated) for each --
// see tauri_build::AppManifest / autogenerate_command_permissions. Once any
// AppManifest exists, app commands are ACL-enforced from every window and
// every origin (tauri::ipc::authority has_app_acl_manifest), so `core:default`
// alone no longer grants app commands the way it did before this fix -- only
// an explicit allow-$command permission does. This is the exact mechanism
// verified against Tauri's real RuntimeAuthority in
// src-tauri/tests/acl2_runtime_ipc_verify.rs; these tests check the JSON
// shape that feeds that resolver.
function commandIsGranted(
  document: CapabilityDocument,
  command: string,
  windowLabel: string,
  isLocalOrigin: boolean
): boolean {
  const permission = `allow-${command.replace(/_/g, "-")}`
  return (
    windowMatches(document, windowLabel) &&
    stringPermissionsOf(document).includes(permission) &&
    originMatches(document, isLocalOrigin)
  )
}

const CONSOLE_COMMANDS = [
  "get_remote_access_config",
  "inspect_remote_access",
  "set_remote_access_config",
  "configure_remote_access",
]

describe("default desktop capabilities", () => {
  const defaultDocument = readCapability("default.json")

  it("keeps updater and process permissions out of the shared capability", () => {
    const permissions = stringPermissionsOf(defaultDocument)

    expect(permissions).not.toContain("updater:allow-check")
    expect(permissions).not.toContain("updater:allow-download")
    expect(permissions).not.toContain("updater:allow-install")
    expect(permissions).not.toContain("process:allow-restart")
  })

  it("allows clipboard manager text writes", () => {
    expect(stringPermissionsOf(defaultDocument)).toContain(
      "clipboard-manager:allow-write-text"
    )
  })

  it("stays scoped to main and connector-* (no accidental console widening)", () => {
    expect(defaultDocument.windows).toEqual(["main", "connector-*"])
  })

  it("grants none of the console-only remote-access commands", () => {
    // default.json is shared with connector-* (third-party scraped pages
    // with an injected script) -- it must never grant app commands by name,
    // since that would extend to connector-* too, not just main.
    for (const command of CONSOLE_COMMANDS) {
      const permission = `allow-${command.replace(/_/g, "-")}`
      expect(stringPermissionsOf(defaultDocument)).not.toContain(permission)
    }
  })
})

describe("main.json app-command grants", () => {
  const mainDocument = readCapability("main.json")

  it("scopes the capability to the main window only", () => {
    expect(mainDocument.windows).toEqual(["main"])
  })

  it("grants open_folder to main at its real local origin", () => {
    expect(commandIsGranted(mainDocument, "open_folder", "main", true)).toBe(true)
  })

  it("does not grant any console-only remote-access command", () => {
    for (const command of CONSOLE_COMMANDS) {
      expect(commandIsGranted(mainDocument, command, "main", true)).toBe(false)
    }
  })

  it("has no `remote` allowlist (main's real origin is local, not remote)", () => {
    expect(mainDocument.remote).toBeUndefined()
  })
})

describe("console window capabilities", () => {
  const consoleDocument = readCapability("console.json")

  it("scopes the capability to the console window only", () => {
    expect(consoleDocument.windows).toEqual(["console"])
  })

  it("does not grant filesystem or shell access the console does not need", () => {
    const hasFsOrShell = stringPermissionsOf(consoleDocument).some(
      permission => permission.startsWith("fs:") || permission.startsWith("shell:")
    )

    expect(hasFsOrShell).toBe(false)
  })

  // The console window is created with WebviewUrl::External and navigated
  // to a loopback HTTP origin (create_or_update_console_window in
  // unified.rs), never a tauri://, devUrl, or frontendDist origin. Tauri's
  // webview layer classifies that as Origin::Remote, and a Remote origin
  // only matches a capability's grants through the capability's `remote`
  // allowlist -- the implicit `local: true` default does not apply. Without
  // this, the capability is well-formed JSON that is silently inert for
  // every request the console window actually sends.
  it("allows its grants over the loopback origin the console actually navigates to", () => {
    expect(consoleDocument.remote?.urls).toBeDefined()
    expect(consoleDocument.remote?.urls).toContain("http://127.0.0.1:*")
  })

  it("does not widen remote IPC access beyond loopback", () => {
    const urls = consoleDocument.remote?.urls ?? []
    for (const pattern of urls) {
      expect(pattern.startsWith("http://127.0.0.1:")).toBe(true)
    }
  })

  it.each(CONSOLE_COMMANDS)(
    "grants %s to the console window at its real loopback origin",
    command => {
      expect(commandIsGranted(consoleDocument, command, "console", false)).toBe(true)
    }
  )

  it.each(CONSOLE_COMMANDS)(
    "does not grant %s to the console window over a local origin (it never navigates there)",
    command => {
      expect(commandIsGranted(consoleDocument, command, "console", true)).toBe(false)
    }
  )

  it("grants none of main's app commands (no unintended widening)", () => {
    expect(commandIsGranted(consoleDocument, "open_folder", "console", false)).toBe(false)
  })
})

describe("windowMatches / originMatches / commandIsGranted unit behavior", () => {
  const grantingDocument: CapabilityDocument = {
    identifier: "test",
    windows: ["console"],
    permissions: ["allow-get-remote-access-config"],
  }

  it("denies a window label the capability does not list", () => {
    expect(
      commandIsGranted(grantingDocument, "get_remote_access_config", "main", true)
    ).toBe(false)
  })

  it("denies a window label that only shares a prefix, without a glob", () => {
    expect(
      commandIsGranted(grantingDocument, "get_remote_access_config", "console-2", true)
    ).toBe(false)
  })

  it("matches a glob-suffixed window pattern by prefix", () => {
    const document: CapabilityDocument = {
      identifier: "test",
      windows: ["connector-*"],
      permissions: ["allow-open-folder"],
    }
    expect(windowMatches(document, "connector-github")).toBe(true)
    expect(windowMatches(document, "connector")).toBe(false)
  })

  it("denies when the capability lacks the specific allow-$command permission", () => {
    const document: CapabilityDocument = {
      identifier: "test",
      windows: ["console"],
      permissions: ["core:event:default"],
    }
    expect(
      commandIsGranted(document, "get_remote_access_config", "console", true)
    ).toBe(false)
  })

  it("denies a remote-origin request when the capability grants no remote urls", () => {
    // This is the exact shape of the original regression: a capability that
    // is syntactically valid, matches the window, and grants the right
    // allow-$command permission, but was never extended with `remote` -- so
    // it is inert for any request whose origin Tauri classifies as Remote
    // (e.g. the console window's loopback HTTP navigation).
    expect(
      commandIsGranted(grantingDocument, "get_remote_access_config", "console", false)
    ).toBe(false)
  })

  it("grants a remote-origin request only when its url matches remote.urls", () => {
    const remoteScopedDocument: CapabilityDocument = {
      identifier: "test",
      windows: ["console"],
      permissions: ["allow-get-remote-access-config"],
      remote: { urls: ["http://127.0.0.1:*"] },
    }
    expect(
      commandIsGranted(remoteScopedDocument, "get_remote_access_config", "console", false)
    ).toBe(true)
    expect(
      commandIsGranted(remoteScopedDocument, "get_remote_access_config", "main", false)
    ).toBe(false)
  })
})
