// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { Text } from "@pdpp/brand-react"
import { PageHeader, Section } from "@pdpp/operator-ui/components/primitives"
import type { Metadata } from "next"
import { RecordroomShellWithPalette } from "../../components/recordroom-shell-with-palette.tsx"
import { getProductIdentity } from "../../lib/product-identity.ts"
import { RemoteAccessPractice } from "../remote-access-practice.tsx"
import { RemoteAccessSetting } from "../remote-access-setting.tsx"
import { ServerRemoteAccess } from "../server-remote-access.tsx"
import { isManagedDesktopHost, settingsPracticeFor } from "../settings-host.ts"
import { loadSettingsSummary } from "../settings-summary-data.ts"

export const metadata: Metadata = { title: "Remote access" }

export default async function RemoteAccessPage({ searchParams }: { searchParams?: Promise<{ demo?: string }> }) {
  const practice = settingsPracticeFor((await searchParams)?.demo)
  const identity = getProductIdentity()
  const managed = isManagedDesktopHost(practice)
  const address = managed ? null : practice ? practice.publicAddress : (await loadSettingsSummary()).publicAddress
  return (
    <RecordroomShellWithPalette>
      <div className="mx-auto grid min-w-0 w-full max-w-5xl grid-cols-1 gap-6 px-4 py-6">
        <PageHeader title="Remote access" />
        <Section id="remote-access">
          {!managed ? <ServerRemoteAccess address={address} /> : practice ? <RemoteAccessPractice appVersion={identity.version} name={practice.name} /> : <RemoteAccessSetting appVersion={identity.version} />}
        </Section>
        <Text as="a" href="/settings" link>Back to Settings</Text>
      </div>
    </RecordroomShellWithPalette>
  )
}
