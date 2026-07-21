// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { Text } from "@/components/typography/text"
import { LearnMoreLink } from "@/components/typography/link-learn-more"

type GrantWarningProps = {
  align?: "left" | "center" | "right"
}

export function GrantWarning({ align }: GrantWarningProps) {
  return (
    <Text as="p" dim align={align}>
      You can revoke this permission at any time. <LearnMoreLink />
    </Text>
  )
}
