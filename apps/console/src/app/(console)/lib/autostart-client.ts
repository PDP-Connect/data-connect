// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Server-only client for the owner autostart route family
 * (`/v1/owner/autostart`, reference-implementation/server/routes/
 * owner-autostart.ts). Same owner-bearer pattern as
 * `remote-access-client.ts`/`connector-install-client.ts`.
 */

import { describeErrorText } from "./describe-error.ts"
import {
  getOwnerToken,
  getRsInternalUrl,
  ReferenceServerUnreachableError,
  ResourceServerHttpError,
} from "./owner-token.ts"
import { verifyDashboardSession } from "./verify-session.ts"

export interface AutostartState {
  enabled: boolean
  error: string | null
}

async function autostartFetch(path: string, init: RequestInit = {}): Promise<unknown> {
  await verifyDashboardSession()
  const token = await getOwnerToken()
  let response: Response
  try {
    response = await fetch(`${getRsInternalUrl()}${path}`, {
      cache: "no-store",
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        ...init.headers,
      },
    })
  } catch (err) {
    // biome-ignore lint/style/useErrorCause: matches connector-install-client.ts precedent.
    throw new ReferenceServerUnreachableError(`Cannot reach resource server at ${getRsInternalUrl()}`, err)
  }
  if (!response.ok) {
    const body = await response.text()
    throw new ResourceServerHttpError(
      path,
      response.status,
      describeErrorText(body, `autostart request failed (${response.status})`)
    )
  }
  return response.json()
}

function unwrapData(payload: unknown): unknown {
  return payload && typeof payload === "object" && "data" in payload
    ? (payload as { data: unknown }).data
    : payload
}

export async function getAutostart(): Promise<AutostartState> {
  const payload = await autostartFetch("/v1/owner/autostart")
  return unwrapData(payload) as AutostartState
}

export async function setAutostart(enabled: boolean): Promise<AutostartState> {
  const payload = await autostartFetch("/v1/owner/autostart", {
    body: JSON.stringify({ enabled }),
    method: "POST",
  })
  return unwrapData(payload) as AutostartState
}
