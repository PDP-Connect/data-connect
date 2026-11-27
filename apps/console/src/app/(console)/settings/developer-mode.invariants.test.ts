// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { fileURLToPath } from "node:url"
import {
  DEVELOPER_MODE_STORAGE_KEY,
  persistDeveloperMode,
  readDeveloperMode,
} from "../lib/source-setup-development.ts"

const PANEL_FILE = fileURLToPath(
  new URL("../sources/add/local-connector-sources-panel.tsx", import.meta.url)
)
const SETTING_FILE = fileURLToPath(
  new URL("./developer-mode-setting.tsx", import.meta.url)
)
const PAGE_FILE = fileURLToPath(new URL("./page.tsx", import.meta.url))
const SHELL_FILE = fileURLToPath(
  new URL(
    "../../../../../../reference-implementation/vendor/brand-react/src/shell-frame.tsx",
    import.meta.url
  )
)

test("developer mode is off by default and persists with the existing local-storage convention", () => {
  const values = new Map<string, string>()
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    removeItem: (key: string) => values.delete(key),
    setItem: (key: string, value: string) => values.set(key, value),
  }

  assert.equal(readDeveloperMode(storage), false)
  persistDeveloperMode(storage, true)
  assert.equal(values.get(DEVELOPER_MODE_STORAGE_KEY), "true")
  assert.equal(readDeveloperMode(storage), true)
  persistDeveloperMode(storage, false)
  assert.equal(values.has(DEVELOPER_MODE_STORAGE_KEY), false)
  assert.equal(readDeveloperMode(storage), false)
})

test("developer-only data sources share one settings gate", async () => {
  const [panel, setting, page, shell] = await Promise.all([
    readFile(PANEL_FILE, "utf8"),
    readFile(SETTING_FILE, "utf8"),
    readFile(PAGE_FILE, "utf8"),
    readFile(SHELL_FILE, "utf8"),
  ])

  assert.match(panel, /if \(!developerMode\) \{/)
  assert.match(setting, /setDeveloperMode\(event\.currentTarget\.checked\)/)
  // RAISE-RULES.md 4: visible copy uses plain words for development data sources.
  assert.match(setting, /Show data sources that are still being built/)
  assert.match(setting, /in-development data sources/)
  assert.match(page, /<DeveloperModeSetting \/>/)
  // DIRECTION.md "The frame and the menu": Settings is a menu item with an icon and children.
  assert.match(shell, /label: "Settings",\s+href: "\/settings"/)
})
