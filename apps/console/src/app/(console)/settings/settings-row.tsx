// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { Text } from "@pdpp/brand-react";
export function SettingsRow({ href, title, state }: { href: string; title: string; state?: string }) {
  return <Text as="a" className="flex min-h-11 items-center justify-between gap-4 border-b border-border/70 py-3" href={href}>
    <span>{title}{state ? <span className="text-muted-foreground"> · {state}</span> : null}</span><span aria-hidden="true">→</span>
  </Text>;
}
