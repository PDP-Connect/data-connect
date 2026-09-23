// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Server-only client for the owner remote-access route family
 * (`/v1/owner/remote-access/*`, reference-implementation/server/routes/
 * owner-remote-access.ts). Same owner-bearer pattern as
 * `connector-install-client.ts`: mint the owner token from the dashboard's
 * session cookie, then call the resource server directly.
 *
 * Covers both providers: `user_supplied_origin` end to end, and ngrok's
 * config + authtoken submission (the route seals the token server-side; see
 * `owner-remote-access.ts`). ngrok's native work -- OS keychain storage and
 * Rust-side tunnel supervision -- still happens only on a Tauri host, but
 * that host consumes this same HTTP-submitted config via its own config-file
 * watcher, not a direct `invoke()` call from this client.
 */

import { describeErrorText } from "./describe-error.ts"
import {
  getOwnerToken,
  getRsInternalUrl,
  ReferenceServerUnreachableError,
  ResourceServerHttpError,
} from "./owner-token.ts"
import type {
  CloudflareTunnelInspection,
  RemoteAccessConfig,
  RemoteAccessInspection,
} from "../settings/remote-access.ts"
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

export async function setRemoteAccessConfig(
  config: RemoteAccessConfig,
  providerCredential?: string,
  acknowledgeRemoteDisconnectRisk?: boolean
): Promise<RemoteAccessConfig> {
  const body: Record<string, unknown> = { ...config }
  if (providerCredential !== undefined) {
    body.providerCredential = providerCredential
  }
  if (acknowledgeRemoteDisconnectRisk) {
    body.acknowledgeRemoteDisconnectRisk = true
  }
  const payload = await remoteAccessFetch("/v1/owner/remote-access/config", {
    body: JSON.stringify(body),
    method: "POST",
  })
  return unwrapData(payload) as RemoteAccessConfig
}

/** Pin (`port`) or unpin (`null`) the console port alone, for any provider,
 * without resubmitting a provider credential. */
export async function setConsolePort(port: number | null): Promise<RemoteAccessConfig> {
  const payload = await remoteAccessFetch("/v1/owner/remote-access/console-port", {
    body: JSON.stringify({ console_port: port }),
    method: "POST",
  })
  return unwrapData(payload) as RemoteAccessConfig
}

export async function inspectRemoteAccess(): Promise<RemoteAccessInspection> {
  const payload = await remoteAccessFetch("/v1/owner/remote-access/inspect")
  return unwrapData(payload) as RemoteAccessInspection
}

export async function inspectNgrokRemoteAccess(): Promise<RemoteAccessInspection> {
  const payload = await remoteAccessFetch("/v1/owner/remote-access/inspect/ngrok")
  return unwrapData(payload) as RemoteAccessInspection
}

export async function inspectCloudflareTunnelRemoteAccess(): Promise<CloudflareTunnelInspection> {
  const payload = await remoteAccessFetch("/v1/owner/remote-access/inspect/cloudflare_tunnel")
  return unwrapData(payload) as CloudflareTunnelInspection
}

/**
 * `reason` carries the detected LAN IP when `availability` is `"available"`
 * -- not an error message in that case (see
 * `owner-remote-access.ts`'s `my_devices_only` inspect route).
 */
export async function inspectMyDevicesOnlyRemoteAccess(): Promise<RemoteAccessInspection> {
  const payload = await remoteAccessFetch("/v1/owner/remote-access/inspect/my_devices_only")
  return unwrapData(payload) as RemoteAccessInspection
}
