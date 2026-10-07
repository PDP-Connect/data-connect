"use server"

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { revealOwnerCredential } from "../lib/owner-credential-client.ts"
import { requireDashboardAccess } from "../lib/dashboard-access.ts"
import { requireOwnerOsReauthAction } from "./owner-password-actions.ts"

export type RevealOwnerCredentialResult =
  | { ok: true; password: string; linuxPolkitUnverified?: boolean }
  | { ok: false; message: string }

function actionMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Unexpected owner credential reveal failure."
}

export async function revealOwnerCredentialAction(): Promise<RevealOwnerCredentialResult> {
  await requireDashboardAccess("/settings")
  try {
    const reauth = await requireOwnerOsReauthAction()
    if (!reauth.ok) return { message: reauth.message ?? "OS re-authentication failed.", ok: false }
    const password = await revealOwnerCredential()
    return { linuxPolkitUnverified: reauth.linuxPolkitUnverified, ok: true, password }
  } catch (err) {
    return { message: actionMessage(err), ok: false }
  }
}
