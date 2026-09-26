"use server"

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { getAppConfig, getAppConfigEnvelope, patchAppConfig, type AppConfig, type AppConfigPatch } from "../lib/app-config-client.ts"
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
    const current = await getAppConfigEnvelope()
    const fields = Object.keys(current.config) as Array<keyof AppConfig>
    const changed = fields.filter(field => config[field] !== current.config[field])
    if (changed.length > 1) {
      return { message: "App settings changed. Reload before saving.", ok: false }
    }
    if (changed.length === 0) return { config: current.config, ok: true }
    const field = changed[0]!
    const saved = await patchAppConfig({ field, value: config[field] } as AppConfigPatch, current.revision)
    return { config: saved.config, ok: true }
  } catch (err) {
    return { message: actionMessage(err), ok: false }
  }
}

export async function saveAppConfigFieldAction(patch: AppConfigPatch): Promise<AppConfigActionResult> {
  await requireDashboardAccess("/settings")
  try {
    const current = await getAppConfigEnvelope()
    const saved = await patchAppConfig(patch, current.revision)
    return { config: saved.config, ok: true }
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
    // Keep a failure explicit if an older server returns it in state.
    if (state.error) {
      return { message: state.error, ok: false }
    }
    return { enabled: state.enabled, ok: true }
  } catch (err) {
    return { message: actionMessage(err), ok: false }
  }
}
