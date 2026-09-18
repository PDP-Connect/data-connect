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

  // Both booleans must start false, and the checked= props must gate on
  // stateIsKnown, not render the unverified default as a real answer — the
  // same discipline remote-access-setting.tsx documents for its posture
  // radios ("must not paint the default config as real state").
  assert.match(setting, /const \[autostartEnabled, setAutostartEnabled\] = useState\(false\)/)
  assert.match(setting, /const \[startMinimized, setStartMinimizedState\] = useState\(false\)/)
  assert.match(setting, /checked=\{stateIsKnown && autostartEnabled\}/)
  assert.match(setting, /checked=\{stateIsKnown && startMinimized\}/)
})

test("the load-state machine degrades honestly across all four states", async () => {
  const setting = await readFile(SETTING_FILE, "utf8")

  for (const state of ["loading", "loaded", "bridge_absent", "failed"]) {
    assert.match(
      setting,
      new RegExp(`"${state}"`),
      `${state} must be a reachable load state`
    )
  }
  assert.match(
    setting,
    /Desktop settings are unavailable here\. Open the DataConnect desktop\s+app/,
    "no Tauri bridge must read as unavailable, not as a guessed off state"
  )
  assert.match(
    setting,
    /desktop settings could not be read, so they are not\s+shown/,
    "a read failure must not fall back to a default that looks real"
  )
})

test("autostart reads and writes go through the dedicated OS-side-effect commands, not the generic config blob", async () => {
  const setting = await readFile(SETTING_FILE, "utf8")

  assert.match(setting, /invoke\("get_autostart_enabled"\)/)
  assert.match(setting, /invoke\("set_autostart_enabled", \{ enabled: next \}\)/)
})

test("start-minimized reads and writes go through the generic app config, not a dedicated command", async () => {
  const setting = await readFile(SETTING_FILE, "utf8")

  assert.match(setting, /invoke\("get_app_config"\)/)
  assert.match(setting, /invoke\("set_app_config", \{/)
  assert.match(setting, /startMinimized: next/)
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

test("close-to-tray defaults to true and reads/writes through the generic app config", async () => {
  const setting = await readFile(SETTING_FILE, "utf8")

  // Unlike startMinimized/autostart (real default false), closeToTray's
  // real default is true (AppConfig::default() in file_ops.rs), so its
  // loaded-state hook must default true, not false -- an unset config must
  // read as "close-to-tray is on", matching what the Rust side actually
  // does when config.json has no closeToTray key at all.
  assert.match(setting, /const \[closeToTray, setCloseToTrayState\] = useState\(true\)/)
  assert.match(setting, /checked=\{stateIsKnown && closeToTray\}/)
  assert.match(setting, /invoke\("set_app_config", \{/)
  assert.match(setting, /closeToTray: next/)
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
