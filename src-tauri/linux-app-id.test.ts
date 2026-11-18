// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const root = process.cwd()
const read = (path: string) => readFileSync(resolve(root, path), "utf-8")

// Everything is read inside the tests, so a missing file or constant fails the
// assertion instead of throwing while the module loads.
type Config = {
  productName: string
  bundle: {
    category?: string
    icon: string[]
    linux: { deb: { desktopTemplate: string } }
  }
}
const config = () => JSON.parse(read("src-tauri/tauri.conf.json")) as Config
const source = () => read("src-tauri/src/linux_app_id.rs")

const constant = (name: string) =>
  new RegExp(`${name}: &str = "([^"]+)"`).exec(source())?.[1]

describe("Linux window app_id and desktop file", () => {
  // Tauri's bundler names the packaged desktop file `<productName>.desktop`.
  // Compositors map a window's app_id to the desktop file with the same id.
  it("sets an app_id equal to the desktop file id the bundle produces", () => {
    const appId = constant("APP_ID")
    expect(appId).toBeDefined()
    expect(`${appId}.desktop`).toBe(`${config().productName}.desktop`)
  })

  it("makes the desktop template's StartupWMClass the same id", () => {
    const template = read(
      `src-tauri/${config().bundle.linux.deb.desktopTemplate}`
    )
    expect(template).toMatch(/^StartupWMClass=\{\{name\}\}$/m)
    expect(template).toMatch(/^Icon=\{\{icon\}\}$/m)
  })

  // The bundler installs each png in bundle.icon as hicolor/<size>/apps/<binary>.png
  // and writes Icon=<binary> into the desktop file.
  it("uses an icon name the bundle installs", () => {
    const binary = /^\[package\][^[]*?name = "([^"]+)"/ms.exec(
      read("src-tauri/Cargo.toml")
    )?.[1]
    expect(constant("ICON_NAME")).toBe(binary)
    const pngs = config().bundle.icon.filter(icon => icon.endsWith(".png"))
    expect(pngs.length).toBeGreaterThan(0)
    for (const icon of pngs) {
      expect(existsSync(resolve(root, "src-tauri", icon))).toBe(true)
    }
  })

  // The AppImage entry and the packaged desktop file must list the same
  // category, and the bundle must set one so the template's {{categories}}
  // is not empty.
  it("uses one real category for the AppImage entry and the bundle", () => {
    const category = constant("CATEGORY")
    expect(category).toBeDefined()
    expect(category).not.toBe("")
    expect(config().bundle.category).toBe(category)
  })

  it("keeps the AppImage entry hardened", () => {
    const src = source()
    expect(src).toMatch(/TryExec=\{try_exec\}/)
    expect(src).toContain('out.push_str("%%")')
    expect(src).toContain("ErrorKind::NotFound")
    expect(src).toContain("fn runs_from_appimage")
    expect(src).toMatch(/runs_from_appimage\(&exe/)
  })

  // GTK reads the program name when it starts, so it must be set before
  // anything else in run() can initialise it.
  it("sets the program name first in run()", () => {
    const lib = read("src-tauri/src/lib.rs")
    const body = lib.slice(lib.indexOf("pub fn run()"))
    const first = /pub fn run\(\) \{(?:\s*\/\/[^\n]*|\s*#\[cfg\([^\n]*\)\]|\s*\{)*\s*([^\n;]+);/.exec(
      body
    )?.[1]
    expect(first?.trim()).toBe("linux_app_id::set_program_name()")
  })
})
