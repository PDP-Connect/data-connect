// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { PersonalServerError } from "./personalServer"

const LOCAL_TIMELINE_CLIENT_ID = "dataconnect.timeline"

export type LocalTimelineConsentRequest = {
  request_id: string
  session_id: string
  subject_id: string
  scopes: string[]
  authorization_details: LocalTimelineAuthorizationDetails
  access_expires_in_seconds?: number
}

export type LocalTimelineAuthorizationDetails = {
  type: string
  source: { kind: string; id: string }
  access_mode: "single_use" | "continuous"
  purpose_code: string
  purpose_description?: string
  retention?: { max_duration: string; on_expiry: "delete" | "anonymize" }
  streams: Array<{ name: string }>
}

export type LocalTimelineCapability = {
  accessToken: string
  sessionId: string
  subjectId: string
  clientId: typeof LOCAL_TIMELINE_CLIENT_ID
}

type RequestOptions = {
  signal?: AbortSignal
  bearer?: string
  devToken?: string | null
}

/**
 * This is intentionally memory-only. A renderer restart drops the capability
 * and asks for consent again; no bearer or desktop credential reaches storage,
 * URL state, history, or diagnostics.
 */
let localTimelineCapability: LocalTimelineCapability | null = null

export function getLocalTimelineCapability() {
  return localTimelineCapability
}

export function clearLocalTimelineCapability() {
  localTimelineCapability = null
}

export async function createLocalTimelineConsentRequest(
  port: number,
  devToken: string,
  signal?: AbortSignal
): Promise<LocalTimelineConsentRequest> {
  const sessionId = `timeline_session_${crypto.randomUUID()}`
  const subjectId = `timeline_subject_${crypto.randomUUID()}`
  const consent = await request<LocalTimelineConsentRequest>(
    port,
    "/v1/pdpp/local-timeline/consent-requests",
    {
      method: "POST",
      body: { session_id: sessionId, subject_id: subjectId },
      devToken,
      signal,
    }
  )
  if (consent.session_id !== sessionId) {
    throw new PersonalServerError(
      "Personal Server returned a mismatched Timeline session."
    )
  }
  if (consent.subject_id !== subjectId) {
    throw new PersonalServerError(
      "Personal Server returned a mismatched Timeline subject."
    )
  }
  return consent
}

/**
 * Issues the memory-only Timeline capability only after the owner has reviewed
 * the server-normalized terms returned by createLocalTimelineConsentRequest.
 */
export async function approveLocalTimelineConsent(
  port: number,
  devToken: string,
  consent: LocalTimelineConsentRequest,
  signal?: AbortSignal
): Promise<void> {
  const issued = await request<{ access_token: string; token_type: string }>(
    port,
    `/v1/pdpp/local-timeline/consent-requests/${encodeURIComponent(consent.request_id)}/approve`,
    {
      method: "POST",
      body: {
        session_id: consent.session_id,
        subject_id: consent.subject_id,
      },
      devToken,
      signal,
    }
  )
  if (issued.token_type !== "Bearer" || !issued.access_token) {
    throw new PersonalServerError(
      "Personal Server did not issue a Timeline access token."
    )
  }
  localTimelineCapability = {
    accessToken: issued.access_token,
    sessionId: consent.session_id,
    subjectId: consent.subject_id,
    clientId: LOCAL_TIMELINE_CLIENT_ID,
  }
}

export async function revokeLocalTimelineConsent(
  port: number,
  devToken: string,
  capability = localTimelineCapability
) {
  if (!capability) return false
  const result = await request<{ revoked: boolean }>(
    port,
    "/v1/pdpp/local-timeline/revoke",
    {
      method: "POST",
      body: {
        session_id: capability.sessionId,
        subject_id: capability.subjectId,
      },
      devToken,
    }
  )
  clearLocalTimelineCapability()
  return result.revoked
}

export async function readLocalTimeline<T>(
  port: number,
  path: string,
  capability: LocalTimelineCapability,
  signal: AbortSignal
): Promise<T> {
  return request<T>(port, path, {
    method: "GET",
    bearer: capability.accessToken,
    signal,
  })
}

async function request<T>(
  port: number,
  path: string,
  {
    method,
    body,
    signal,
    bearer,
    devToken,
  }: RequestOptions & {
    method: "GET" | "POST"
    body?: unknown
  }
): Promise<T> {
  const { fetch: tauriFetch } = await import("@tauri-apps/plugin-http")
  let response: Response
  try {
    response = await tauriFetch(`http://127.0.0.1:${port}${path}`, {
      method,
      signal,
      headers: {
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
        ...(devToken ? { Authorization: `Bearer ${devToken}` } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
  } catch {
    throw new PersonalServerError("Failed to connect to Personal Server.")
  }
  const responseBody = await response.json().catch(() => null)
  if (!response.ok) {
    throw new PdppTimelineRequestError(
      response.status,
      getErrorCode(responseBody),
      getErrorMessage(responseBody, response.status)
    )
  }
  return responseBody as T
}

export class PdppTimelineRequestError extends PersonalServerError {
  readonly status: number
  readonly code: string | null

  constructor(status: number, code: string | null, message: string) {
    super(message, status)
    this.status = status
    this.code = code
  }
}

function getErrorCode(body: unknown) {
  if (!body || typeof body !== "object") return null
  const candidate = "error" in body ? body.error : null
  if (candidate && typeof candidate === "object" && "code" in candidate) {
    return typeof candidate.code === "string" ? candidate.code : null
  }
  return "code" in body && typeof body.code === "string" ? body.code : null
}

function getErrorMessage(body: unknown, status: number) {
  if (body && typeof body === "object") {
    const candidate = "error" in body ? body.error : null
    if (candidate && typeof candidate === "object" && "message" in candidate) {
      return typeof candidate.message === "string"
        ? candidate.message
        : `Personal Server request failed (HTTP ${status})`
    }
    if ("error" in body && typeof body.error === "string") return body.error
  }
  return `Personal Server request failed (HTTP ${status})`
}
