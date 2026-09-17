// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { PageHeader, Section } from "@pdpp/operator-ui/components/primitives"
import type { Metadata } from "next"
import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx"
import { getProductIdentity } from "@/app/(console)/lib/product-identity.ts"
import { AboutSection } from "./about-section.tsx"
import { DeveloperModeSetting } from "./developer-mode-setting.tsx"
import { RemoteAccessSetting } from "./remote-access-setting.tsx"

export const metadata: Metadata = {
  title: "Settings",
}

export default function SettingsPage() {
  const identity = getProductIdentity()

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
        <AboutSection identity={identity} />
      </main>
    </RecordroomShellWithPalette>
  )
}
