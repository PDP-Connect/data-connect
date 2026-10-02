// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure rules behind the live channel's honest status (see
 * `components/live-provider.tsx`). No imports, so it loads in client
 * components and in node tests alike.
 *
 * - `live` only while the channel is open and a real event arrived within
 *   `LIVE_STALE_AFTER_MS` (two 25 s pings plus slack).
 * - `paused` at once on any channel error or silence; values then refresh on
 *   focus and reconnect only, and the UI says so.
 * - `unsupported` when the response opened but `hello` never arrived: a
 *   proxy on the path buffers the stream (a Cloudflare Quick Tunnel does).
 * - `connecting` right after mount or a return to the tab. The values were
 *   just read, so nothing claims they are stale, and nothing claims live.
 */

export type LiveState = "connecting" | "live" | "paused" | "unsupported"

export const LIVE_STALE_AFTER_MS = 60_000
export const LIVE_HELLO_TIMEOUT_MS = 10_000
const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10_000, 30_000] as const
const UNSUPPORTED_RETRY_MS = 60_000

export function reconnectDelayMs(state: LiveState, attempt: number): number {
  if (state === "unsupported") return UNSUPPORTED_RETRY_MS
  return RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)] ?? 30_000
}

export function isSilent(lastEventAt: number, now: number): boolean {
  return now - lastEventAt > LIVE_STALE_AFTER_MS
}

/**
 * Topics whose revision in `hello` differs from the last one this tab saw.
 * A topic never seen counts as changed: the query may have loaded before
 * the channel opened, and a write in between would otherwise be lost.
 */
export function changedTopics(lastSeen: ReadonlyMap<string, string>, revisions: Record<string, string>): string[] {
  return Object.entries(revisions)
    .filter(([topic, revision]) => lastSeen.get(topic) !== revision)
    .map(([topic]) => topic)
}

export function liveStatusMessage(state: LiveState, readAt: string | null): string | null {
  if (state === "paused") {
    const read = readAt ? ` Settings on this page were last read at ${readAt}.` : ""
    return `Live updates paused.${read} Reconnecting…`
  }
  if (state === "unsupported") {
    return "This connection does not support live updates. Values refresh when you return to this tab."
  }
  return null
}
