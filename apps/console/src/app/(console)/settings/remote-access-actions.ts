"use server"

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  getRemoteAccessConfig,
  inspectCloudflareTunnelRemoteAccess,
  inspectMyDevicesOnlyRemoteAccess,
  inspectNgrokRemoteAccess,
  inspectRemoteAccess,
  setConsolePort,
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

/**
 * The port the owner relies on, as the desktop supervisor told this process
 * at spawn (`DATACONNECT_CONSOLE_STABLE_PORT`, see
 * `src-tauri/src/console_port.rs`). It differs from `effectiveConsolePort`
 * only when that port was taken at launch. `null` on a host with no desktop
 * supervisor, where `PORT` comes from the environment alone.
 */
function stableConsolePort(): number | null {
  const raw = process.env.DATACONNECT_CONSOLE_STABLE_PORT?.trim()
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : null
}

export async function loadRemoteAccessStateAction(): Promise<{
  config: RemoteAccessConfig
  effectiveConsolePort: number
  stableConsolePort: number | null
  inspection: Awaited<ReturnType<typeof inspectRemoteAccess>>
  ngrokInspection: Awaited<ReturnType<typeof inspectNgrokRemoteAccess>>
  cloudflareTunnelInspection: Awaited<ReturnType<typeof inspectCloudflareTunnelRemoteAccess>>
  myDevicesOnlyInspection: Awaited<ReturnType<typeof inspectMyDevicesOnlyRemoteAccess>>
}> {
  await requireDashboardAccess("/settings")
  const [config, inspection, ngrokInspection, cloudflareTunnelInspection, myDevicesOnlyInspection] =
    await Promise.all([
      getRemoteAccessConfig(),
      inspectRemoteAccess(),
      inspectNgrokRemoteAccess(),
      inspectCloudflareTunnelRemoteAccess(),
      inspectMyDevicesOnlyRemoteAccess(),
    ])
  return {
    config,
    effectiveConsolePort: effectiveConsolePort(),
    stableConsolePort: stableConsolePort(),
    inspection,
    ngrokInspection,
    cloudflareTunnelInspection,
    myDevicesOnlyInspection,
  }
}

export async function setRemoteAccessConfigAction(
  config: RemoteAccessConfig,
  providerCredential?: string,
  acknowledgeRemoteDisconnectRisk?: boolean
): Promise<RemoteAccessActionResult> {
  await requireDashboardAccess("/settings")
  try {
    const saved = await setRemoteAccessConfig(config, providerCredential, acknowledgeRemoteDisconnectRisk)
    return { config: saved, ok: true }
  } catch (err) {
    return { message: actionMessage(err), ok: false }
  }
}

export async function setConsolePortAction(port: number | null): Promise<RemoteAccessActionResult> {
  await requireDashboardAccess("/settings")
  try {
    return { config: await setConsolePort(port), ok: true }
  } catch (err) {
    return { message: actionMessage(err), ok: false }
  }
}
