"use server"

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  getRemoteAccessConfig,
  inspectNgrokRemoteAccess,
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

export async function loadRemoteAccessStateAction(): Promise<{
  config: RemoteAccessConfig
  inspection: Awaited<ReturnType<typeof inspectRemoteAccess>>
  ngrokInspection: Awaited<ReturnType<typeof inspectNgrokRemoteAccess>>
}> {
  await requireDashboardAccess("/settings")
  const [config, inspection, ngrokInspection] = await Promise.all([
    getRemoteAccessConfig(),
    inspectRemoteAccess(),
    inspectNgrokRemoteAccess(),
  ])
  return { config, inspection, ngrokInspection }
}

export async function setRemoteAccessConfigAction(
  config: RemoteAccessConfig,
  providerCredential?: string
): Promise<RemoteAccessActionResult> {
  await requireDashboardAccess("/settings")
  try {
    const saved = await setRemoteAccessConfig(config, providerCredential)
    return { config: saved, ok: true }
  } catch (err) {
    return { message: actionMessage(err), ok: false }
  }
}
