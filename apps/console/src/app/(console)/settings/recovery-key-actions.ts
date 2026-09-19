"use server"

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { exportDatabaseEncryptionRecoveryCode } from "../lib/recovery-key-client.ts"
import { requireDashboardAccess } from "../lib/dashboard-access.ts"

export type ExportRecoveryCodeResult = { ok: true; code: string } | { ok: false; message: string }

function actionMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Unexpected recovery key export failure."
}

export async function exportRecoveryCodeAction(): Promise<ExportRecoveryCodeResult> {
  await requireDashboardAccess("/settings")
  try {
    const code = await exportDatabaseEncryptionRecoveryCode()
    return { code, ok: true }
  } catch (err) {
    return { message: actionMessage(err), ok: false }
  }
}
