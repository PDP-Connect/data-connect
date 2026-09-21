"use server"

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { revealOwnerCredential } from "../lib/owner-credential-client.ts"
import { requireDashboardAccess } from "../lib/dashboard-access.ts"

export type RevealOwnerCredentialResult = { ok: true; password: string } | { ok: false; message: string }

function actionMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Unexpected owner credential reveal failure."
}

export async function revealOwnerCredentialAction(): Promise<RevealOwnerCredentialResult> {
  await requireDashboardAccess("/settings")
  try {
    const password = await revealOwnerCredential()
    return { ok: true, password }
  } catch (err) {
    return { message: actionMessage(err), ok: false }
  }
}
