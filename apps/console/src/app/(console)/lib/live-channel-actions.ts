"use server"

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { requireDashboardAccess } from "./dashboard-access.ts"
import { describeErrorText } from "./describe-error.ts"
import { getAsInternalUrl, ReferenceServerUnreachableError, withOwnerSessionCookie } from "./owner-token.ts"

/**
 * Mint a short-lived attach token for the owner live channel
 * (`reference-implementation/server/routes/owner-live.ts`). Same shape as
 * `mintStreamSessionAction`: the dashboard gate runs here, the owner cookie
 * is forwarded, and the reference server checks the session again. The
 * returned path is relative, so the browser attaches through this origin's
 * `/_ref` rewrite, locally or over a tunnel.
 */
export async function mintLiveChannelAction(): Promise<{ eventsPath: string }> {
  await requireDashboardAccess()
  let response: Response
  try {
    response = await fetch(
      `${getAsInternalUrl()}/_ref/owner-live/sessions`,
      await withOwnerSessionCookie({ cache: "no-store", method: "POST" })
    )
  } catch (err) {
    // biome-ignore lint/style/useErrorCause: ReferenceServerUnreachableError threads `err` through as its cause.
    throw new ReferenceServerUnreachableError(`Cannot reach authorization server at ${getAsInternalUrl()}`, err)
  }
  if (!response.ok) {
    throw new Error(describeErrorText(await response.text(), `live channel mint failed (${response.status})`))
  }
  const body = (await response.json()) as { events_path?: unknown }
  if (typeof body.events_path !== "string" || !body.events_path.startsWith("/_ref/owner-live/")) {
    throw new Error("live channel mint returned no events path")
  }
  return { eventsPath: body.events_path }
}
