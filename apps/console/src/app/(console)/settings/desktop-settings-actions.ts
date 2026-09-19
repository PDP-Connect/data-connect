"use server"

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { getAppConfig, setAppConfig, type AppConfig } from "../lib/app-config-client.ts"
import { getAutostart, setAutostart, type AutostartState } from "../lib/autostart-client.ts"
import { requireDashboardAccess } from "../lib/dashboard-access.ts"

export type AppConfigActionResult =
  | { ok: true; config: AppConfig }
  | { ok: false; message: string }

export type AutostartActionResult =
  | { ok: true; enabled: boolean }
  | { ok: false; message: string }

function actionMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Unexpected desktop settings request failure."
}

export async function loadAppConfigAction(): Promise<AppConfig> {
  await requireDashboardAccess("/settings")
  return getAppConfig()
}

export async function saveAppConfigAction(config: AppConfig): Promise<AppConfigActionResult> {
  await requireDashboardAccess("/settings")
  try {
    const saved = await setAppConfig(config)
    return { config: saved, ok: true }
  } catch (err) {
    return { message: actionMessage(err), ok: false }
  }
}

export async function loadAutostartAction(): Promise<AutostartState> {
  await requireDashboardAccess("/settings")
  return getAutostart()
}

export async function setAutostartAction(enabled: boolean): Promise<AutostartActionResult> {
  await requireDashboardAccess("/settings")
  try {
    const state = await setAutostart(enabled)
    // The request/ack protocol can "apply" a request whose OS mutation
    // itself failed (see AutostartState.error in autostart-client.ts) --
    // that still needs to surface as a failure, not a silent revert.
    if (state.error) {
      return { message: state.error, ok: false }
    }
    return { enabled: state.enabled, ok: true }
  } catch (err) {
    return { message: actionMessage(err), ok: false }
  }
}
