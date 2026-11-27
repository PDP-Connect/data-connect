// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
// The one line Settings shows for Remote access. It uses the card's own words
// (routeHeadline, proofLine) on the routes the card would list; it adds none.
import { ERROR_MESSAGES, GENERIC_ERROR } from "./reachability-errors.ts";
import { listedRoutes, proofLine, routeAttention, routeHeadline, type RouteDisplayInput } from "./route-display.ts";

type SummaryRoute = RouteDisplayInput & { handle: { id: string; kind?: string }; stopRequested?: boolean };
export type RemoteAccessSummaryState = {
  routes: SummaryRoute[];
  reasons: Record<string, string>;
  lifecycle?: { handle: { id: string } | null; phase?: string | null; reason?: string | null; cleanup?: string } | null;
};

export function remoteAccessWords(state: RemoteAccessSummaryState, now = Date.now()): string {
  const phaseOf = (route: SummaryRoute) => (state.lifecycle?.handle?.id === route.handle.id ? (state.lifecycle.phase ?? null) : null);
  const headlineOf = (route: SummaryRoute) => {
    const phase = phaseOf(route);
    const attention = routeAttention(route, {
      lifecycleReason: state.lifecycle?.handle?.id === route.handle.id ? (state.lifecycle.reason ?? null) : null,
      recheckFailed: false,
      acknowledged: false,
      now,
      lifecyclePhase: phase,
      // The card renews a proof before it ends; Settings does not claim a failure the card has not seen.
      recheckUnderWay: true,
      cleanupUnconfirmed: state.lifecycle?.handle?.id === route.handle.id && state.lifecycle.cleanup === "unconfirmed",
    });
    return routeHeadline(route, phase, state.reasons[route.handle.id] === "proof_refresh_unsupported", attention);
  };
  const shown = listedRoutes(state.routes, [], (route) => headlineOf(route) !== "Off");
  const route = shown.find((candidate) => headlineOf(candidate) !== "Off");
  if (!route) return "Off";
  const headline = headlineOf(route);
  if (headline !== "On") return headline;
  return `On · ${proofLine(route, now).split(" · ")[0]}`;
}

// The row's words for one read of the card's route. A failure the card names (for example the background
// service not running) gives the card's own first sentence; an unnamed one gives "Could not check".
export function remoteAccessRowWords(result: { ok: true; data: unknown } | { ok: false; code: string; message: string }): string {
  if (result.ok) return remoteAccessWords(result.data as RemoteAccessSummaryState);
  const named = Object.hasOwn(ERROR_MESSAGES, result.code) && ERROR_MESSAGES[result.code] !== GENERIC_ERROR;
  return named ? (result.message.match(/^[^.]*/)?.[0] ?? "Could not check") : "Could not check";
}

/** The row carries the warning mark when the card says the owner must act, or names a failure. */
export function remoteAccessRowNeedsAttention(result: { ok: true; data: unknown } | { ok: false; code: string; message: string }): boolean {
  if (result.ok) return remoteAccessWords(result.data as RemoteAccessSummaryState) === "Needs your action";
  return Object.hasOwn(ERROR_MESSAGES, result.code) && ERROR_MESSAGES[result.code] !== GENERIC_ERROR;
}
