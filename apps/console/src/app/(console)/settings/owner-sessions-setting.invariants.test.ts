// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { fileURLToPath } from "node:url"

const SETTING_FILE = fileURLToPath(new URL("./owner-sessions-setting.tsx", import.meta.url))

test("sign-out and access-token revocation ask for confirmation first", async () => {
  const src = await readFile(SETTING_FILE, "utf8")
  // RAISE-RULES.md 5: every sign-out and revoke action has a named confirmation step.
  assert.match(src, /role="alertdialog"/)
  assert.match(src, /Sign out the other devices\?/)
  assert.match(src, /Sign out all devices, including this one\?/)
  assert.match(src, /Sign out this device\?/)
  assert.match(src, /Revoke this access token\?/)
  assert.match(src, /Confirm sign out/)
  assert.match(src, /Confirm revoke/)
  assert.match(src, /Cancel/)
})

test("signed-in device times use relative dates and technical fields stay in Details", async () => {
  const src = await readFile(SETTING_FILE, "utf8")
  // RAISE-RULES.md 4 and 6: no raw date strings; technical session data stays folded.
  assert.match(src, /formatRelative\(new Date\(milliseconds\), Date\.now\(\)\)/)
  assert.match(src, /<details className="text-\[13px\] text-muted-foreground">[\s\S]*?IP address/)
  assert.doesNotMatch(src, /toISOString\(\)/)
})

test("the owner-bearer list is named for what it holds, not a second \"Access tokens\"", async () => {
  const src = await readFile(SETTING_FILE, "utf8")
  // Settings repair brief, decision 2: /owner/sessions `bearers` are every active owner bearer
  // (reference-implementation/server/stores/owner-session-store.ts selectOwnerBearerSql), so
  // the heading says who holds them instead of repeating the /deployment/tokens title.
  assert.match(src, />Apps and scripts signed in as you<\/h3>/)
  assert.match(src, /No apps or scripts are signed in as you\./)
  assert.doesNotMatch(src, />Access tokens<\/h3>/)
})
