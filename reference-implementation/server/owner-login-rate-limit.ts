// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Login-attempt throttling for `POST /owner/login`.
 *
 * The owner's login page is the single most exposed surface on a
 * remote-access deployment: it is reachable from the entire public internet
 * over the owner's tunnel, and until now nothing stood between an attacker
 * and unlimited password guesses against `crypto.timingSafeEqual`.
 *
 * Design, grounded in `ai/research/product-design/
 * self-hosted-owner-login-throttling-converges-on-time-boxed-auto-expiring-ip-keyed-backoff-never-permanent-lockout.md`:
 *
 *   - Time-boxed, self-clearing block — never a permanent lockout. Vaultwarden,
 *     Nextcloud, and Authelia all converge on this; Home Assistant's permanent
 *     `ip_bans.yaml` (manual edit + restart to undo) is the documented
 *     anti-pattern this deliberately avoids. A control that can strand the
 *     owner out of their own encrypted vault is a worse failure than a slow
 *     brute force.
 *   - Keyed by source IP, not by username/subject. There is exactly one owner
 *     subject, so a username-keyed lock would let any remote caller who knows
 *     that fact (it's a documented default) lock the real owner out by
 *     spamming failed logins from anywhere.
 *   - Local/private-network callers get a much looser threshold than remote
 *     callers, classified from the connection's actual source IP (never the
 *     declared `Host` header, which a remote attacker controls -- see
 *     `isLocalOrPrivateOwnerLoginRequest` below). A stale ngrok tab left
 *     open on the owner's own LAN should not compete with the strict policy
 *     built for the public tunnel.
 *   - No dependency on password-derived state: the counter is purely
 *     request-shaped (IP + timestamp), so it never logs or persists the
 *     password, a hash, or any derived secret.
 */

export interface OwnerLoginRateLimitRequest {
  readonly connection?: { readonly remoteAddress?: string };
  readonly headers: {
    readonly "x-forwarded-proto"?: string;
    readonly host?: string;
  };
  readonly ip?: string;
  readonly secure?: boolean;
  readonly socket?: { readonly remoteAddress?: string };
}

export interface OwnerLoginRateLimitConfig {
  /** Attempts allowed per key within `windowMs` before throttling trips. */
  readonly max?: number;
  /**
   * Attempts allowed per key for local/private-network callers before
   * throttling trips. Deliberately looser than `max` — see module docstring.
   */
  readonly maxLocal?: number;
  /** Sliding window size, in milliseconds, attempts are counted over. */
  readonly windowMs?: number;
}

export interface OwnerLoginRateLimiter {
  /**
   * Returns the number of seconds the caller must wait before retrying, or
   * `null` if the attempt is allowed. Every check counts as an attempt
   * toward the window regardless of outcome — callers should call this once
   * per POST, before checking the password.
   */
  check: (req: OwnerLoginRateLimitRequest) => number | null;
  /**
   * Clears the throttle state for the key a successful login came from, so a
   * legitimate owner who mistyped a few times is not left waiting out the
   * rest of the window after they get it right.
   */
  recordSuccess: (req: OwnerLoginRateLimitRequest) => void;
}

export const OWNER_LOGIN_RATE_LIMIT_DEFAULT_WINDOW_MS = 10 * 60 * 1000;
export const OWNER_LOGIN_RATE_LIMIT_DEFAULT_MAX = 8;
export const OWNER_LOGIN_RATE_LIMIT_DEFAULT_MAX_LOCAL = 100;

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/;

function isPrivateNetworkHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  if (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized.startsWith("127.") ||
    normalized === "0.0.0.0"
  ) {
    return true;
  }
  if (normalized.endsWith(".local")) {
    return true;
  }
  const ipv4 = normalized.match(IPV4_RE);
  if (ipv4) {
    const first = Number(ipv4[1]);
    const second = Number(ipv4[2]);
    return (
      first === 10 ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 169 && second === 254)
    );
  }
  return normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80:");
}

