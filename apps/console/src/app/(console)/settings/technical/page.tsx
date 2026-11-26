// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { Text } from "@pdpp/brand-react";
import { PageHeader, Section } from "@pdpp/operator-ui/components/primitives";
import { RecordroomShellWithPalette } from "../../components/recordroom-shell-with-palette.tsx";
import { getProductIdentity } from "../../lib/product-identity.ts";
export default function SettingsTechnicalPage() {
  const identity = getProductIdentity();
  return <RecordroomShellWithPalette><main className="mx-auto grid w-full max-w-5xl gap-6 px-4 py-6">
    <PageHeader title="Settings technical details" />
    <Section title="Password"><Text as="p">Environment passwords come from DATACONNECT_OWNER_PASSWORD or PDPP_OWNER_PASSWORD. Change them where DataConnect starts, then restart it.</Text></Section>
    <Section title="About"><Text as="p">Build · {identity.build}</Text><Text as="p">Protocol · {identity.protocolName}</Text></Section>
    <Text as="a" href="/settings" link>Back to Settings</Text>
  </main></RecordroomShellWithPalette>;
}
