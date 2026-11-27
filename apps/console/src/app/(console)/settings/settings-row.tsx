// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { Text } from "@pdpp/brand-react";
export function SettingsRow({ attention = false, href, title, state }: { attention?: boolean; href: string; title: string; state?: string }) {
  return <Text as="a" className="flex min-h-11 items-center justify-between gap-4 border-b border-border/70 py-3" href={href}>
    <span>{title}{state ? <span className={attention ? "text-attention" : "text-muted-foreground"}> · {attention ? <span aria-label="Needs attention">! </span> : null}{state}</span> : null}</span><span aria-hidden="true">→</span>
  </Text>;
}
