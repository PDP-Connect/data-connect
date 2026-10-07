// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Server-only client for the owner app-config route family
 * (`/v1/owner/app-config`, reference-implementation/server/routes/
 * owner-app-config.ts). Same owner-bearer pattern as
 * `remote-access-client.ts`/`connector-install-client.ts`: mint the owner
 * token from the dashboard's session cookie, then call the resource server
 * directly.
 */

import { describeErrorText } from "./describe-error.ts"
import {
  getOwnerToken,
  getRsInternalUrl,
  ReferenceServerUnreachableError,
  ResourceServerHttpError,
} from "./owner-token.ts"
import { verifyDashboardSession } from "./verify-session.ts"

/** Mirrors AppConfig in src-tauri/src/commands/file_ops.rs and app-config-store.ts. */
export interface AppConfig {
  storageProvider: string | null
  serverMode: string | null
  selfHostedUrl: string | null
  startMinimized: boolean
  closeToTray: boolean
}

export interface AppConfigEnvelope {
  config: AppConfig
  revision: string
}

export type AppConfigPatch = {
  [K in keyof AppConfig]: { field: K; value: AppConfig[K] }
}[keyof AppConfig]

async function appConfigFetch(path: string, init: RequestInit = {}): Promise<unknown> {
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
      describeErrorText(body, `app config request failed (${response.status})`)
    )
  }
  return response.json()
}

function unwrapData(payload: unknown): unknown {
  return payload && typeof payload === "object" && "data" in payload
    ? (payload as { data: unknown }).data
    : payload
}

export async function getAppConfig(): Promise<AppConfig> {
  return (await getAppConfigEnvelope()).config
}

export async function getAppConfigEnvelope(): Promise<AppConfigEnvelope> {
  const payload = await appConfigFetch("/v1/owner/app-config") as { data: AppConfig; revision: string }
  return { config: unwrapData(payload) as AppConfig, revision: payload.revision }
}

export async function patchAppConfig(patch: AppConfigPatch, revision: string): Promise<AppConfigEnvelope> {
  const payload = await appConfigFetch("/v1/owner/app-config", {
    body: JSON.stringify(patch),
    headers: { "If-Match": revision },
    method: "POST",
  }) as { data: AppConfig; revision: string }
  return { config: unwrapData(payload) as AppConfig, revision: payload.revision }
}
