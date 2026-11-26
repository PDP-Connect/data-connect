// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import type { OwnerSessionView } from "./owner-sessions-data.ts";

export function publicSessionAddress(address: string | null): string | null {
  if (!address) return null;
  const raw = address.toLowerCase().replace(/^\[|\]$/g, "");
  if (raw.startsWith("::ffff:")) return publicSessionAddress(raw.slice(7));
  if (raw.includes(":")) {
    try {
      const normalized = new URL(`http://[${raw}]`).hostname.slice(1, -1);
      // Public unicast is 2000::/3. Local, link-local, loopback, multicast and unspecified are excluded.
      return /^[23][0-9a-f]{3}:/.test(normalized) && !normalized.startsWith("2001:db8:") ? address : null;
    } catch { return null; }
  }
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(raw)) return null;
  const parts = raw.split(".").map(Number);
  if (parts.some(part => part > 255)) return null;
  const [a, b] = parts;
  if (a === undefined || b === undefined || a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0)) || (a === 198 && (b === 18 || b === 19))) return null;
  return address;
}
export function buildSignedInModel(sessions: readonly OwnerSessionView[], showAll = false) {
  const ordered = [...sessions].sort((a, b) => Number(b.current) - Number(a.current) || b.lastSeenAt - a.lastSeenAt);
  return { total: ordered.length, otherCount: ordered.filter(row => !row.current).length, rows: (showAll ? ordered : ordered.slice(0, 5)).map(row => ({ ...row, ipAddress: publicSessionAddress(row.ipAddress) })) };
}
