// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Server-only client for the owner autostart route family
 * (`/v1/owner/autostart`, reference-implementation/server/routes/
 * owner-autostart.ts). Same owner-bearer pattern as
 * `connector-install-client.ts`.
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
  /** False until the desktop app has reported its setting. Older servers omit this field. */
  known?: boolean
  /** A requested change the desktop app has not applied yet. Absent from older servers. */
  pending?: boolean
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
    const error = new ResourceServerHttpError(
      path,
      response.status,
      describeErrorText(body, `autostart request failed (${response.status})`)
    )
    let code: string | undefined
    try {
      const parsed: unknown = JSON.parse(body)
      if (parsed && typeof parsed === "object" && "error" in parsed) {
        const detail = (parsed as { error?: unknown }).error
        if (detail && typeof detail === "object" && "code" in detail && typeof detail.code === "string") {
          code = detail.code
        }
      }
    } catch {
      // Older endpoints may return plain-text errors.
    }
    if (code) Object.assign(error, { code })
    throw error
  }
  return response.json()
}

function unwrapData(payload: unknown): unknown {
  return payload && typeof payload === "object" && "data" in payload
    ? (payload as { data: unknown }).data
    : payload
}

export async function getAutostart(): Promise<AutostartState> {
  try {
    const payload = await autostartFetch("/v1/owner/autostart")
    return unwrapData(payload) as AutostartState
  } catch (err) {
    if (
      err instanceof ResourceServerHttpError &&
      err.path === "/v1/owner/autostart" &&
      err.status === 500 &&
      // Older servers send the generic "api_error" code, so the message stays a fallback.
      ((err as ResourceServerHttpError & { code?: string }).code === "autostart_state_not_reported" ||
        err.body.startsWith("Autostart state is not available yet"))
    ) {
      return { enabled: false, error: null, known: false }
    }
    throw err
  }
}

export async function setAutostart(enabled: boolean): Promise<AutostartState> {
  const payload = await autostartFetch("/v1/owner/autostart", {
    body: JSON.stringify({ enabled }),
    method: "POST",
  })
  return unwrapData(payload) as AutostartState
}
