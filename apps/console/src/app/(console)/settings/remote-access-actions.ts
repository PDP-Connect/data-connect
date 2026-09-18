"use server"

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  getRemoteAccessConfig,
  inspectRemoteAccess,
  setRemoteAccessConfig,
} from "../lib/remote-access-client.ts"
import { requireDashboardAccess } from "../lib/dashboard-access.ts"
import type { RemoteAccessConfig } from "./remote-access.ts"

export type RemoteAccessActionResult =
  | { ok: true; config: RemoteAccessConfig }
  | { ok: false; message: string }

function actionMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Unexpected remote access request failure."
}

/**
 * The port this console process is actually listening on right now -- read
 * directly from `process.env.PORT` (the same variable `next start` binds
 * to; Next's own default when unset is 3000). This is what a proxy the
 * owner runs must target, whether that PORT came from a self-hoster's own
 * env, a platform's injected PORT, or the desktop supervisor's allocation
 * (dynamic or pinned via `RemoteAccessConfig.console_port` -- see
 * `src-tauri/src/unified.rs`'s `console_process_spec`). It is a read of the
 * real running process, never a guess.
 */
function effectiveConsolePort(): number {
  const raw = process.env.PORT?.trim()
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 3000
}

export async function loadRemoteAccessStateAction(): Promise<{
  config: RemoteAccessConfig
  effectiveConsolePort: number
  inspection: Awaited<ReturnType<typeof inspectRemoteAccess>>
}> {
  await requireDashboardAccess("/settings")
  const [config, inspection] = await Promise.all([getRemoteAccessConfig(), inspectRemoteAccess()])
  return { config, effectiveConsolePort: effectiveConsolePort(), inspection }
}

export async function setRemoteAccessConfigAction(
  config: RemoteAccessConfig
): Promise<RemoteAccessActionResult> {
  await requireDashboardAccess("/settings")
  try {
    const saved = await setRemoteAccessConfig(config)
    return { config: saved, ok: true }
  } catch (err) {
    return { message: actionMessage(err), ok: false }
  }
}
