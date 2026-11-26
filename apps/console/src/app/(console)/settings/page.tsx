// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { Text } from "@pdpp/brand-react"
import { PageHeader, Section } from "@pdpp/operator-ui/components/primitives"
import type { Metadata } from "next"
import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx"
import { getProductIdentity } from "@/app/(console)/lib/product-identity.ts"
import { hasValidLocalOwnerCredentialRevealProofCookie } from "../lib/owner-credential-client.ts"
import { OpenExternalLink } from "../components/open-external-link.tsx"
import { RemoteAccessRow } from "./remote-access-row.tsx"
import { isManagedDesktopHost, settingsPracticeFor } from "./settings-host.ts"
import { NotificationsRow } from "./notifications-row.tsx"
import { SettingsRow } from "./settings-row.tsx"
import { loadSettingsSummary } from "./settings-summary-data.ts"
import { AboutSection } from "./about-section.tsx"
import { DesktopPairingSetting } from "./desktop-pairing-setting.tsx"
import { DesktopSettingsPractice } from "./desktop-settings-practice.tsx"
import { DesktopSettingsSetting } from "./desktop-settings-setting.tsx"
import { DeveloperModeSetting } from "./developer-mode-setting.tsx"
import { loadOwnerPasswordSet, loadOwnerPasswordSource } from "./owner-password-data.ts"
import { loadOwnerSessionInventory } from "./owner-sessions-data.ts"
import { RecoveryKeySetting } from "./recovery-key-setting.tsx"

export const metadata: Metadata = {
  title: "Settings",
}

export default async function SettingsPage({ searchParams }: { searchParams?: Promise<{ demo?: string }> }) {
  const demo = (await searchParams)?.demo
  const practice = settingsPracticeFor(demo)
  const identity = getProductIdentity()
  const managedDesktopHost = isManagedDesktopHost(practice)
  const [hasLocalRevealProof, ownerSessions, ownerPasswordSource, ownerPasswordSet] =
    practice ? [practice.revealProof, practice.inventory, practice.passwordSource, practice.passwordSet] as const : await Promise.all([
      hasValidLocalOwnerCredentialRevealProofCookie(),
      loadOwnerSessionInventory(),
      loadOwnerPasswordSource(),
      loadOwnerPasswordSet(),
    ])

  const signedIn = ownerSessions.enabled ? `${ownerSessions.sessions.length} signed in` : null
  const signInWords = [ownerPasswordSource ? (ownerPasswordSet ? "Password set" : "No password yet") : null, signedIn].filter(Boolean).join(" · ") || undefined

  const summary = practice ? { tokens: 2, collectors: 4, webhooks: 0, updates: 0, publicAddress: practice.publicAddress } : await loadSettingsSummary()

  return (
    <RecordroomShellWithPalette>
      <div className="mx-auto grid min-w-0 w-full max-w-5xl grid-cols-1 gap-6 px-4 py-6">
        <PageHeader title="Settings" />
        <Section>
          {managedDesktopHost ? <RemoteAccessRow practiceName={practice?.name} /> : <SettingsRow href="/settings/remote-access" title="Remote access" />}
          <SettingsRow href="/settings/sign-in" title="Password and sign-in" state={signInWords} />
          <SettingsRow href="/deployment/tokens" title="Tokens for scripts and tools" state={summary.tokens === null ? "Could not check" : summary.tokens ? String(summary.tokens) : "None"} />
        </Section>
        <NotificationsRow practice={!!practice} />
        <Section title="Updates">
          <Text as="p">DataConnect {identity.version}</Text>
          <OpenExternalLink href="https://github.com/PDP-Connect/data-connect/releases" className="underline">See the latest version</OpenExternalLink>
          <SettingsRow href="/settings/packages" title="Data source updates" state={summary.updates === null ? "Could not check" : summary.updates ? `${summary.updates} available` : "All up to date"} />
        </Section>
        <Section title="Advanced" description="For scripts, other devices, and people who run DataConnect on a server.">
          {ownerSessions.enabled ? (
            <div className="grid gap-3 py-3">
              {practice ? <DesktopPairingSetting practice /> : <DesktopPairingSetting />}
            </div>
          ) : null}
          <SettingsRow href="/device-exporters" title="Collectors on your devices" state={summary.collectors === null ? "Could not check" : `${summary.collectors} sending`} />
          <SettingsRow href="/event-subscriptions" title="Webhooks" state={summary.webhooks === null ? "Could not check" : String(summary.webhooks)} />
          <SettingsRow href="/deployment" title="Server" state="Checks that DataConnect itself is working" />
          <SettingsRow href="/deployment/provider-apps" title="Sign-in apps for data sources" />
          <div id="developer-mode"><DeveloperModeSetting /></div>
        </Section>
        {managedDesktopHost && hasLocalRevealProof ? (
          <Section description="Control how DataConnect starts on the computer that runs it." title="This computer">
            {practice ? <DesktopSettingsPractice /> : <DesktopSettingsSetting />}
            <div className="grid gap-3 py-5">
              <Text as="h3">Recovery code</Text>
              {practice ? <RecoveryKeySetting practice /> : <RecoveryKeySetting />}
            </div>
          </Section>
        ) : null}
        <AboutSection identity={identity} />
        <Text as="a" href="/settings/technical" link>Technical details</Text>
      </div>
    </RecordroomShellWithPalette>
  )
}
