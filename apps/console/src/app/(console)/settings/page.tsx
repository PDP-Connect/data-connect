// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { Text } from "@pdpp/brand-react"
import { PageHeader, Section } from "@pdpp/operator-ui/components/primitives"
import type { Metadata } from "next"
import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx"
import { getProductIdentity } from "@/app/(console)/lib/product-identity.ts"
import { hasValidLocalOwnerCredentialRevealProofCookie } from "../lib/owner-credential-client.ts"
import { AboutSection } from "./about-section.tsx"
import { DesktopPairingSetting } from "./desktop-pairing-setting.tsx"
import { DesktopSettingsSetting } from "./desktop-settings-setting.tsx"
import { DeveloperModeSetting } from "./developer-mode-setting.tsx"
import { loadOwnerPasswordSet, loadOwnerPasswordSource } from "./owner-password-data.ts"
import { OwnerPasswordSetting } from "./owner-password-setting.tsx"
import { loadOwnerSessionInventory } from "./owner-sessions-data.ts"
import { OwnerSessionsSetting } from "./owner-sessions-setting.tsx"
import { RecoveryKeySetting } from "./recovery-key-setting.tsx"
import { RemoteAccessSetting } from "./remote-access-setting.tsx"

export const metadata: Metadata = {
  title: "Settings",
}

export default async function SettingsPage() {
  const identity = getProductIdentity()
  // Desktop and vault-recovery settings write command files only the managed
  // desktop host answers; on a server they would do nothing.
  const managedDesktopHost = process.env.PDPP_MANAGED_DESKTOP_HOST === "1"
  const [hasLocalRevealProof, ownerSessions, ownerPasswordSource, ownerPasswordSet] =
    await Promise.all([
      hasValidLocalOwnerCredentialRevealProofCookie(),
      loadOwnerSessionInventory(),
      loadOwnerPasswordSource(),
      loadOwnerPasswordSet(),
    ])

  return (
    <RecordroomShellWithPalette>
      <main className="mx-auto grid w-full max-w-5xl gap-6 px-4 py-6">
        <PageHeader title="Settings" />
        <Section
          id="remote-access"
          title="Remote access"
        >
          <RemoteAccessSetting appVersion={identity.version} />
        </Section>
        <Section title="Sign-in">
          {ownerPasswordSource ? (
            <div className="border-b border-border/70 pb-5" id="owner-password">
              <h3 className="mb-2 text-[13px] font-medium text-muted-foreground">Owner password</h3>
              <OwnerPasswordSetting
                canReveal={ownerPasswordSource === "desktop" && hasLocalRevealProof}
                managedDesktop={managedDesktopHost}
                passwordSet={ownerPasswordSet}
                source={ownerPasswordSource}
              />
            </div>
          ) : null}
          {ownerSessions.enabled ? (
            <div className="border-b border-border/70 py-5">
              <h3 className="mb-2 text-[13px] font-medium text-muted-foreground">Signed-in devices</h3>
              <OwnerSessionsSetting
                bearers={ownerSessions.bearers}
                sessions={ownerSessions.sessions}
              />
            </div>
          ) : null}
          <Text
            as="a"
            className="flex min-h-11 items-center justify-between border-b border-border/70 py-3 text-[15px] font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            href="/deployment/tokens"
          >
            <span>Access tokens</span>
            <span aria-hidden="true" className="text-muted-foreground">→</span>
          </Text>
          {ownerSessions.enabled ? (
            <div className="py-5">
              <h3 className="mb-2 text-[13px] font-medium text-muted-foreground">Attach a desktop app</h3>
              <DesktopPairingSetting />
            </div>
          ) : null}
        </Section>
        {managedDesktopHost ? (
          <>
        {/* Shown in any signed-in browser, not only the desktop window: the
            owner may change how the desktop app starts from a phone that
            reaches it over remote access (e2e/live-settings.spec.ts). */}
        <Section
          description="Control how DataConnect starts on the computer that runs it."
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
          </>
        ) : null}
        <Section title="Developer mode">
          <DeveloperModeSetting />
        </Section>
        <AboutSection identity={identity} />
      </main>
    </RecordroomShellWithPalette>
  )
}
