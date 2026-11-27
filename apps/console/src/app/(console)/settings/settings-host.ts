// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { buildSettingsPractice } from "./settings-practice.ts"

/** The practice inputs for `?demo=`, in development only. */
export function settingsPracticeFor(demo: string | undefined) {
  return process.env.NODE_ENV !== "production" && demo ? buildSettingsPractice(demo) : null
}

// Desktop and vault-recovery settings write command files only the managed
// desktop host answers; on a server they would do nothing.
export function isManagedDesktopHost(practice: ReturnType<typeof settingsPracticeFor>) {
  return practice?.managedDesktop ?? process.env.PDPP_MANAGED_DESKTOP_HOST === "1"
}
