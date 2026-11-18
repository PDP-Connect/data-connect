"use server"

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { requireDashboardAccess } from "../lib/dashboard-access.ts"
import { redirectToOwnerLogin } from "../lib/login-redirect.ts"
import { getAsInternalUrl, withOwnerSessionCookie } from "../lib/owner-token.ts"
import { parseDesktopPairingResponse } from "./desktop-pairing.ts"

export type CreateDesktopPairingResult =
  | {
      ok: true
      code: string
      link: string
      expiresAt: string
      expiresInSeconds: number
      serverOrigin: string
    }
  | { ok: false; message: string }

const FAILURE_MESSAGE = "Could not create a pairing code."

// Mints a one-time code the desktop app redeems for its own owner session.
// The code is a pairing secret: it is returned to the caller and never logged.
export async function createDesktopPairingAction(): Promise<CreateDesktopPairingResult> {
  await requireDashboardAccess("/settings")
  const response = await fetch(
    `${getAsInternalUrl()}/owner/desktop-pairings`,
    await withOwnerSessionCookie({
      cache: "no-store",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      method: "POST",
    })
  )
  if (response.status === 401) {
    await redirectToOwnerLogin("/settings")
  }
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const message = (body as { error?: { message?: unknown } } | null)?.error
      ?.message
    return {
      ok: false,
      message: typeof message === "string" && message ? message : FAILURE_MESSAGE,
    }
  }
  const pairing = parseDesktopPairingResponse(body)
  if (!pairing) {
    return { ok: false, message: "The server sent an unexpected pairing response." }
  }
  return { ok: true, ...pairing }
}
