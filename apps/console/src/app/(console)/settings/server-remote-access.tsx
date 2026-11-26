// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { Text } from "@pdpp/brand-react";
export function ServerRemoteAccess({ address }: { address: string | null }) {
  return <Text as="p">{address ? <>DataConnect is reached at <span className="break-all">{address}</span>. This address was set up where DataConnect is installed, and is changed there.</> : "Remote access is set up where DataConnect is installed, not from this page."}</Text>;
}
