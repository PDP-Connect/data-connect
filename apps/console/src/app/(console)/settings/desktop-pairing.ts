// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure helpers for the "Attach a desktop app" setting: validate the server's
 * pairing response and format the expiry countdown. No React, no I/O, so a
 * node test can exercise all of it.
 */

export const PAIRING_CODE_PATTERN = /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/u
export const PAIRING_LINK_PREFIX = "vana://attach?"

export interface DesktopPairing {
  code: string
  link: string
  /** Server-reported expiry, ISO 8601. */
  expiresAt: string
  /** Lifetime from the moment the server answered. Immune to clock skew. */
  expiresInSeconds: number
  serverOrigin: string
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

function linkCarriesCode(link: string, code: string): boolean {
  try {
    return new URL(link).searchParams.get("code") === code
  } catch {
    return false
  }
}

/** Returns the pairing, or null when the body is not a well-formed response. */
export function parseDesktopPairingResponse(
  body: unknown
): DesktopPairing | null {
  if (!isRecord(body) || body.object !== "desktop_pairing") return null
  const { code, link, expires_at, expires_in_seconds, server_origin } = body
  if (typeof code !== "string" || !PAIRING_CODE_PATTERN.test(code)) return null
  if (typeof link !== "string" || !link.startsWith(PAIRING_LINK_PREFIX)) {
    return null
  }
  if (!linkCarriesCode(link, code)) return null
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
  if (typeof server_origin !== "string" || !isHttpOrigin(server_origin)) {
    return null
  }
  return {
    code,
    expiresAt: expires_at,
    expiresInSeconds: expires_in_seconds,
    link,
    serverOrigin: server_origin,
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
