// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { ROUTES } from "@/config/routes"
import type { Platform } from "@/types"

const CONSOLE_SOURCES_PATH = "/sources"
// The desktop installs a PDPP connector as `<connector_key>-pdpp` when its
// manifest carries no explicit key (src-tauri connector.rs), so the suffix
// strip mirrors the native fallback. URI ids and legacy runtimes have no
// known reference connector key.
const PDPP_PLATFORM_ID = /^([a-z0-9][a-z0-9-]*?)-pdpp$/
const CONSOLE_SOURCES_PATH_PATTERN =
  /^\/sources(?:\/[A-Za-z0-9._~%-]+)?(?:#[A-Za-z0-9_-]+)?$/

/**
 * Accept only a relative console path under `/sources` (optionally one
 * segment and a fragment). Anything else — absolute URLs, `//host`, `..`,
 * query strings — is refused so the embedded view cannot be sent elsewhere.
 */
export function isConsoleSourcesPath(
  path: string | null | undefined
): path is string {
  if (!path || !CONSOLE_SOURCES_PATH_PATTERN.test(path)) return false
  const segment = path.split("#")[0].split("/")[2]
  if (segment === undefined) return true
  try {
    const decoded = decodeURIComponent(segment)
    return decoded !== "." && decoded !== ".." && !/[/\\?#]/.test(decoded)
  } catch {
    return false
  }
}

/** The reference connector key for a platform, or null when unknown. */
export function referenceConnectorKey(platform: Platform): string | null {
  if (platform.runtime !== "pdpp-network") return null
  return PDPP_PLATFORM_ID.exec(platform.id)?.[1] ?? null
}

/** Console danger zone for the source, or the sources list as a fallback. */
export function consoleDangerZonePath(platform: Platform): string {
  const key = referenceConnectorKey(platform)
  return key
    ? `${CONSOLE_SOURCES_PATH}/${encodeURIComponent(key)}#danger-zone`
    : CONSOLE_SOURCES_PATH
}

export function serverRepairsHref(consolePath: string): string {
  return `${ROUTES.serverRepairs}?${new URLSearchParams({ path: consolePath })}`
}
