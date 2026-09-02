// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Server-side fetch and cache for approved client logos.
 *
 * `spec-core.md:676` treats `logo_uri` as untrusted content: the AS MUST NOT
 * fetch and render a client-supplied remote logo unless the client is
 * verified, or the asset has been proxied, cached, and approved under local
 * policy. This module is the "proxied, cached, and approved" half;
 * `client-trust-registry.ts` owns the "approved" decision and gates every
 * entry point here.
 *
 * **Why the consent page must never emit the client's URL.** Rendering
 * `<img src="https://cdn.someone-else.example/logo.png">` on the consent
 * screen would make the owner's browser fetch it, handing a third party the
 * owner's IP, user agent, and the fact that they are — right now — looking at
 * a consent screen for this client. It would also let the image be swapped
 * after approval, so what the owner reviewed and what a later screenshot
 * shows need not match. Fetching server-side and re-serving from cache
 * removes all three problems: the client learns nothing about the owner, and
 * the bytes are frozen at the moment they were approved.
 *
 * The fetch itself is hostile-input handling. It reuses the same SSRF
 * protections as the CIMD document fetch — DNS resolution restricted to
 * global unicast addresses, the connection pinned to those exact addresses so
 * a second resolution cannot race the check, no redirects, a timeout, and a
 * size cap — because a `logo_uri` is attacker-controlled in exactly the way a
 * `client_id` is.
 */

import { request as undiciRequest } from "undici";

import {
  type DnsLookupAll,
  createPinnedDispatcher,
  isGlobalUnicastAddress,
  resolveAllowedAddresses,
} from "./ssrf-guard.ts";

/** Bounded: a consent-screen avatar, not an image host. */
export const CLIENT_LOGO_MAX_BYTES = 256 * 1024;
export const CLIENT_LOGO_FETCH_TIMEOUT_MS = 5000;
/** Re-fetched daily, so an operator revoking an approval is not defeated by cache. */
export const CLIENT_LOGO_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Raster formats only. SVG is deliberately excluded: it is an executable
 * document that can carry script and external references, and serving one
 * from this server's own origin would place that content inside the consent
 * page's origin — the last place it should run.
 */
const ALLOWED_MEDIA_TYPES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export interface CachedClientLogo {
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  /** The upstream URL these bytes came from, retained for audit only. */
  readonly sourceUri: string;
}

interface CacheEntry {
  readonly expiresAt: number;
  readonly logo: CachedClientLogo;
}

const logoCache = new Map<string, CacheEntry>();

export interface FetchClientLogoOptions {
  dnsLookupImpl?: DnsLookupAll;
  fetchImpl?: typeof undiciRequest;
  isGlobalUnicastAddressImpl?: typeof isGlobalUnicastAddress;
  nowMs?: number;
  timeoutMs?: number;
}

/** Drop a cached logo, e.g. after an operator withdraws an approval. */
export function invalidateClientLogo(cacheKey: string): void {
  logoCache.delete(cacheKey);
}

/** Read a cached logo without fetching. Returns null when absent or stale. */
export function readCachedClientLogo(cacheKey: string, nowMs: number = Date.now()): CachedClientLogo | null {
  const entry = logoCache.get(cacheKey);
  if (!entry || entry.expiresAt <= nowMs) {
    return null;
  }
  return entry.logo;
}

/**
 * Fetch a logo the trust layer has already approved, and cache it.
 *
 * The caller MUST have checked `isLogoFetchAllowed` first; this function
 * deliberately does not re-derive that policy, because the decision needs the
 * operator configuration and the resolved trust basis, and duplicating it
 * here would create two places for the rules to drift apart.
 *
 * Returns null on any failure rather than throwing. A missing logo is a
 * cosmetic problem with an obvious fallback — the monogram — and a consent
 * screen must never fail to render because a third party's CDN is down.
 */
export async function fetchAndCacheClientLogo(
  cacheKey: string,
  logoUri: string,
  {
    dnsLookupImpl,
    fetchImpl = undiciRequest,
    isGlobalUnicastAddressImpl = isGlobalUnicastAddress,
    nowMs = Date.now(),
    timeoutMs = CLIENT_LOGO_FETCH_TIMEOUT_MS,
  }: FetchClientLogoOptions = {}
): Promise<CachedClientLogo | null> {
  const cached = readCachedClientLogo(cacheKey, nowMs);
  if (cached) {
    return cached;
  }

  let url: URL;
  try {
    url = new URL(logoUri);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") {
    return null;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  let dispatcher: ReturnType<typeof createPinnedDispatcher> | null = null;
  try {
    const resolved = await resolveAllowedAddresses(url.hostname, {
      // Omitted rather than passed as undefined so the guard's own default
      // applies (the project builds with exactOptionalPropertyTypes).
      ...(dnsLookupImpl ? { dnsLookupImpl } : {}),
      isGlobalUnicastAddressImpl,
    });
    if (!resolved.ok) {
      return null;
    }
    // Pin the connection to the addresses just validated, so the fetch cannot
    // re-resolve the hostname and land somewhere else (DNS rebinding).
    dispatcher = createPinnedDispatcher(resolved.addresses);

    // undici's `request` does not follow redirects unless `maxRedirections`
    // is set, so a 3xx surfaces as a non-200 status and is refused below.
    // Following one would let the bytes come from a host the client never
    // proved control of, and that the operator never allow-listed.
    const response = await fetchImpl(logoUri, {
      dispatcher,
      headers: { accept: [...ALLOWED_MEDIA_TYPES].join(", ") },
      method: "GET",
      signal: controller.signal,
    });

    if (response.statusCode !== 200) {
      return null;
    }
    const mediaType = String(response.headers["content-type"] ?? "")
      .split(";")[0]
      ?.trim()
      .toLowerCase();
    if (!(mediaType && ALLOWED_MEDIA_TYPES.has(mediaType))) {
      return null;
    }

    // Read with a hard cap, so an oversized or endless body cannot exhaust
    // memory. The declared Content-Length is a hint, not a bound — the cap is
    // enforced against bytes actually received.
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of response.body) {
      const bytes = chunk as Uint8Array;
      total += bytes.byteLength;
      if (total > CLIENT_LOGO_MAX_BYTES) {
        return null;
      }
      chunks.push(bytes);
    }
    if (total === 0) {
      return null;
    }

    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const logo: CachedClientLogo = Object.freeze({
      bytes: merged,
      mediaType,
      sourceUri: logoUri,
    });
    logoCache.set(cacheKey, { expiresAt: nowMs + CLIENT_LOGO_CACHE_TTL_MS, logo });
    return logo;
  } catch {
    // Any failure falls back to the monogram; see the doc comment.
    return null;
  } finally {
    clearTimeout(timeoutId);
    dispatcher?.close().catch(() => {
      // Pool teardown is not a fetch outcome.
    });
  }
}
