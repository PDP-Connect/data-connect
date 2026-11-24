// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { ROUTES } from "@/config/routes"
import {
  buildGrantSearchParams,
  getGrantParamsFromSearchParams,
} from "@/lib/grant-params"

/**
 * Route for a pasted DEV test link, or null when the input is not actionable.
 * Only web links count: the app registers no custom URL scheme.
 */
export function resolveDebugDeepLinkRoute(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  try {
    const parsed = new URL(trimmed)
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null
    const params = getGrantParamsFromSearchParams(parsed.searchParams)
    if (!params.sessionId && !params.appId) return null
    const qs = buildGrantSearchParams(params).toString()
    const route = params.status === "success" ? ROUTES.grant : ROUTES.connect
    return `${route}${qs ? `?${qs}` : ""}`
  } catch {
    return null
  }
}
