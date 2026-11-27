"use server"

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { exportRecoveryKitCode, RecoveryKitExportRefusedError } from "../lib/recovery-key-client.ts"
import { requireDashboardAccess } from "../lib/dashboard-access.ts"

export type ExportRecoveryKitResult =
  | { ok: true; code: string }
  | { ok: false; reason: "wrong" | "not-set" | "too-many" | "failed"; message: string }

const WRONG = "That password isn't right."
const NOT_SET = "Choose a password first."
const TOO_MANY = "Too many tries. Wait a little, then try again."

function actionMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Unexpected recovery kit export failure."
}

/**
 * The password goes straight to the client function for this one call. It is
 * never logged, stored or returned, and no result carries it.
 */
export async function exportRecoveryKitAction(password: string): Promise<ExportRecoveryKitResult> {
  await requireDashboardAccess("/settings")
  if (typeof password !== "string" || password === "") {
    return { message: WRONG, ok: false, reason: "wrong" }
  }
  try {
    const code = await exportRecoveryKitCode(password)
    return { code, ok: true }
  } catch (err) {
    if (err instanceof RecoveryKitExportRefusedError) {
      if (err.code === "owner_password_not_set") return { message: NOT_SET, ok: false, reason: "not-set" }
      if (err.code === "owner_login_rate_limited") return { message: TOO_MANY, ok: false, reason: "too-many" }
      if (err.code === "owner_password_invalid" || err.code === "owner_password_required") {
        return { message: WRONG, ok: false, reason: "wrong" }
      }
    }
    return { message: actionMessage(err), ok: false, reason: "failed" }
  }
}
