// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Server-only client for the owner recovery-kit export route
 * (`/v1/owner/recovery-kit/export`, reference-implementation/server/routes/
 * owner-recovery-kit.ts). Same owner-bearer pattern as
 * `owner-token.ts`: mint the owner token from the dashboard's
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

/** The server refused the export; `code` is its stable error code (never carries the password). */
export class RecoveryKitExportRefusedError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, status: number, message: string) {
    super(message)
    this.name = "RecoveryKitExportRefusedError"
    this.code = code
    this.status = status
  }
}

function errorCodeOf(body: string): string | null {
  try {
    const code = (JSON.parse(body) as { error?: { code?: unknown } }).error?.code
    return typeof code === "string" ? code : null
  } catch {
    return null
  }
}

/** The owner types the password again for every export; it is sent once and not kept. */
export async function exportRecoveryKitCode(password: string): Promise<string> {
  await verifyDashboardSession()
  const token = await getOwnerToken()
  let response: Response
  try {
    response = await fetch(`${getRsInternalUrl()}/v1/owner/recovery-kit/export`, {
      cache: "no-store",
      body: JSON.stringify({ password }),
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      method: "POST",
    })
  } catch (err) {
    // biome-ignore lint/style/useErrorCause: matches the shared owner client.
    throw new ReferenceServerUnreachableError(`Cannot reach resource server at ${getRsInternalUrl()}`, err)
  }
  if (!response.ok) {
    const body = await response.text()
    const code = errorCodeOf(body)
    if (code?.startsWith("owner_")) {
      throw new RecoveryKitExportRefusedError(
        code,
        response.status,
        describeErrorText(body, `recovery kit export refused (${response.status})`)
      )
    }
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
