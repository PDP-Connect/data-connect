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
};

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
  proofRefreshUnsupported: boolean
): string {
  if (proofRefreshUnsupported) return "Needs your action";
  if (route.state === "released" && route.cleanup.state === "confirmed") return "Off";
  return phaseStatus[lifecyclePhase ?? route.routeState] ?? "Needs your action";
}

// One sentence under the status, only where the status alone would not say it.
export function routeSentence(route: RouteDisplayInput, headline: string): string | null {
  if (headline === "Off" && route.state === "released") return "Your address no longer works.";
  return null;
}

// "verified" is the last observed result. Say when its validity window has ended.
export function proofLine(
  route: RouteDisplayInput,
  now: number,
  options: { synthetic?: boolean } & TimeOptions = {}
): string {
  const { synthetic, ...time } = options;
  const { status, vantage, observedAt } = route.verification;
  const when = observedAt ? `checked ${formatLocalTime(observedAt, time)}` : "check time unknown";
  const where = vantage === "public" ? "Works from the internet" : "Works on this computer";
  const base = status === "verified" ? `${where} · ${when}` : `Not confirmed yet · ${when}`;
  const until = route.verification.validUntil;
  const ended = until?.known && Date.parse(until.value) <= now ? " · check expired; use Check again" : "";
  return `${synthetic ? "Test data: " : ""}${base}${ended}`;
}
