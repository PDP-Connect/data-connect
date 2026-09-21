// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { fileURLToPath } from "node:url"

const HERE = fileURLToPath(new URL(".", import.meta.url))
const SETTING_FILE = `${HERE}owner-credential-setting.tsx`
const ACTIONS_FILE = `${HERE}owner-credential-actions.ts`
const PAGE_FILE = `${HERE}page.tsx`

test("the settings page mounts the Owner password section with the owner credential component", async () => {
  const page = await readFile(PAGE_FILE, "utf8")
  assert.match(page, /<OwnerCredentialSetting \/>/)
  assert.match(page, /title="Owner password"/)
})

test("the warning copy is about screen visibility, not custody of a written-down copy", async () => {
  // This is the LIVE login credential (typed on other devices routinely),
  // not an offline backup transcribed once during an incident like the
  // vault recovery key -- the risk that matters here is who can see the
  // screen right now, not where a written copy ends up.
  const setting = await readFile(SETTING_FILE, "utf8")
  const warningMatch = setting.match(/<p className="pdpp-caption text-muted-foreground">\s*([\s\S]*?)\s*<\/p>/)
  assert.ok(warningMatch, "expected a rendered warning paragraph")
  const warningText = warningMatch?.[1] ?? ""
  assert.match(warningText, /sign in from another device/)
  assert.match(warningText, /no one else can see your screen/)
})

test("the setting goes through the server action, not a direct fetch or invoke() call", async () => {
  const setting = await readFile(SETTING_FILE, "utf8")
  assert.match(setting, /import \{ revealOwnerCredentialAction \} from "\.\/owner-credential-actions\.ts"/)
  assert.doesNotMatch(setting, /invoke\(/, "owner credential reveal has no Tauri-native reason to use invoke()")
  assert.doesNotMatch(setting, /fetch\(/, "owner credential reveal must go through the server action, not a direct fetch")
})

test("the revealed password is rendered in a selectable, copyable block", async () => {
  const setting = await readFile(SETTING_FILE, "utf8")
  assert.match(setting, /<pre[^>]*select-all/)
  assert.match(setting, /navigator\.clipboard\?\.writeText/)
})

test("the action calls the owner-credential client and requires dashboard access, matching the recovery-key precedent", async () => {
  const actions = await readFile(ACTIONS_FILE, "utf8")
  assert.match(actions, /"use server"/)
  assert.match(actions, /await requireDashboardAccess\("\/settings"\)/)
  assert.match(actions, /revealOwnerCredential\(\)/)
})
