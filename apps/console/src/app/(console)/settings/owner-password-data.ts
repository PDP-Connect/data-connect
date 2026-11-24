// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import "server-only"

import { requireDashboardAccess } from "../lib/dashboard-access.ts"
import { redirectToOwnerLogin } from "../lib/login-redirect.ts"
import { getAsInternalUrl, withOwnerSessionCookie } from "../lib/owner-token.ts"

export type OwnerPasswordSource = "app" | "env" | "desktop"

/**
 * The RI decides who manages the owner password (`credentialSource` in
 * reference-implementation/server/owner-auth.ts). The console asks it
 * rather than reading its own environment: in v0.7.59 the two disagreed and
 * the desktop showed the env-var message.
 */
export async function loadOwnerPasswordSource(): Promise<OwnerPasswordSource | null> {
  await requireDashboardAccess("/settings")
  const response = await fetch(
    `${getAsInternalUrl()}/owner/password`,
    await withOwnerSessionCookie({
      cache: "no-store",
      headers: { Accept: "application/json" },
    })
  )
  if (response.status === 401) await redirectToOwnerLogin("/settings")
  if (!response.ok) throw new Error(`Could not load owner password settings (${response.status}).`)
  const body = (await response.json()) as { source?: unknown }
  return body.source === "app" || body.source === "env" || body.source === "desktop" ? body.source : null
}
