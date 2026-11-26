// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure helpers for the "Attach a desktop app" setting: validate the server's
 * pairing response and format the expiry countdown. No React, no I/O, so a
 * node test can exercise all of it.
 */

export const PAIRING_CODE_PATTERN = /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/u
/** Ed25519 public key, 32 raw bytes as unpadded base64url. */
export const SERVER_PUBLIC_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/u
/** Server ID: 16 base32 characters in groups of four. */
export const SERVER_FINGERPRINT_PATTERN = /^[A-Z2-7]{4}(-[A-Z2-7]{4}){3}$/u

export interface DesktopPairing {
  code: string
  link: string
  /** Server-reported expiry, ISO 8601. */
  expiresAt: string
  /** Lifetime from the moment the server answered. Immune to clock skew. */
  expiresInSeconds: number
  serverOrigin: string
  /** The server's Ed25519 public key, base64url. */
  serverPublicKey: string
  /** The Server ID shown in settings and on the desktop: `XXXX-XXXX-XXXX-XXXX`. */
  serverFingerprint: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isHttpOrigin(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === "https:" || url.protocol === "http:"
  } catch {
    return false
  }
}

/**
 * The link is `<origin>/settings#code=<code>&key=<key>`. It must point at the
 * server that answered and carry exactly the code and key in the response.
 */
function linkMatches(
  link: string,
  origin: string,
  code: string,
  key: string
): boolean {
  try {
    const url = new URL(link)
    if (url.origin !== new URL(origin).origin) return false
    const fragment = new URLSearchParams(url.hash.slice(1))
    return fragment.get("code") === code && fragment.get("key") === key
  } catch {
    return false
  }
}

/** Returns the pairing, or null when the body is not a well-formed response. */
export function parseDesktopPairingResponse(
  body: unknown
): DesktopPairing | null {
  if (!isRecord(body) || body.object !== "desktop_pairing") return null
  const {
    code,
    link,
    expires_at,
    expires_in_seconds,
    server_origin,
    server_public_key,
    server_fingerprint,
  } = body
  if (typeof code !== "string" || !PAIRING_CODE_PATTERN.test(code)) return null
  if (typeof server_origin !== "string" || !isHttpOrigin(server_origin)) {
    return null
  }
  if (
    typeof server_public_key !== "string" ||
    !SERVER_PUBLIC_KEY_PATTERN.test(server_public_key)
  ) {
    return null
  }
  if (
    typeof server_fingerprint !== "string" ||
    !SERVER_FINGERPRINT_PATTERN.test(server_fingerprint)
  ) {
    return null
  }
  if (
    typeof link !== "string" ||
    !linkMatches(link, server_origin, code, server_public_key)
  ) {
    return null
  }
  if (typeof expires_at !== "string" || !Number.isFinite(Date.parse(expires_at))) {
    return null
  }
  if (
    typeof expires_in_seconds !== "number" ||
    !Number.isFinite(expires_in_seconds) ||
    expires_in_seconds <= 0
  ) {
    return null
  }
  return {
    code,
    expiresAt: expires_at,
    expiresInSeconds: expires_in_seconds,
    link,
    serverFingerprint: server_fingerprint,
    serverOrigin: server_origin,
    serverPublicKey: server_public_key,
  }
}

/** Whole seconds left, rounded up so "0:00" never shows while still valid. */
export function secondsRemaining(deadlineMs: number, nowMs: number): number {
  return Math.max(0, Math.ceil((deadlineMs - nowMs) / 1000))
}

/** `582` becomes `9:42`. */
export function formatCountdown(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds))
  const minutes = Math.floor(safe / 60)
  const seconds = safe % 60
  return `${minutes}:${String(seconds).padStart(2, "0")}`
}

export function countdownLabel(remainingSeconds: number): string {
  return remainingSeconds <= 0
    ? "Expired. Create a new code."
    : `Expires in ${formatCountdown(remainingSeconds)}`
}
