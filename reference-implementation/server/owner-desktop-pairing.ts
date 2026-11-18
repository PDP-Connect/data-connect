// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";

/**
 * Short-lived, single-use pairing codes that let the DataConnect desktop app
 * attach to this server. A signed-in owner creates a code; the desktop redeems
 * it once for an ordinary owner session (see `owner-auth.ts`).
 *
 * Codes live only in this process's memory: a restart discards pending codes,
 * which is acceptable for a ten-minute artifact and avoids any schema change.
 * The map is keyed by the SHA-256 of the normalized code, so a memory dump does
 * not reveal a usable code.
 */

/** No I, O, L, U, 0 or 1: they read as one another or as other characters. */
export const DESKTOP_PAIRING_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
export const DESKTOP_PAIRING_CODE_LENGTH = 12;
export const DESKTOP_PAIRING_TTL_SECONDS = 600;
export const DESKTOP_PAIRING_MAX_OUTSTANDING = 5;
export const DESKTOP_PAIRING_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
export const DESKTOP_PAIRING_DEFAULT_LABEL = "DataConnect desktop";
export const DESKTOP_PAIRING_LABEL_MAX_LENGTH = 80;

const CODE_SEPARATOR_RE = /[\s-]/gu;

export interface DesktopPairingStoreOptions {
  readonly maxOutstanding?: number;
  /** Milliseconds since the epoch. Tests inject a fake clock. */
  readonly now?: () => number;
  readonly ttlSeconds?: number;
}

export interface DesktopPairingCode {
  /** Grouped for display: `ABCD-EFGH-JKMN`. */
  readonly code: string;
  readonly expiresAtMs: number;
}

export interface DesktopPairingStore {
  create: () => DesktopPairingCode;
  /** Consumes the code. True only for a known, unexpired, unused code. */
  redeem: (submitted: string) => boolean;
}

function normalizeDesktopPairingCode(submitted: string): string {
  return submitted.replace(CODE_SEPARATOR_RE, "").toUpperCase();
}

function hashDesktopPairingCode(normalized: string): string {
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

function generateDesktopPairingCode(): string {
  let raw = "";
  for (let i = 0; i < DESKTOP_PAIRING_CODE_LENGTH; i++) {
    raw += DESKTOP_PAIRING_ALPHABET[crypto.randomInt(DESKTOP_PAIRING_ALPHABET.length)];
  }
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8)}`;
}

export function sanitizeDesktopPairingLabel(raw: string | undefined): string {
  return raw?.trim().slice(0, DESKTOP_PAIRING_LABEL_MAX_LENGTH).trim() || DESKTOP_PAIRING_DEFAULT_LABEL;
}

export function createDesktopPairingStore({
  maxOutstanding = DESKTOP_PAIRING_MAX_OUTSTANDING,
  now = () => Date.now(),
  ttlSeconds = DESKTOP_PAIRING_TTL_SECONDS,
}: DesktopPairingStoreOptions = {}): DesktopPairingStore {
  // Map iteration order is insertion order, so the first key is the oldest code.
  const pending = new Map<string, number>();

  function dropExpired(nowMs: number): void {
    for (const [hash, expiresAtMs] of pending) {
      if (expiresAtMs <= nowMs) pending.delete(hash);
    }
  }

  return {
    create(): DesktopPairingCode {
      const nowMs = now();
      dropExpired(nowMs);
      const code = generateDesktopPairingCode();
      const expiresAtMs = nowMs + ttlSeconds * 1000;
      pending.set(hashDesktopPairingCode(normalizeDesktopPairingCode(code)), expiresAtMs);
      while (pending.size > maxOutstanding) {
        const oldest = pending.keys().next().value;
        if (oldest === undefined) break;
        pending.delete(oldest);
      }
      return { code, expiresAtMs };
    },
    redeem(submitted: string): boolean {
      dropExpired(now());
      return pending.delete(hashDesktopPairingCode(normalizeDesktopPairingCode(submitted)));
    },
  };
}
