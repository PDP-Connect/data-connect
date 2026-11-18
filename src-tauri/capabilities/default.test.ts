// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { readdirSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

interface CapabilityDocument {
  platforms?: string[]
  windows?: string[]
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

  it("does not grant filesystem access the console does not need", () => {
    const stringPermissions = document.permissions.filter(
      (permission): permission is string => typeof permission === "string"
    )

    const hasFs = stringPermissions.some(permission => permission.startsWith("fs:"))

    expect(hasFs).toBe(false)
  })

  it("grants notification:default so Notification.requestPermission() is not rejected by the ACL", () => {
    // The notification plugin's init script overrides window.Notification in
    // every webview (including this one, WebviewUrl::External) and routes
    // requestPermission()/isPermissionGranted() through
    // invoke("plugin:notification|..."). Without this permission, the
    // console's web-push-settings.tsx call to Notification.requestPermission()
    // is silently denied by Tauri's capability ACL even though the identical
    // code works in a plain browser (which has no Tauri override).
    const stringPermissions = document.permissions.filter(
      (permission): permission is string => typeof permission === "string"
    )

    expect(stringPermissions).toContain("notification:default")
  })

  it("grants no shell capability at all -- outbound links are opened by Rust's on_navigation handler, not invoke()", () => {
    // shell:allow-open (#186) never worked here: this window is
    // WebviewUrl::External, which never receives Tauri's invoke() bridge
    // (Tauri Discussion #2650), so no capability grant mediated through it
    // can ever be reachable. The actual fix
    // (decide_console_navigation/on_navigation, src-tauri/src/unified.rs)
    // intercepts navigation at the webview level in Rust, independent of
    // any capability grant -- this asserts the dead grant is gone, not
    // replaced with something else equally unreachable.
    const stringPermissions = document.permissions.filter(
      (permission): permission is string => typeof permission === "string"
    )

    const hasShell = stringPermissions.some(permission => permission.startsWith("shell:"))

    expect(hasShell).toBe(false)
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

// The remote-access commands (get_remote_access_config, inspect_remote_access,
// set_remote_access_config, configure_remote_access) that this section used to
// test capability grants for are gone: the console now reaches both remote-
// access providers over the owner-authenticated HTTP routes in
// reference-implementation/server/routes/owner-remote-access.ts, never
// invoke() (see remote-access-setting.tsx's module doc comment). Asserting a
// capability grant for commands that no longer exist would test a premise
// that is no longer true.

describe("capability scoping of app commands", () => {
  // The windows that may call app commands under the shared capability. The
  // attach window ("attach") is not among them: its commands check the window
  // label themselves, and a label added here would widen who can reach them.
  it("grants the shared capability to exactly the intended windows", () => {
    const document = JSON.parse(
      readFileSync(resolve(process.cwd(), "src-tauri/capabilities/default.json"), "utf-8")
    ) as { windows?: string[] }
    expect(document.windows).toEqual(["main", "connector-*"])
  })

  // Every capability file, the exact window patterns it may name, and the
  // exact permission identifiers it may grant (a string entry, or the
  // `identifier` of an object entry; an object's scope is not compared). A new
  // file, a new window or a new grant fails here until someone adds it on
  // purpose. The attach window ("attach") is deliberately in no file: its
  // commands check the window label themselves, and any capability that lists
  // it would widen who can reach them.
  const ALLOWED_CAPABILITIES: Record<string, { windows: string[]; permissions: string[] }> = {
    "default.json": {
      windows: ["main", "connector-*"],
      permissions: [
        "core:default",
        "core:window:allow-create",
        "core:window:allow-close",
        "core:window:allow-set-size",
        "core:window:allow-set-position",
        "core:window:allow-show",
        "core:window:allow-hide",
        "core:window:allow-start-dragging",
        "core:webview:default",
        "core:webview:allow-create-webview-window",
        "core:event:default",
        "core:event:allow-listen",
        "core:event:allow-emit",
        "core:path:default",
        "fs:default",
        "fs:allow-app-read-recursive",
        "fs:allow-app-write-recursive",
        "fs:allow-appdata-read-recursive",
        "fs:allow-appdata-write-recursive",
        "shell:default",
        "shell:allow-open",
        "deep-link:default",
        "clipboard-manager:allow-write-text",
        "http:default",
        "http:allow-fetch",
      ],
    },
    "console.json": {
      windows: ["console"],
      permissions: [
        "core:default",
        "core:event:default",
        "core:event:allow-listen",
        "core:event:allow-emit",
        "notification:default",
      ],
    },
    "mcp-bridge.json": {
      windows: ["main", "connector-*"],
      permissions: [
        "mcp-bridge:default",
      ],
    },
  }

  const permissionIdentifier = (entry: string | { identifier: string }) =>
    typeof entry === "string" ? entry : entry.identifier

  // Tauri reads every capability file in the directory, whatever its extension,
  // so an entry that is not a known top-level .json file (a .toml, a
  // subdirectory) is a grant this test could not see.
  it("the capabilities directory holds only the known top-level .json files", () => {
    const directory = resolve(process.cwd(), "src-tauri/capabilities")
    const entries = readdirSync(directory, { withFileTypes: true })
    const unknown = entries
      .filter(entry => !entry.isFile() || !(entry.name in ALLOWED_CAPABILITIES))
      // This test file sits beside the capabilities it checks.
      .filter(entry => entry.name !== "default.test.ts")
      .map(entry => (entry.isDirectory() ? `${entry.name}/` : entry.name))
    expect(unknown).toEqual([])
    expect(entries.filter(entry => entry.isFile() && entry.name.endsWith(".json")).map(entry => entry.name).sort())
      .toEqual(Object.keys(ALLOWED_CAPABILITIES).sort())
  })

  it("every capability file grants exactly the listed windows and permissions", () => {
    const directory = resolve(process.cwd(), "src-tauri/capabilities")
    const actual: Record<string, { windows: string[]; permissions: string[] }> = {}
    for (const name of Object.keys(ALLOWED_CAPABILITIES).sort()) {
      const document = JSON.parse(readFileSync(resolve(directory, name), "utf-8")) as CapabilityDocument
      actual[name] = {
        windows: document.windows ?? [],
        permissions: document.permissions.map(permissionIdentifier),
      }
    }
    expect(actual).toEqual(ALLOWED_CAPABILITIES)
  })

  // Tauri refuses an app command from a page that is not the app's own unless
  // a capability lists that page under `remote`. The attach window's commands
  // rely on that refusal (attach_window_tests.rs), so no capability may add it.
  it("no capability grants remote pages access to app commands", () => {
    const directory = resolve(process.cwd(), "src-tauri/capabilities")
    const files = readdirSync(directory).filter(name => name.endsWith(".json"))
    expect(files).toContain("default.json")
    for (const name of files) {
      const document = JSON.parse(readFileSync(resolve(directory, name), "utf-8")) as { remote?: unknown }
      expect(document.remote, name).toBeUndefined()
    }
  })
})
