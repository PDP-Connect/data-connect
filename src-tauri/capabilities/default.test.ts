// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { readdirSync, readFileSync, statSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

type CapabilityPermission = string | { identifier: string; allow?: unknown[]; deny?: unknown[] }

interface CapabilityDocument {
  identifier?: string
  platforms?: string[]
  windows?: string[]
  permissions: CapabilityPermission[]
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
  // exact permission entries it may grant: a string, or an object written out
  // in full with its `allow`/`deny` scope. A scope is part of the grant, so
  // widening one, or rewriting a string into object form, fails here too. A new
  // file, a new window or a new grant fails until someone adds it on purpose.
  // Every other top-level field is pinned too (identifier, platforms, and any
  // field added later, such as `remote`, `webviews` or `local`); only `$schema`
  // and `description` are free text. The attach window ("attach") is
  // deliberately in no file: its commands check the window label themselves, and any capability that lists
  // it would widen who can reach them.
  interface AllowedCapability {
    identifier: string
    windows: string[]
    platforms?: string[]
    permissions: CapabilityPermission[]
  }

  const ALLOWED_CAPABILITIES: Record<string, AllowedCapability> = {
    "default.json": {
      identifier: "default",
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
        {
          identifier: "http:allow-fetch",
          allow: [
            { url: "http://localhost:*" },
            { url: "http://127.0.0.1:*" },
            { url: "https://*" },
          ],
        },
      ],
    },
    "console.json": {
      identifier: "console",
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
      identifier: "mcp-bridge",
      windows: ["main", "connector-*"],
      platforms: ["linux", "macOS"],
      permissions: [
        "mcp-bridge:default",
      ],
    },
  }

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

  it("every capability file holds exactly the listed fields, windows and permissions", () => {
    const directory = resolve(process.cwd(), "src-tauri/capabilities")
    const actual: Record<string, unknown> = {}
    for (const name of Object.keys(ALLOWED_CAPABILITIES).sort()) {
      const { $schema: _schema, description: _description, ...rest } = JSON.parse(
        readFileSync(resolve(directory, name), "utf-8")
      ) as Record<string, unknown>
      actual[name] = rest
    }
    expect(actual).toEqual(ALLOWED_CAPABILITIES)
  })

  // "connector-*" is a prefix match, so a window whose label starts with
  // "connector-" gets the shared capability with no change to this file. Nothing
  // creates one today (the "connector-" string in lib.rs only looks a window up
  // in order to close it). A search for the literal can be dodged by building
  // the label in another form (a raw string, a constant, concat!), so this pins
  // the other end instead: every place that creates a window or webview, and the
  // expression it passes as the label. A new creation site, or a changed label
  // expression, fails until someone lists it here and looks at the label.
  const CREATION_CALLS: Array<{ pattern: RegExp; labelArg: number }> = [
    { pattern: /WebviewWindowBuilder::new\(/g, labelArg: 1 },
    { pattern: /WebviewWindowBuilder::from_config\(/g, labelArg: 0 },
    { pattern: /WebviewWindow::builder\(/g, labelArg: 1 },
    { pattern: /(?<![A-Za-z])WindowBuilder::new\(/g, labelArg: 1 },
    { pattern: /WebviewBuilder::new\(/g, labelArg: 0 },
    { pattern: /new\s+(?:WebviewWindow|Webview|Window)\(/g, labelArg: 0 },
  ]

  // The arguments of the call whose "(" ends at `open`, split at top-level commas.
  const callArguments = (source: string, open: number): string[] => {
    const args: string[] = []
    let depth = 0
    let quote = ""
    let current = ""
    for (let i = open; i < source.length; i += 1) {
      const char = source[i]
      if (quote) {
        current += char
        if (char === "\\") current += source[++i]
        else if (char === quote) quote = ""
        continue
      }
      if (char === '"' || char === "'" || char === "`") {
        quote = char
        current += char
      } else if ("([{".includes(char)) {
        depth += 1
        if (depth > 1) current += char
      } else if (")]}".includes(char)) {
        depth -= 1
        if (depth === 0) {
          args.push(current)
          return args.map(arg => arg.replace(/\s+/g, " ").trim())
        }
        current += char
      } else if (char === "," && depth === 1) {
        args.push(current)
        current = ""
      } else {
        current += char
      }
    }
    throw new Error("unbalanced call")
  }

  const sourceFiles = (): string[] => {
    const files: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = resolve(dir, name)
        if (statSync(path).isDirectory()) walk(path)
        else if (/\.(rs|ts|tsx)$/.test(name)) files.push(path)
      }
    }
    walk(resolve(process.cwd(), "src-tauri/src"))
    walk(resolve(process.cwd(), "src"))
    return files
  }

  const EXPECTED_WINDOW_CREATIONS = [
    'src-tauri/src/attach_window.rs: ATTACH_WINDOW_LABEL',
    'src-tauri/src/attach_window_tests.rs: label',
    'src-tauri/src/bin/new_window_repro.rs: "repro"',
    'src-tauri/src/bin/titlebar_repro.rs: "titlebar-repro"',
    'src-tauri/src/commands/ref_server_view.rs: REF_SERVER_VIEW_LABEL',
    'src-tauri/src/lib.rs: "owner-password"',
    'src-tauri/src/lib.rs: "owner-password"',
    'src-tauri/src/lib.rs: label',
    // Builds the legacy main window from tauri.conf.json, so its label is the
    // one pinned by the configuration test below.
    'src-tauri/src/lib.rs: app.handle()',
    'src-tauri/src/owner_credential.rs: OWNER_PASSWORD_WINDOW_LABEL',
    'src-tauri/src/stall_repro.rs: "stall-repro"',
    'src-tauri/src/unified.rs: "owner-password"',
    'src-tauri/src/unified.rs: "owner-password"',
    'src-tauri/src/unified.rs: "owner-password"',
    'src-tauri/src/unified.rs: CONSOLE_WINDOW_LABEL',
    'src-tauri/src/unified.rs: RECOVERY_WINDOW_LABEL',
    'src-tauri/src/winclose_repro.rs: "winclose-repro"',
  ]

  it("every window or webview creation site and its label expression is listed", () => {
    const found: string[] = []
    for (const path of sourceFiles()) {
      const source = readFileSync(path, "utf-8")
      for (const { pattern, labelArg } of CREATION_CALLS) {
        for (const match of source.matchAll(pattern)) {
          const args = callArguments(source, match.index + match[0].length - 1)
          found.push(`${path.replace(`${process.cwd()}/`, "")}: ${args[labelArg] ?? "(no label)"}`)
        }
      }
    }
    expect(found.sort()).toEqual([...EXPECTED_WINDOW_CREATIONS].sort())
  })

  // The listed label constants and literals must not start with "connector-".
  it("no listed window label starts with connector-", () => {
    for (const entry of EXPECTED_WINDOW_CREATIONS) {
      expect(entry.split(": ")[1]).not.toMatch(/^"connector-/)
    }
    const labelConstant = /const\s+\w*LABEL\w*\s*:\s*&str\s*=\s*(?:r#*)?"([^"]*)"/g
    const labels: string[] = []
    for (const path of sourceFiles().filter(file => file.endsWith(".rs"))) {
      for (const match of readFileSync(path, "utf-8").matchAll(labelConstant)) labels.push(match[1])
    }
    expect(labels.length).toBeGreaterThan(0)
    expect(labels.filter(label => label.startsWith("connector-"))).toEqual([])
  })

  // Windows declared in tauri.conf.json are created without any Rust call.
  it("tauri.conf.json declares only the main window", () => {
    const config = JSON.parse(readFileSync(resolve(process.cwd(), "src-tauri/tauri.conf.json"), "utf-8")) as {
      app?: { windows?: Array<{ label?: string }> }
    }
    expect((config.app?.windows ?? []).map(window => window.label)).toEqual(["main"])
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
