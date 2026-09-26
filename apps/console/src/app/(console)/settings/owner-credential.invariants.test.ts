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
  assert.match(page, /export default async function SettingsPage/)
  assert.match(page, /canShowOwnerCredentialRevealSetting\(\)/)
  assert.match(page, /Promise\.all\(\[/)
  assert.match(page, /canShowOwnerCredentialRevealSetting\(\),/)
  assert.match(page, /showOwnerCredentialReveal \? \(/)
  assert.match(
    page,
    /<OwnerCredentialSetting[\s\S]*linuxLocalOnlyNoPromptNotice=\{linuxLocalOnlyNoPromptNotice\}/
  )
  assert.match(page, /title="Owner password"/)
})

test("the owner password section is hidden unless the desktop generated-credential marker is present", async () => {
  const client = await readFile(
    `${HERE}../lib/owner-credential-client.ts`,
    "utf8"
  )
  assert.match(
    client,
    /process\.env\.PDPP_OWNER_PASSWORD_SOURCE === "desktop_generated"/
  )
  assert.match(client, /ownerCredentialRevealProofCookie\(\)\) !== null/)
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
  assert.match(client, /hasLocalOwnerCredentialRevealProofCookie/)
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

test("the warning copy is about screen visibility, not custody of a written-down copy", async () => {
  // This is the LIVE login credential (typed on other devices routinely),
  // not an offline backup transcribed once during an incident like the
  // vault recovery key -- the risk that matters here is who can see the
  // screen right now, not where a written copy ends up.
  const setting = await readFile(SETTING_FILE, "utf8")
  const warningMatch = setting.match(
    /<p className="pdpp-caption text-muted-foreground">\s*([\s\S]*?)\s*<\/p>/
  )
  assert.ok(warningMatch, "expected a rendered warning paragraph")
  const warningText = warningMatch?.[1] ?? ""
  assert.match(warningText, /sign in from another device/)
  assert.match(warningText, /no one else can see your screen/)
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

test("Linux local-only reveal warning is server-rendered before either action starts", async () => {
  const page = await readFile(PAGE_FILE, "utf8")
  const setting = await readFile(SETTING_FILE, "utf8")
  assert.match(page, /process\.platform === "linux"/)
  assert.match(page, /polkit is verified/)
  assert.match(
    page,
    /OwnerCredentialSetting[\s\S]*linuxLocalOnlyNoPromptNotice=\{linuxLocalOnlyNoPromptNotice\}/
  )
  assert.match(
    page,
    /Password changes stay unavailable on Linux until OS re-auth is verified/
  )
  assert.match(
    page,
    /OwnerPasswordSetting[\s\S]*linuxLocalOnlyNoPromptNotice=\{linuxLocalOnlyNoPromptNotice\}/
  )
  assert.match(setting, /linuxLocalOnlyNoPromptNotice/)
  const passwordSetting = await readFile(
    `${HERE}owner-password-setting.tsx`,
    "utf8"
  )
  assert.match(
    passwordSetting,
    /disabled=\{busy \|\| Boolean\(linuxLocalOnlyNoPromptNotice\)\}/
  )
  assert.match(
    passwordSetting,
    /Password change is unavailable on Linux until OS re-auth is verified/
  )
})

test("Linux local-only reveal requires the desktop local proof cookie and change does not use the fallback", async () => {
  const actions = await readFile(`${HERE}owner-password-actions.ts`, "utf8")
  assert.match(actions, /hasLocalOwnerCredentialRevealProofCookie/)
  assert.match(actions, /process\.platform === "linux"/)
  assert.match(actions, /allowLinuxLocalReveal/)
  assert.match(
    actions,
    /Linux owner password changes require verified OS re-authentication/
  )
  assert.match(
    actions,
    /Open Settings from the local desktop app to reveal the owner password on Linux/
  )
  assert.match(
    actions,
    /requireOwnerOsReauthGrant\(\{[\s\S]*allowLinuxLocalReveal: true,[\s\S]*\}\)/
  )
  assert.match(actions, /ownerOsReauthAllowsReveal/)
  assert.match(actions, /state\.status === "skipped_linux_polkit_unverified"/)
  assert.match(actions, /const reauth = await requireOwnerOsReauthGrant\(\)/)
  assert.ok(
    actions.indexOf(
      'process.platform === "linux" && !options.allowLinuxLocalReveal'
    ) < actions.indexOf("requestOwnerOsReauth(dataDir())"),
    "Linux password changes must be denied before queuing a no-prompt reauth request"
  )
})
