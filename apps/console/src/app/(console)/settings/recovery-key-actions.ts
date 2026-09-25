"use server"

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { exportRecoveryKitCode } from "../lib/recovery-key-client.ts"
import { requireDashboardAccess } from "../lib/dashboard-access.ts"

export type ExportRecoveryKitResult = { ok: true; code: string } | { ok: false; message: string }

function actionMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Unexpected recovery kit export failure."
}

export async function exportRecoveryKitAction(): Promise<ExportRecoveryKitResult> {
  await requireDashboardAccess("/settings")
  try {
    const code = await exportRecoveryKitCode()
    return { code, ok: true }
  } catch (err) {
    return { message: actionMessage(err), ok: false }
  }
}
