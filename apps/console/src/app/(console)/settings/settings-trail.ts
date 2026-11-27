// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/** Every page under Settings has the same way back: "Settings / <page>". */
export function settingsTrail(page: string): { href?: string; label: string }[] {
  return [{ href: "/settings", label: "Settings" }, { label: page }];
}
