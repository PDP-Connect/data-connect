// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { fileURLToPath } from "node:url"

const HERE = fileURLToPath(new URL(".", import.meta.url))
const SETTING_FILE = `${HERE}recovery-key-setting.tsx`
const ACTIONS_FILE = `${HERE}recovery-key-actions.ts`
const PAGE_FILE = `${HERE}page.tsx`

test("the settings page mounts the Vault recovery code section with the recovery key component", async () => {
  const page = await readFile(PAGE_FILE, "utf8")
  assert.match(page, /<RecoveryKeySetting \/>/)
  assert.match(page, /title="Vault recovery code"/)
})

test("the warning copy is about custody and says the kit is keys-only", async () => {
  const setting = await readFile(SETTING_FILE, "utf8")
  // Per the research entry backing this design (local vault key recovery
  // artifacts): none of 1Password/Signal/Bitwarden/Proton/Apple/age treat
  // phishing as the primary risk for a recovery artifact -- the risk is
  // custody/storage of the copy, since it is never routinely typed into any
  // UI during normal use. Scoped to the rendered <p> warning specifically
  // (not the whole file) since the module doc comment above the component
  // legitimately discusses phishing to explain why the RENDERED copy avoids
  // it.
  const warningMatch = setting.match(/<p className="pdpp-caption text-muted-foreground">\s*([\s\S]*?)\s*<\/p>/)
  assert.ok(warningMatch, "expected a rendered warning paragraph")
  const warningText = warningMatch?.[1] ?? ""
  assert.match(warningText, /restores encryption keys only/)
  assert.match(warningText, /database backup separately/)
  assert.match(warningText, /read everything in your Personal Server vault/)
  assert.doesNotMatch(
    warningText,
    /phishing/i,
    "recovery-code warning copy must be custody-specific, not a generic phishing warning"
  )
})

test("the setting goes through the server action, not a direct fetch or invoke() call", async () => {
  const setting = await readFile(SETTING_FILE, "utf8")
  assert.match(setting, /import \{ exportRecoveryKitAction \} from "\.\/recovery-key-actions\.ts"/)
  assert.doesNotMatch(setting, /invoke\(/, "recovery kit export has no Tauri-native reason to use invoke()")
  assert.doesNotMatch(setting, /fetch\(/, "recovery kit export must go through the server action, not a direct fetch")
})

test("the exported code is rendered in a selectable, copyable block", async () => {
  const setting = await readFile(SETTING_FILE, "utf8")
  assert.match(setting, /<pre[^>]*select-all/)
  assert.match(setting, /navigator\.clipboard\?\.writeText/)
})

test("the action calls the recovery-kit client and requires dashboard access, matching the remote-access precedent", async () => {
  const actions = await readFile(ACTIONS_FILE, "utf8")
  assert.match(actions, /"use server"/)
  assert.match(actions, /await requireDashboardAccess\("\/settings"\)/)
  assert.match(actions, /exportRecoveryKitCode\(\)/)
})
