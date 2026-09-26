// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Server-only client for the owner credential-reveal route
 * (`/v1/owner/credential/reveal`, reference-implementation/server/routes/
 * owner-credential-reveal.ts). Same owner-bearer pattern as
 * `recovery-key-client.ts`: mint the owner token from the dashboard's
 * session cookie, then call the resource server directly.
 */

import { cookies } from "next/headers"
import { describeErrorText } from "./describe-error.ts"
import {
  getOwnerToken,
  getRsInternalUrl,
  ReferenceServerUnreachableError,
  ResourceServerHttpError,
} from "./owner-token.ts"
import { verifyDashboardSession } from "./verify-session.ts"

const LOCAL_REVEAL_PROOF_HEADER = "x-pdpp-local-owner-credential-reveal-proof"
const LOCAL_REVEAL_COOKIE = "pdpp_owner_credential_reveal"

export function ownerCredentialRevealHeadersForCookie(cookieValue: string | null | undefined): HeadersInit {
  const proof = cookieValue?.trim()
  return proof ? { [LOCAL_REVEAL_PROOF_HEADER]: proof } : {}
}

export async function ownerCredentialRevealProofCookie(): Promise<string | null> {
  const cookieStore = await cookies()
  return cookieStore.get(LOCAL_REVEAL_COOKIE)?.value ?? null
}

async function localRevealHeaders(): Promise<HeadersInit> {
  return ownerCredentialRevealHeadersForCookie(await ownerCredentialRevealProofCookie())
}

export async function hasLocalOwnerCredentialRevealProofCookie(): Promise<boolean> {
  return (await ownerCredentialRevealProofCookie()) !== null
}

export async function canShowOwnerCredentialRevealSetting(): Promise<boolean> {
  return process.env.PDPP_OWNER_PASSWORD_SOURCE === "desktop_generated" && (await hasLocalOwnerCredentialRevealProofCookie())
}

export async function revealOwnerCredential(): Promise<string> {
  await verifyDashboardSession()
  const token = await getOwnerToken()
  let response: Response
  try {
    response = await fetch(`${getRsInternalUrl()}/v1/owner/credential/reveal`, {
      cache: "no-store",
      headers: { Authorization: `Bearer ${token}`, ...(await localRevealHeaders()) },
    })
  } catch (err) {
    // biome-ignore lint/style/useErrorCause: matches recovery-key-client.ts precedent.
    throw new ReferenceServerUnreachableError(`Cannot reach resource server at ${getRsInternalUrl()}`, err)
  }
  if (!response.ok) {
    const body = await response.text()
    throw new ResourceServerHttpError(
      "/v1/owner/credential/reveal",
      response.status,
      describeErrorText(body, `owner credential reveal failed (${response.status})`)
    )
  }
  const payload = (await response.json()) as { data?: { password?: unknown } }
  const password = payload.data?.password
  if (typeof password !== "string" || !password) {
    throw new Error("Owner credential reveal response did not include a password.")
  }
  return password
}
