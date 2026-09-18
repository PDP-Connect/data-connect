// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Server-only client for the owner remote-access route family
 * (`/v1/owner/remote-access/*`, reference-implementation/server/routes/
 * owner-remote-access.ts). Same owner-bearer pattern as
 * `connector-install-client.ts`: mint the owner token from the dashboard's
 * session cookie, then call the resource server directly.
 *
 * This module owns only the `user_supplied_origin` provider surface. ngrok
 * remains desktop-only and keeps calling the existing Tauri commands from
 * `remote-access-setting.tsx` when `window.__TAURI_INTERNALS__` is present.
 */

import { describeErrorText } from "./describe-error.ts"
import {
  getOwnerToken,
  getRsInternalUrl,
  ReferenceServerUnreachableError,
  ResourceServerHttpError,
} from "./owner-token.ts"
import type { RemoteAccessConfig, RemoteAccessInspection } from "../settings/remote-access.ts"
import { verifyDashboardSession } from "./verify-session.ts"

async function remoteAccessFetch(path: string, init: RequestInit = {}): Promise<unknown> {
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
      describeErrorText(body, `remote access request failed (${response.status})`)
    )
  }
  return response.json()
}

function unwrapData(payload: unknown): unknown {
  return payload && typeof payload === "object" && "data" in payload
    ? (payload as { data: unknown }).data
    : payload
}

export async function getRemoteAccessConfig(): Promise<RemoteAccessConfig> {
  const payload = await remoteAccessFetch("/v1/owner/remote-access/config")
  return unwrapData(payload) as RemoteAccessConfig
}

export async function setRemoteAccessConfig(config: RemoteAccessConfig): Promise<RemoteAccessConfig> {
  const payload = await remoteAccessFetch("/v1/owner/remote-access/config", {
    body: JSON.stringify(config),
    method: "POST",
  })
  return unwrapData(payload) as RemoteAccessConfig
}

export async function inspectRemoteAccess(): Promise<RemoteAccessInspection> {
  const payload = await remoteAccessFetch("/v1/owner/remote-access/inspect")
  return unwrapData(payload) as RemoteAccessInspection
}
