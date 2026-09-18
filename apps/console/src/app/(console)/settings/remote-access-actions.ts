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

export async function loadRemoteAccessStateAction(): Promise<{
  config: RemoteAccessConfig
  inspection: Awaited<ReturnType<typeof inspectRemoteAccess>>
}> {
  await requireDashboardAccess("/settings")
  const [config, inspection] = await Promise.all([getRemoteAccessConfig(), inspectRemoteAccess()])
  return { config, inspection }
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
