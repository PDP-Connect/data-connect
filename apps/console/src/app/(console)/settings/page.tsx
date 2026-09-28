// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { PageHeader, Section } from "@pdpp/operator-ui/components/primitives"
import type { Metadata } from "next"
import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx"
import { getProductIdentity } from "@/app/(console)/lib/product-identity.ts"
import { hasValidLocalOwnerCredentialRevealProofCookie } from "../lib/owner-credential-client.ts"
import { AboutSection } from "./about-section.tsx"
import { DesktopSettingsSetting } from "./desktop-settings-setting.tsx"
import { DeveloperModeSetting } from "./developer-mode-setting.tsx"
import { RecoveryKeySetting } from "./recovery-key-setting.tsx"
import { RemoteAccessSetting } from "./remote-access-setting.tsx"
import { OwnerSessionsSetting } from "./owner-sessions-setting.tsx"
import { loadOwnerSessionInventory } from "./owner-sessions-data.ts"
import { loadOwnerPasswordSource } from "./owner-password-data.ts"
import { OwnerPasswordSetting } from "./owner-password-setting.tsx"

export const metadata: Metadata = {
  title: "Settings",
}

export default async function SettingsPage() {
  const identity = getProductIdentity()
  const [hasLocalRevealProof, ownerSessions, ownerPasswordSource] =
    await Promise.all([
      hasValidLocalOwnerCredentialRevealProofCookie(),
      loadOwnerSessionInventory(),
      loadOwnerPasswordSource(),
    ])

  return (
    <RecordroomShellWithPalette>
      <main className="mx-auto grid w-full max-w-5xl gap-6 px-4 py-6">
        <PageHeader
          description="Control optional features for this browser and the way this Personal Server can be reached."
          title="Settings"
        />
        <Section
          description="Reveal connector surfaces intended for local development and connector testing."
          title="Developer mode"
        >
          <DeveloperModeSetting />
        </Section>
        <Section
          description="Choose a local-only posture or configure a proxy you control. Remote access always keeps the Personal Server on loopback."
          title="Remote access"
        >
          <RemoteAccessSetting />
        </Section>
        {ownerPasswordSource ? (
          <Section
            description={
              ownerPasswordSource === "desktop"
                ? "Sign in from another device, such as your phone over remote access."
                : "Change the password used to sign in to this Personal Server."
            }
            title="Owner password"
          >
            <OwnerPasswordSetting
              canReveal={ownerPasswordSource === "desktop" && hasLocalRevealProof}
              linuxNoOsPrompt={process.platform === "linux"}
              managedDesktop={process.env.PDPP_MANAGED_DESKTOP_HOST === "1"}
              source={ownerPasswordSource}
            />
          </Section>
        ) : null}
        {ownerSessions.enabled ? (
          <Section
            description="Review signed-in devices and command-line tokens. Signing one out blocks its next request."
            title="Owner sessions"
          >
            <OwnerSessionsSetting
              bearers={ownerSessions.bearers}
              sessions={ownerSessions.sessions}
            />
          </Section>
        ) : null}
        <Section
          description="Control how DataConnect starts on this computer."
          title="Desktop"
        >
          <DesktopSettingsSetting />
        </Section>
        <Section
          description="Export a printable code that can restore access to your Personal Server vault if your system keychain ever loses its key."
          title="Vault recovery code"
        >
          <RecoveryKeySetting />
        </Section>
        <AboutSection identity={identity} />
      </main>
    </RecordroomShellWithPalette>
  )
}
