// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
// Pure display mapping for one live route card. It reads only fields the server
// already reports; it never creates publication, proof or cleanup claims.

type Known<T> = { known: true; value: T } | { known: false; reason: string };

export type RouteDisplayInput = {
  state: string;
  routeState: string;
  cleanup: { state: string };
  verification: { status: string; vantage: string; observedAt: string | null; validUntil?: Known<string> };
};

// A released route with confirmed cleanup is settled. The lifecycle phase can
// still read "unknown" then, because it also waits for local confinement, which
// the card reports on its own line.
export function routeHeadline(
  route: RouteDisplayInput,
  lifecyclePhase: string | null,
  proofRefreshUnsupported: boolean
): string {
  if (proofRefreshUnsupported) return "Unpublished";
  if (route.state === "released" && route.cleanup.state === "confirmed") return "Released";
  return lifecyclePhase ?? route.routeState;
}

// "verified" is the last observed result. Say when its validity window has ended.
export function proofLine(route: RouteDisplayInput, label: string, now: number): string {
  const base = `${label}: ${route.verification.status} · ${route.verification.vantage} · ${
    route.verification.observedAt ?? "Unknown check time"
  }`;
  const until = route.verification.validUntil;
  if (until?.known && Date.parse(until.value) <= now) {
    return `${base} · proof window ended ${until.value}; check again to refresh`;
  }
  return base;
}
