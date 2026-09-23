// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { fileURLToPath } from "node:url"

const HERE = fileURLToPath(new URL(".", import.meta.url))
const SETTING_FILE = `${HERE}desktop-settings-setting.tsx`
const PAGE_FILE = `${HERE}page.tsx`

test("the settings page mounts the Desktop section with the desktop settings component", async () => {
  const page = await readFile(PAGE_FILE, "utf8")
  assert.match(page, /<DesktopSettingsSetting \/>/)
  assert.match(page, /title="Desktop"/)
})

test("launch-at-login and start-minimized default to unchecked until a real load succeeds", async () => {
  const setting = await readFile(SETTING_FILE, "utf8")

  // Both booleans read false until data arrives, and the checked= props must
  // gate on stateIsKnown, not render the unverified default as a real answer
  // — the same discipline remote-access-setting.tsx documents for its
  // posture radios ("must not paint the default config as real state").
  assert.match(setting, /const autostartEnabled = asAutostartEnabled\(autostart\.data\)/)
  assert.match(setting, /const startMinimized = asStartMinimized\(appConfig\.data\)/)
  assert.match(setting, /checked=\{stateIsKnown && autostartEnabled\}/)
  assert.match(setting, /checked=\{stateIsKnown && startMinimized\}/)
})

test("the load-state machine degrades honestly across all three states", async () => {
  const setting = await readFile(SETTING_FILE, "utf8")

  // bridge_absent no longer applies: neither surface here depends on a
  // Tauri invoke() bridge, so it works identically in-app or in a plain
  // browser hitting the console dev server, exactly like
  // remote-access-setting.tsx's user_supplied_origin path.
  for (const state of ["loading", "loaded", "failed"]) {
    assert.match(
      setting,
      new RegExp(`"${state}"`),
      `${state} must be a reachable load state`
    )
  }
  assert.doesNotMatch(
    setting,
    /"bridge_absent"/,
    "bridge_absent no longer applies now that neither surface depends on invoke()"
  )
  assert.match(
    setting,
    /desktop settings could not be read, so they are not\s+shown/,
    "a read failure must not fall back to a default that looks real"
  )
})

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
  assert.match(setting, /saveAppConfig\(\{ \.\.\.\(await loadAppConfig\(\)\), \.\.\.patch \}\)/)
  assert.match(setting, /saveAppConfigField\(\{ startMinimized: next \}\)/)
  assert.match(setting, /import \{[^}]*loadAppConfigAction[^}]*\} from "\.\/desktop-settings-actions\.ts"/)
  assert.match(setting, /import \{[^}]*saveAppConfigAction[^}]*\} from "\.\/desktop-settings-actions\.ts"/)
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

test("close-to-tray defaults to true and reads/writes through the generic app-config actions", async () => {
  const setting = await readFile(SETTING_FILE, "utf8")

  // Unlike startMinimized/autostart (real default false), closeToTray's
  // real default is true (AppConfig::default() in file_ops.rs), so its
  // loaded value must default true, not false -- an unset config must
  // read as "close-to-tray is on", matching what the Rust side actually
  // does when config.json has no closeToTray key at all.
  assert.match(setting, /const closeToTray = asCloseToTray\(appConfig\.data\)/)
  assert.match(setting, /checked=\{stateIsKnown && closeToTray\}/)
  assert.match(setting, /saveAppConfigField\(\{ closeToTray: next \}\)/)
  assert.match(
    setting,
    /candidate\.closeToTray !== false/,
    "asCloseToTray must only treat an explicit false as off, not an absent/unread value"
  )
})

test("close-to-tray copy states it is on by default, not off", async () => {
  const setting = await readFile(SETTING_FILE, "utf8")

  assert.match(setting, /On by default\./)
})
