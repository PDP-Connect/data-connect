// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const root = process.cwd()
const read = (path: string) => readFileSync(resolve(root, path), "utf-8")

const config = JSON.parse(read("src-tauri/tauri.conf.json")) as {
  productName: string
  bundle: { icon: string[]; linux: { deb: { desktopTemplate: string } } }
}
const source = read("src-tauri/src/linux_app_id.rs")
const cargo = read("src-tauri/Cargo.toml")

const constant = (name: string) =>
  new RegExp(`${name}: &str = "([^"]+)"`).exec(source)?.[1]

describe("Linux window app_id and desktop file", () => {
  // Tauri's bundler names the packaged desktop file `<productName>.desktop`.
  // Compositors map a window's app_id to the desktop file with the same id.
  it("sets an app_id equal to the desktop file id the bundle produces", () => {
    const appId = constant("APP_ID")
    expect(appId).toBeDefined()
    expect(`${appId}.desktop`).toBe(`${config.productName}.desktop`)
  })

  it("makes the desktop template's StartupWMClass the same id", () => {
    const template = read(
      `src-tauri/${config.bundle.linux.deb.desktopTemplate}`
    )
    expect(template).toMatch(/^StartupWMClass=\{\{name\}\}$/m)
    expect(template).toMatch(/^Icon=\{\{icon\}\}$/m)
  })

  // The bundler installs each png in bundle.icon as hicolor/<size>/apps/<binary>.png
  // and writes Icon=<binary> into the desktop file.
  it("uses an icon name the bundle installs", () => {
    const binary = /^\[package\][^[]*?name = "([^"]+)"/ms.exec(cargo)?.[1]
    expect(constant("ICON_NAME")).toBe(binary)
    const pngs = config.bundle.icon.filter(icon => icon.endsWith(".png"))
    expect(pngs.length).toBeGreaterThan(0)
    for (const icon of pngs) {
      expect(existsSync(resolve(root, "src-tauri", icon))).toBe(true)
    }
  })
})
