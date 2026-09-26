// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Server-only client for the owner recovery-kit export route
 * (`/v1/owner/recovery-kit/export`, reference-implementation/server/routes/
 * owner-recovery-kit.ts). Same owner-bearer pattern as
 * `remote-access-client.ts`: mint the owner token from the dashboard's
 * session cookie, then call the resource server directly.
 */

import { describeErrorText } from "./describe-error.ts"
import {
  getOwnerToken,
  getRsInternalUrl,
  ReferenceServerUnreachableError,
  ResourceServerHttpError,
} from "./owner-token.ts"
import { verifyDashboardSession } from "./verify-session.ts"

export async function exportRecoveryKitCode(): Promise<string> {
  await verifyDashboardSession()
  const token = await getOwnerToken()
  let response: Response
  try {
    response = await fetch(`${getRsInternalUrl()}/v1/owner/recovery-kit/export`, {
      cache: "no-store",
      headers: { Authorization: `Bearer ${token}` },
      method: "POST",
    })
  } catch (err) {
    // biome-ignore lint/style/useErrorCause: matches remote-access-client.ts precedent.
    throw new ReferenceServerUnreachableError(`Cannot reach resource server at ${getRsInternalUrl()}`, err)
  }
  if (!response.ok) {
    const body = await response.text()
    throw new ResourceServerHttpError(
      "/v1/owner/recovery-kit/export",
      response.status,
      describeErrorText(body, `recovery kit export failed (${response.status})`)
    )
  }
  const payload = (await response.json()) as { data?: { code?: unknown } }
  const code = payload.data?.code
  if (typeof code !== "string" || !code) {
    throw new Error("Recovery kit export response did not include a code.")
  }
  return code
}
