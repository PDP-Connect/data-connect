// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
// Is this page open through the remote address? The answer decides whether
// Turn off asks first: turning the address off closes a page that came in
// through it.

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

// Scheme, host and port only, lowercased, default port dropped. Null when the
// value is not a web address, so an unknown address never matches anything.
export function normalizeOrigin(value: string | null | undefined): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

function isLoopback(origin: string): boolean {
  const host = new URL(origin).hostname;
  return LOOPBACK_HOSTS.has(host) || host.endsWith(".localhost") || host.startsWith("127.");
}

export function isOpenThroughRoute(pageOrigin: string | null | undefined, routeOrigin: string | null | undefined): boolean {
  const page = normalizeOrigin(pageOrigin);
  const route = normalizeOrigin(routeOrigin);
  if (page === null || route === null) return false;
  if (isLoopback(page)) return false;
  return page === route;
}
