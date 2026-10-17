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

test("the settings page mounts one Owner password section that holds reveal", async () => {
  const page = await readFile(PAGE_FILE, "utf8")
  const passwordSetting = await readFile(`${HERE}owner-password-setting.tsx`, "utf8")
  assert.match(page, /export default async function SettingsPage/)
  assert.equal(page.match(/title="Owner password"/g)?.length, 1)
  assert.doesNotMatch(page, /<OwnerCredentialSetting/)
  assert.match(passwordSetting, /canReveal \? <OwnerCredentialSetting \/> : null/)
  assert.doesNotMatch(page, /Sign in from another device, such as your phone over remote access/)
})

test("reveal is offered only for the RI's desktop source in the desktop's own webview", async () => {
  const page = await readFile(PAGE_FILE, "utf8")
  const client = await readFile(
    `${HERE}../lib/owner-credential-client.ts`,
    "utf8"
  )
  assert.match(
    page,
    /canReveal=\{ownerPasswordSource === "desktop" && hasLocalRevealProof\}/
  )
  assert.match(page, /hasValidLocalOwnerCredentialRevealProofCookie\(\)/)
  assert.doesNotMatch(page, /PDPP_OWNER_PASSWORD_SOURCE/)
  assert.match(client, /timingSafeEqual\(expectedBytes, presentedBytes\)/)
})

test("the reveal client uses the desktop-set reveal cookie, not request Host, as local provenance", async () => {
  const client = await readFile(
    `${HERE}../lib/owner-credential-client.ts`,
    "utf8"
  )
  assert.match(client, /x-pdpp-local-owner-credential-reveal-proof/)
  assert.match(client, /pdpp_owner_credential_reveal/)
  assert.match(client, /cookies\(\)/)
  assert.match(
    client,
    /ownerCredentialRevealHeadersForCookie\(await ownerCredentialRevealProofCookie\(\)\)/
  )
  assert.match(client, /hasValidLocalOwnerCredentialRevealProofCookie/)
  assert.doesNotMatch(client, /headers\(\)/)
  assert.doesNotMatch(client, /requestHeaders\.get\("host"\)/)
  assert.doesNotMatch(client, /x-forwarded-host/)
})

test("the reveal client omits proof headers when the local reveal cookie is absent", async () => {
  const client = await readFile(
    `${HERE}../lib/owner-credential-client.ts`,
    "utf8"
  )
  assert.match(client, /const proof = cookieValue\?\.trim\(\)/)
  assert.match(
    client,
    /return proof \? \{ \[LOCAL_REVEAL_PROOF_HEADER\]: proof \} : \{\}/
  )
})

test("the reveal client forwards the cookie value as the proof for RI verification", async () => {
  const client = await readFile(
    `${HERE}../lib/owner-credential-client.ts`,
    "utf8"
  )
  assert.match(client, /ownerCredentialRevealHeadersForCookie\(cookieValue/)
  assert.match(client, /\[LOCAL_REVEAL_PROOF_HEADER\]: proof/)
})

test("the reveal warning is about screen visibility", async () => {
  const setting = await readFile(SETTING_FILE, "utf8")
  const warningMatch = setting.match(
    /<p className="pdpp-caption text-muted-foreground">\s*([\s\S]*?)\s*<\/p>/
  )
  assert.ok(warningMatch, "expected a rendered warning paragraph")
  const warningText = warningMatch?.[1] ?? ""
  assert.match(warningText, /no one else can see your screen/)
  assert.doesNotMatch(warningText, /sign in from another device/)
})

test("the setting goes through the server action, not a direct fetch or invoke() call", async () => {
  const setting = await readFile(SETTING_FILE, "utf8")
  assert.match(
    setting,
    /import \{ revealOwnerCredentialAction \} from "\.\/owner-credential-actions\.ts"/
  )
  assert.doesNotMatch(
    setting,
    /invoke\(/,
    "owner credential reveal has no Tauri-native reason to use invoke()"
  )
  assert.doesNotMatch(
    setting,
    /fetch\(/,
    "owner credential reveal must go through the server action, not a direct fetch"
  )
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
  assert.match(actions, /requireOwnerOsReauthAction\(\)/)
  assert.match(actions, /revealOwnerCredential\(\)/)
})

test("the desktop password setting has one shared action target", async () => {
  const page = await readFile(PAGE_FILE, "utf8")
  const setting = await readFile(`${HERE}owner-password-setting.tsx`, "utf8")
  assert.match(page, /id="owner-password"[\s\S]*?title="Owner password"/)
  assert.match(setting, /Change password/)
  assert.doesNotMatch(setting, /No OS prompt on Linux yet\./)
})

test("the verified local proof gates reveal and change before any request is written", async () => {
  const actions = await readFile(`${HERE}owner-password-actions.ts`, "utf8")
  assert.match(actions, /ownerOsReauthAllowsReveal/)
  assert.match(actions, /const reauth = await requireOwnerOsReauthGrant\(\)/)
  assert.ok(
    actions.indexOf("hasValidLocalOwnerCredentialRevealProofCookie())") <
      actions.indexOf("requestOwnerOsReauth(dataDir())"),
    "the local proof check must run before an OS reauth request is queued"
  )
})
