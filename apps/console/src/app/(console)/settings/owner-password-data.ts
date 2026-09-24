import "server-only"

import { requireDashboardAccess } from "../lib/dashboard-access.ts"
import { redirectToOwnerLogin } from "../lib/login-redirect.ts"
import { getAsInternalUrl, withOwnerSessionCookie } from "../lib/owner-token.ts"

export type OwnerPasswordSource = "app" | "env" | "desktop"

export async function loadOwnerPasswordSource(): Promise<OwnerPasswordSource | null> {
  if (process.env.PDPP_MANAGED_DESKTOP_HOST === "1" && process.env.PDPP_OWNER_PASSWORD_SOURCE === "desktop_generated") {
    return "desktop"
  }
  if (process.env.PDPP_MANAGED_DESKTOP_HOST === "1") return null
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
  return body.source === "app" || body.source === "env" ? body.source : null
}
