// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const root = process.cwd()
const read = (path: string) => readFileSync(resolve(root, path), "utf-8")

// Everything is read inside the tests, so a missing file fails the assertion
// instead of throwing while the module loads.
type Config = {
  productName: string
  bundle: { category?: string; linux: { deb: { desktopTemplate: string } } }
}
const config = () => JSON.parse(read("src-tauri/tauri.conf.json")) as Config
const runBody = () => {
  const lib = read("src-tauri/src/lib.rs")
  return lib.slice(lib.indexOf("pub fn run()"))
}

describe("Linux window app_id and desktop file", () => {
  // Tauri's bundler names the packaged desktop file `<productName>.desktop`.
  // Compositors map a window's app_id to the desktop file with the same id.
  it("sets an app_id equal to the desktop file id the bundle produces", () => {
    const appId = /set_prgname\(Some\("([^"]+)"\)\)/.exec(runBody())?.[1]
    expect(appId).toBeDefined()
    expect(`${appId}.desktop`).toBe(`${config().productName}.desktop`)
  })

  it("makes the desktop template's StartupWMClass the same id", () => {
    const template = read(
      `src-tauri/${config().bundle.linux.deb.desktopTemplate}`
    )
    expect(template).toMatch(/^StartupWMClass=\{\{name\}\}$/m)
  })

  it("sets a bundle category so the desktop file's Categories is filled", () => {
    expect(config().bundle.category).toBeTruthy()
  })

  // GTK reads the program name when it starts, so it must be set before
  // anything else in run() can initialise it.
  it("sets the program name first in run()", () => {
    const first = /pub fn run\(\) \{(?:\s*\/\/[^\n]*|\s*#\[cfg\([^\n]*\)\])*\s*([^\n;]+);/.exec(
      runBody()
    )?.[1]
    expect(first?.trim()).toBe('gtk::glib::set_prgname(Some("DataConnect"))')
  })
})
