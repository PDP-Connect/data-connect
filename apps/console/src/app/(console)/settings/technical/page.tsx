// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { Text } from "@pdpp/brand-react";
import { PageHeader, Section } from "@pdpp/operator-ui/components/primitives";
import { RecordroomShellWithPalette } from "../../components/recordroom-shell-with-palette.tsx";
import { getProductIdentity } from "../../lib/product-identity.ts";
import { RemoteAccessSetting } from "../remote-access-setting.tsx";
import { settingsTrail } from "../settings-trail.ts"
export default async function SettingsTechnicalPage() {
  const identity = getProductIdentity();
  return <RecordroomShellWithPalette><main className="mx-auto grid w-full max-w-5xl gap-6">
    <PageHeader breadcrumbs={settingsTrail("Settings technical details")} title="Settings technical details" />
    <Section title="This computer"><RemoteAccessSetting appVersion={identity.version} technical /></Section>
    <Section title="Password"><Text as="p">Environment passwords come from DATACONNECT_OWNER_PASSWORD or PDPP_OWNER_PASSWORD. Change them where DataConnect starts, then restart it.</Text></Section>
    <Section title="About"><Text as="p">Build · {identity.build}</Text><Text as="p">Protocol · {identity.protocolName}</Text></Section>
  </main></RecordroomShellWithPalette>;
}
