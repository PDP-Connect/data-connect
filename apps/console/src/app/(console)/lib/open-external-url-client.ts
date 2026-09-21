// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Server-only client for the owner open-external-url route
 * (`/v1/owner/open-external-url`, reference-implementation/server/routes/
 * owner-open-external-url.ts). Same owner-bearer pattern as
 * `autostart-client.ts`/`remote-access-client.ts`.
 */

import { describeErrorText } from "./describe-error.ts"
import {
  getOwnerToken,
  getRsInternalUrl,
  ReferenceServerUnreachableError,
  ResourceServerHttpError,
} from "./owner-token.ts"
import { verifyDashboardSession } from "./verify-session.ts"

export interface OpenExternalUrlResult {
  id: number
  url: string
}

function unwrapData(payload: unknown): unknown {
  return payload && typeof payload === "object" && "data" in payload
    ? (payload as { data: unknown }).data
    : payload
}

export async function openExternalUrl(url: string): Promise<OpenExternalUrlResult> {
  await verifyDashboardSession()
  const token = await getOwnerToken()
  let response: Response
  try {
    response = await fetch(`${getRsInternalUrl()}/v1/owner/open-external-url`, {
      body: JSON.stringify({ url }),
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      method: "POST",
    })
  } catch (err) {
    // biome-ignore lint/style/useErrorCause: matches autostart-client.ts precedent.
    throw new ReferenceServerUnreachableError(`Cannot reach resource server at ${getRsInternalUrl()}`, err)
  }
  if (!response.ok) {
    const body = await response.text()
    throw new ResourceServerHttpError(
      "/v1/owner/open-external-url",
      response.status,
      describeErrorText(body, `open-external-url request failed (${response.status})`)
    )
  }
  return unwrapData(await response.json()) as OpenExternalUrlResult
}
