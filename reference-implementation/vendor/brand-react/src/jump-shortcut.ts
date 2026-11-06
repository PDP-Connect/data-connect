// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Label for the Jump (command palette) shortcut. The palette listener accepts
 * Cmd+K and Ctrl+K, so the label only decides which one to show: the Command
 * glyph on Apple platforms, "Ctrl K" everywhere else (including before the
 * client has detected the platform, so server and first client render agree).
 */

const APPLE_PLATFORM = /mac|iphone|ipad|ipod/i;

export const DEFAULT_JUMP_SHORTCUT_LABEL = "Ctrl K";

export function jumpShortcutLabel(platform: string | null | undefined): string {
  return platform && APPLE_PLATFORM.test(platform) ? "⌘K" : DEFAULT_JUMP_SHORTCUT_LABEL;
}
