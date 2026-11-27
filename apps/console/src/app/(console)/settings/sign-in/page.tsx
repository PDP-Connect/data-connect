// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { PageHeader, Section } from "@pdpp/operator-ui/components/primitives"
import type { Metadata } from "next"
import { RecordroomShellWithPalette } from "../../components/recordroom-shell-with-palette.tsx"
import { hasValidLocalOwnerCredentialRevealProofCookie } from "../../lib/owner-credential-client.ts"
import { loadOwnerPasswordSet, loadOwnerPasswordSource } from "../owner-password-data.ts"
import { OwnerPasswordSetting } from "../owner-password-setting.tsx"
import { loadOwnerSessionInventory } from "../owner-sessions-data.ts"
import { isManagedDesktopHost, settingsPracticeFor } from "../settings-host.ts"
import { SignedInSessions } from "../signed-in-sessions.tsx"
import { settingsTrail } from "../settings-trail.ts"

export const metadata: Metadata = { title: "Password and sign-in" }

export default async function SignInPage({ searchParams }: { searchParams?: Promise<{ demo?: string }> }) {
  const practice = settingsPracticeFor((await searchParams)?.demo)
  const managedDesktop = isManagedDesktopHost(practice)
  const [hasLocalRevealProof, ownerSessions, ownerPasswordSource, ownerPasswordSet] =
    practice ? [practice.revealProof, practice.inventory, practice.passwordSource, practice.passwordSet] as const : await Promise.all([
      hasValidLocalOwnerCredentialRevealProofCookie(),
      loadOwnerSessionInventory(),
      loadOwnerPasswordSource(),
      loadOwnerPasswordSet(),
    ])
  return (
    <RecordroomShellWithPalette>
      <div className="mx-auto grid min-w-0 w-full max-w-5xl grid-cols-1 gap-6">
        <PageHeader breadcrumbs={settingsTrail("Password and sign-in")} title="Password and sign-in" />
        <Section>
          {ownerPasswordSource ? (
            <div className="border-b border-border/70 pb-5" id="owner-password">
              <h3 className="mb-2 text-[13px] font-medium text-muted-foreground">Password</h3>
              <OwnerPasswordSetting
                canReveal={ownerPasswordSource === "desktop" && hasLocalRevealProof}
                managedDesktop={managedDesktop}
                passwordSet={ownerPasswordSet}
                practice={!!practice}
                source={ownerPasswordSource}
              />
            </div>
          ) : null}
          {ownerSessions.enabled ? (
            <div className="py-5">
              <h3 className="mb-2 text-[13px] font-medium text-muted-foreground">Where you’re signed in</h3>
              <SignedInSessions practice={!!practice} sessions={ownerSessions.sessions} />
            </div>
          ) : null}
        </Section>
      </div>
    </RecordroomShellWithPalette>
  )
}
