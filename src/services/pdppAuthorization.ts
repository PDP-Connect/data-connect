// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { PersonalServerError } from "./personalServer"

export interface PdppAuthorizationDetail {
  type: "https://pdpp.org/data-access"
  source: { kind: "connector"; id: "github" }
  access_mode: "single_use" | "continuous"
  purpose_code: string
  purpose_description?: string
  retention?: { max_duration: string; on_expiry: "delete" | "anonymize" }
  streams: Array<{
    name: string
    fields?: string[]
    view?: string
    resources?: string[]
    time_range?: { since?: string; until?: string }
  }>
}

export interface GithubPdppConsentRequest {
  request_id: string
  session_id: string
  scopes: string[]
  authorization_details: PdppAuthorizationDetail
}

async function post<T>(
  port: number,
  path: string,
  body: unknown,
  devToken?: string | null
): Promise<T> {
  const { fetch: tauriFetch } = await import("@tauri-apps/plugin-http")
  let response: Response
  try {
    response = await tauriFetch(`http://localhost:${port}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(devToken ? { Authorization: `Bearer ${devToken}` } : {}),
      },
      body: JSON.stringify(body),
    })
  } catch {
    throw new PersonalServerError(
      "Failed to connect to Personal Server. Is it running?"
    )
  }
  const responseBody = await response.json().catch(() => null)
  if (!response.ok) {
    const message =
      typeof responseBody === "object" &&
      responseBody &&
      "error" in responseBody
        ? String(responseBody.error)
        : `Personal Server request failed (HTTP ${response.status})`
    throw new PersonalServerError(message, response.status)
  }
  return responseBody as T
}

/** Create the server-normalized request shown within the existing Vana consent route. */
export function createGithubPdppConsentRequest(
  port: number,
  {
    sessionId,
    scopes,
    authorizationDetails,
  }: {
    sessionId: string
    scopes: string[]
    authorizationDetails: PdppAuthorizationDetail[]
  },
  devToken?: string | null
) {
  return post<GithubPdppConsentRequest>(
    port,
    "/v1/pdpp/consent-requests",
    {
      session_id: sessionId,
      scopes,
      authorization_details: authorizationDetails,
    },
    devToken
  )
}

export function issueGithubPdppGrant(
  port: number,
  {
    requestId,
    legacyGrantId,
    subjectId,
    clientId,
  }: {
    requestId: string
    legacyGrantId: string
    subjectId: string
    clientId: string
  },
  devToken?: string | null
) {
  return post(
    port,
    `/v1/pdpp/consent-requests/${encodeURIComponent(requestId)}/approve`,
    {
      legacy_grant_id: legacyGrantId,
      subject_id: subjectId,
      client_id: clientId,
    },
    devToken
  )
}
