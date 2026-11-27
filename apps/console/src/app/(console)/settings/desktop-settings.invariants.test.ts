// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { fileURLToPath } from "node:url"

const HERE = fileURLToPath(new URL(".", import.meta.url))
const SETTING_FILE = `${HERE}desktop-settings-setting.tsx`

// Source pins that a behavior test cannot see: which server-action wiring the
// component uses by default, that no invoke() returns, and the copy. Load
// states, defaults and writes are covered by
// desktop-settings-setting.behavior.test.ts; which sections each host shows
// by settings-sections.test.ts.

test("no Tauri invoke() call remains anywhere in this file", async () => {
  const setting = await readFile(SETTING_FILE, "utf8")

  assert.doesNotMatch(
    setting,
    /invoke\(/,
    "desktop settings must go through the owner-authenticated server actions, never invoke()"
  )
})

test("autostart reads and writes go through the dedicated autostart server actions, not the generic app-config actions", async () => {
  const setting = await readFile(SETTING_FILE, "utf8")

  assert.match(setting, /useLiveQuery\("desktop\.autostart", loadAutostart\)/)
  assert.match(setting, /useLiveMutation\("desktop\.autostart", changeAutostart\)/)
  assert.match(setting, /import \{[^}]*loadAutostartAction[^}]*\} from "\.\/desktop-settings-actions\.ts"/)
  assert.match(setting, /import \{[^}]*setAutostartAction[^}]*\} from "\.\/desktop-settings-actions\.ts"/)
})

test("start-minimized reads and writes go through the generic app-config actions, not a dedicated autostart action", async () => {
  const setting = await readFile(SETTING_FILE, "utf8")

  assert.match(setting, /useLiveQuery\("desktop\.app-config", loadAppConfig\)/)
  assert.match(setting, /saveAppConfigField\(\{ field: "startMinimized", value: next \}\)/)
  assert.match(setting, /import \{[^}]*loadAppConfigAction[^}]*\} from "\.\/desktop-settings-actions\.ts"/)
  assert.match(setting, /import \{[^}]*saveAppConfigFieldAction[^}]*\} from "\.\/desktop-settings-actions\.ts"/)
})

test("both toggles are off by default in their copy, matching the surveyed field default", async () => {
  const setting = await readFile(SETTING_FILE, "utf8")

  const offByDefaultMentions = setting.match(/Off by default\./g) ?? []
  assert.equal(
    offByDefaultMentions.length,
    2,
    "both Launch at login and Start minimized must state they default off"
  )
})

test("close-to-tray copy states it is on by default, not off", async () => {
  const setting = await readFile(SETTING_FILE, "utf8")

  assert.match(setting, /On by default\./)
})