function requestKey(req: OwnerLoginRateLimitRequest): string {
  return req.ip || req.socket?.remoteAddress || req.connection?.remoteAddress || "unknown";
}

// Classifies from the connection's actual source address (the same value
// `requestKey` uses), NOT the declared `Host` header. `Host` is
// attacker-controlled on every incoming request -- a remote caller over the
// public tunnel can simply send `Host: localhost` and would otherwise
// qualify for `maxLocal`, a ~12x looser ceiling than the one this throttle
// exists to enforce against remote callers. Cloudflare Tunnel forwards the
// client's original `Host` unmodified by default (no `httpHostHeader`
// override configured in `remote_access_cloudflare.rs`), so this is not a
// theoretical gap. `req.ip`/`socket.remoteAddress` reflect the actual TCP
// peer the server accepted the connection from, which a client cannot spoof
// at the application layer. (`isLocalOrPrivateRequestOrigin` in
// `metadata.ts` is Host-based by design for its own purpose -- resolving a
// *displayable* public URL, not gating a security control -- so it is not
// reused here even by IP.)
function isLocalOrPrivateOwnerLoginRequest(req: OwnerLoginRateLimitRequest): boolean {
  const key = requestKey(req);
  if (key === "unknown") {
    return false;
  }
  return isPrivateNetworkHostname(key);
}

interface AttemptWindow {
  count: number;
  resetAt: number;
}

/**
 * Sliding-window counter, same shape as `createPublicDcrRateLimiter` in
 * `server/index.ts` — this is the second call site for that pattern, kept as
 * a sibling function rather than a shared abstraction because the two
 * differ in key derivation policy (this one splits local vs. remote
 * thresholds; DCR's does not) and premature sharing would couple two call
 * sites that may evolve independently.
 */
export function createOwnerLoginRateLimiter(config: OwnerLoginRateLimitConfig = {}): OwnerLoginRateLimiter {
  const windowMs = Number.isFinite(config.windowMs)
    ? Math.max(1, config.windowMs as number)
    : OWNER_LOGIN_RATE_LIMIT_DEFAULT_WINDOW_MS;
  const max = Number.isFinite(config.max) ? Math.max(1, config.max as number) : OWNER_LOGIN_RATE_LIMIT_DEFAULT_MAX;
  const maxLocal = Number.isFinite(config.maxLocal)
    ? Math.max(1, config.maxLocal as number)
    : OWNER_LOGIN_RATE_LIMIT_DEFAULT_MAX_LOCAL;
  const attempts = new Map<string, AttemptWindow>();

  function pruneIfLarge(now: number): void {
    if (attempts.size <= 1000) {
      return;
    }
    for (const [key, entry] of attempts.entries()) {
      if (entry.resetAt <= now) {
        attempts.delete(key);
      }
    }
  }

  function check(req: OwnerLoginRateLimitRequest): number | null {
    const now = Date.now();
    pruneIfLarge(now);
    const key = requestKey(req);
    const limit = isLocalOrPrivateOwnerLoginRequest(req) ? maxLocal : max;
    const current = attempts.get(key);
    if (!current || current.resetAt <= now) {
      attempts.set(key, { count: 1, resetAt: now + windowMs });
      return null;
    }
    if (current.count >= limit) {
      // Time-boxed and self-clearing by construction: `resetAt` is a fixed
      // point in the future set the first time this key was seen, and
      // nothing here ever extends it or writes a permanent record. The
      // window clears on its own the moment `resetAt` passes, with no
      // owner or admin action required — the property the research entry
      // found Vaultwarden/Nextcloud/Authelia share and Home Assistant's
      // manual-unban `ip_bans.yaml` model lacks.
      return Math.max(1, Math.ceil((current.resetAt - now) / 1000));
    }
    current.count += 1;
    return null;
  }

  function recordSuccess(req: OwnerLoginRateLimitRequest): void {
    attempts.delete(requestKey(req));
  }

  return { check, recordSuccess };
}
