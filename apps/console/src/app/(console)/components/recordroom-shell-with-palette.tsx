"use client";

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * RecordroomShellWithPalette — drop-in replacement for `RecordroomShell` on
 * routes that live under the dashboard layout (and therefore inside
 * `DashboardPaletteProvider`).
 *
 * It wires the `onJump` prop to `CommandPaletteContext.toggle`, so the Jump
 * button in the shell header and the ⌘K / Ctrl+K shortcut both open (or
 * close) the command palette. Using `toggle` rather than `open` ensures the
 * shell's own ⌘K listener and the provider's listener don't fight — pressing
 * ⌘K once always toggles instead of opening-then-immediately-re-opening.
 *
 * Design invariants:
 *   - `@pdpp/brand-react` does NOT import console or operator-ui concerns —
 *     the dependency is one-way (console → brand-react). We bridge here in the
 *     console layer by reading the context and passing a plain callback down as
 *     `onJump`.
 *   - The theme goes through the same bridge. The shell shows the `theme` it is
 *     given and reports presses through `onToggleTheme`; next-themes stays the
 *     only owner of the choice, so it is stored under `pdpp-theme` and a full
 *     page load keeps it.
 */

import { RecordroomShell } from "@pdpp/brand-react";
import { useTheme } from "@pdpp/operator-ui/components/theme/theme-provider";
import { type ReactNode, useSyncExternalStore } from "react";
import { useCommandPalette } from "./command-palette.tsx";
import { LiveStatusStrip } from "./live-provider.tsx";

// The server cannot see the owner's theme: next-themes resolves it in the
// browser. Until mount, show the label the server rendered, so the first client
// render matches the server HTML. A resolved theme read during that render
// would fail hydration for every owner whose theme is not the server's guess.
const THEME_BEFORE_MOUNT = "dark";

// The mount flag never changes after mount, so the store needs no subscription.
// React reads the server snapshot during hydration and the client snapshot after.
const subscribeNever = () => () => undefined;

interface RecordroomShellWithPaletteProps {
  build?: string;
  children: ReactNode;
  host?: string;
}

export function RecordroomShellWithPalette({ build, children, host }: RecordroomShellWithPaletteProps) {
  const { toggle } = useCommandPalette();
  const { resolvedTheme, setTheme } = useTheme();
  const mounted = useSyncExternalStore(
    subscribeNever,
    () => true,
    () => false
  );
  const theme = mounted ? resolvedTheme : THEME_BEFORE_MOUNT;
  return (
    <RecordroomShell
      build={build}
      host={host}
      onJump={toggle}
      onToggleTheme={() => setTheme(theme === "dark" ? "light" : "dark")}
      theme={theme}
    >
      <LiveStatusStrip />
      {children}
    </RecordroomShell>
  );
}
