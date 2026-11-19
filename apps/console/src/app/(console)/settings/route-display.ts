// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
// Pure display mapping for one live route card. It reads only fields the server
// already reports; it never creates publication, proof or cleanup claims.

import { formatLocalTime } from "./plain-text.ts";

type TimeOptions = { locale?: string; timeZone?: string; now?: number };
type Known<T> = { known: true; value: T } | { known: false; reason: string };

export type RouteDisplayInput = {
  state: string;
  routeState: string;
  cleanup: { state: string };
  verification: { status: string; vantage: string; observedAt: string | null; validUntil?: Known<string> };
  /** The server's own end time for this route, when it reports one. */
  expiresAt?: Known<string>;
  handle?: { kind?: string };
  /** True when the owner asked for a stop that settled. False when the host holds no such stop. Absent when it was not asked. */
  stopRequested?: boolean;
};

/** Why a route needs the owner, when the server's state alone would show On or Off. */
export type Attention = "lost" | "expired" | "recheck-failed" | "cleanup-unconfirmed";

// The four words the owner sees: Off, Turning on, On, Needs your action
// (plus Turning off while a stop is under way).
const phaseStatus: Record<string, string> = {
  verified: "On",
  usable: "On",
  detected: "Turning on",
  checking: "Turning on",
  applying: "Turning on",
  starting: "Turning on",
  stopping: "Turning off",
  stopped: "Off",
  released: "Off",
  inactive: "Off",
};

// A released route with confirmed cleanup is settled. The lifecycle phase can
// still read "unknown" then, because it also waits for local confinement, which
// Details → Diagnostics reports.
export function routeHeadline(
  route: RouteDisplayInput,
  lifecyclePhase: string | null,
  proofRefreshUnsupported: boolean,
  attention: Attention | null = null
): string {
  if (proofRefreshUnsupported || attention) return "Needs your action";
  if (route.state === "released" && route.cleanup.state === "confirmed") return "Off";
  return phaseStatus[lifecyclePhase ?? route.routeState] ?? "Needs your action";
}

// One sentence under the status, only where the status alone would not say it.
export function routeSentence(route: RouteDisplayInput, headline: string, options: TimeOptions = {}): string | null {
  if (headline === "Off" && route.state === "released") {
    const end = expiryTime(route);
    return end !== null && end <= (options.now ?? Date.now())
      ? `Your address turned off at ${formatLocalTime(end, options)}.`
      : "Your address no longer works.";
  }
  return null;
}

/** The route's end time in ms, only when the server reports one. */
export function expiryTime(route: RouteDisplayInput): number | null {
  const until = route.expiresAt;
  if (!until?.known) return null;
  const ms = Date.parse(until.value);
  return Number.isFinite(ms) ? ms : null;
}

// One lifetime number for the owner: the end time the server reports for this
// route. It is never computed from a label or a requested duration. A temporary
// route whose end the server does not report says so and invents nothing.
export function expiryLine(route: RouteDisplayInput, options: TimeOptions = {}): string | null {
  const end = expiryTime(route);
  if (end !== null) return `Turns off at ${formatLocalTime(end, options)}`;
  return route.handle?.kind === "session" ? "Temporary address; it may turn off or change" : null;
}

/** "just now", "5 min ago", "2 hr ago", "3 days ago". */
export function relativeAge(value: string | null, now: number): string | null {
  const then = value ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(then)) return null;
  const minutes = Math.floor(Math.max(0, now - then) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

// "verified" is the last observed result. The app re-checks before its window
// ends, so the line says only how long ago the last check was.
export function proofLine(
  route: RouteDisplayInput,
  now: number,
  options: { synthetic?: boolean } = {}
): string {
  const { status, vantage, observedAt } = route.verification;
  const age = relativeAge(observedAt, now);
  const when = age ? `checked ${age}` : "check time unknown";
  const where = vantage === "public" ? "Works from the internet" : "Works on this computer";
  const base = status === "verified" ? `${where} · ${when}` : `Not confirmed yet · ${when}`;
  return `${options.synthetic ? "Test data: " : ""}${base}`;
}

/**
 * How long after the browser received a proof to re-check it: the window length
 * the server reported (its end minus its observation, both on the server's
 * clock) less a margin capped to a third of that window and at most a minute.
 * It never compares a server time with the browser's clock. A positive delay applies when
 * the host already calls the proof stale. Null when the server reports no
 * window, so nothing is guessed.
 */
export function recheckDelay(route: RouteDisplayInput, lifecyclePhase: string | null): number | null {
  const until = route.verification.validUntil;
  if (!until?.known) return null;
  if (lifecyclePhase === "stale") return 2_000;
  const end = Date.parse(until.value);
  if (!Number.isFinite(end)) return null;
  const start = route.verification.observedAt ? Date.parse(route.verification.observedAt) : Number.NaN;
  const window = Number.isFinite(start) && end > start ? end - start : 30_000;
  const margin = Math.min(window / 3, 60_000, Math.max(5_000, Math.floor(window / 3)));
  return Math.max(2_000, window - margin);
}

/**
 * The reason a route that looks On or Off needs the owner: the host lost it,
 * its end time passed with cleanup unconfirmed, or the automatic re-check failed.
 * `acknowledged` is set once the owner chose Turn on again for this route.
 */
export function routeAttention(
  route: RouteDisplayInput,
  context: {
    lifecycleReason: string | null;
    recheckFailed: boolean;
    acknowledged: boolean;
    now: number;
    lifecyclePhase: string | null;
    recheckUnderWay: boolean;
    /** The host tried to close this route and could not confirm it, and no stop is under way now. */
    cleanupUnconfirmed?: boolean;
  }
): Attention | null {
  if (context.acknowledged) return null;
  if (context.cleanupUnconfirmed && route.cleanup.state !== "confirmed") return "cleanup-unconfirmed";
  if (route.state === "lost" || context.lifecycleReason === "agent-exited") return "lost";
  if (route.cleanup.state === "confirmed") {
    // Off is only for a stop the owner asked for. A route that ended with no such stop (the tunnel
    // process died, or the session ran out) is the owner's to turn on again.
    if (route.state === "released" && route.stopRequested === false) {
      const ended = expiryTime(route);
      return ended !== null && ended <= context.now ? "expired" : "lost";
    }
    return null;
  }
  // The server stops calling the proof verified at the end time, so a browser
  // clock that runs ahead cannot flip a working address to Needs your action.
  const end = expiryTime(route);
  if (end !== null && end <= context.now && route.verification.status !== "verified") return "expired";
  if (context.recheckFailed) return "recheck-failed";
  // The host calls the proof stale and no re-check is under way to renew it.
  if (context.lifecyclePhase === "stale" && !context.recheckUnderWay) return "recheck-failed";
  return null;
}

/** What happened and what to do, for a route that needs the owner. */
export function attentionSentence(attention: Attention, route: RouteDisplayInput, service: string, options: TimeOptions = {}): string {
  const name = service;
  if (attention === "lost") {
    return `Your address stopped working. ${name} closed the connection. Turn it on again to get a new address, then update it wherever you pasted the old one.`;
  }
  if (attention === "cleanup-unconfirmed") {
    return "We couldn't confirm your address closed. It may still work. Turn it off to try again.";
  }
  if (attention === "expired") {
    const end = expiryTime(route);
    return `Your address turned off${end !== null ? ` at ${formatLocalTime(end, options)}` : ""}. Turn it on again to get a new address, then update it wherever you pasted the old one.`;
  }
  return "We can't confirm the address still works. Turn it on again to get a fresh one.";
}
