// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { PageHeader, Section } from "@pdpp/operator-ui/components/primitives"
import type { Metadata } from "next"
import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx"
import { DeveloperModeSetting } from "./developer-mode-setting.tsx"

export const metadata: Metadata = {
  title: "Settings",
}

export default function SettingsPage() {
  return (
    <RecordroomShellWithPalette>
      <main className="mx-auto grid w-full max-w-5xl gap-6 px-4 py-6">
        <PageHeader
          description="Control optional features for this browser. These settings do not change Personal Server data or protocol permissions."
          title="Settings"
        />
        <Section
          description="Reveal connector surfaces intended for local development and connector testing."
          title="Developer mode"
        >
          <DeveloperModeSetting />
        </Section>
      </main>
    </RecordroomShellWithPalette>
  )
}
