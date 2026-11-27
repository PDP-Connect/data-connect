// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { PageHeader } from "@pdpp/operator-ui/components/primitives"
import type { Metadata } from "next"
import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx"
import { PrivacyContent } from "./privacy-content.tsx"
import { settingsTrail } from "../settings/settings-trail.ts"

export const metadata: Metadata = {
  title: "Privacy",
}

export default function PrivacyPage() {
  return (
    <RecordroomShellWithPalette>
      <main className="mx-auto grid w-full max-w-5xl gap-6">
        <PageHeader breadcrumbs={settingsTrail("Privacy")} title="Privacy" />
        <PrivacyContent />
      </main>
    </RecordroomShellWithPalette>
  )
}
