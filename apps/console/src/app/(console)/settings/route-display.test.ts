// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  attentionSentence,
  expiryLine,
  journalUnreadableWarning,
  listedRoutes,
  proofLine,
  recheckDelay,
  routeAttention,
  routeCardProofLine,
  routeHeadline,
  routeSentence,
  type RouteDisplayInput,
} from "./route-display.ts";
import { diedRoute } from "./real-gozar-shapes.fixture.ts";

// Values copied from the secret-free /v1/owner/reachability/state snapshots of
// the packaged native walk (plan050 evidence state-snapshots-run2.jsonl, same
// handle): the server moved the lifecycle to "stale" at validUntil while the
// route view kept status "verified"; after Stop the route was released with
// cleanup confirmed while the lifecycle phase read "unknown".
const staleRoute: RouteDisplayInput = {
  state: "usable", routeState: "verified", cleanup: { state: "none" },
  verification: {
    status: "verified", vantage: "public", observedAt: "2026-11-18T07:08:13.767Z",
    validUntil: { known: true, value: "2026-11-18T07:08:43.767Z" },
  },
};
const releasedRoute: RouteDisplayInput = {
  state: "released", routeState: "released", cleanup: { state: "confirmed" },
  verification: { status: "unverified", vantage: "this-device", observedAt: "2026-11-18T07:11:04.000Z" },
};
const utc = { locale: "en-US", timeZone: "UTC", now: Date.parse("2026-11-18T12:00:00Z") };

test("the proof line says how long ago it was checked and never shows an expiry notice", () => {
  const line = proofLine(staleRoute, Date.parse("2026-11-18T07:08:43.857Z"));
  assert.equal(line, "Works from the internet · checked just now");
  assert.equal(proofLine(staleRoute, Date.parse("2026-11-18T07:13:20Z")), "Works from the internet · checked 5 min ago");
  assert.doesNotMatch(line, /expired|Check again|\d{4}-\d{2}-\d{2}T/);
  assert.equal(routeHeadline(staleRoute, "stale", false), "Needs your action");
});

test("an unverified route is not called working; test data is labelled; no check time is not invented", () => {
  assert.match(proofLine(releasedRoute, Date.parse("2026-11-18T14:12:04Z")), /^Not confirmed yet · checked 7 hr ago/);
  assert.match(proofLine(staleRoute, Date.parse("2026-11-18T07:09:00Z"), { synthetic: true }), /^Test data: Works from the internet/);
  const unknownTime = { ...staleRoute, verification: { ...staleRoute.verification, observedAt: null } };
  assert.match(proofLine(unknownTime, 0), /check time unknown/);
});

test("the ended route card omits proof when cleanup is confirmed", () => {
  const now = Date.parse("2026-11-18T07:11:24Z");
  assert.equal(routeCardProofLine(releasedRoute, now), null);
  assert.equal(routeCardProofLine(releasedRoute, now, { synthetic: true }), null);
});

test("the ended route card keeps unverified proof when cleanup is unconfirmed", () => {
  const now = Date.parse("2026-11-18T07:11:24Z");
  const route = { ...releasedRoute, cleanup: { state: "unconfirmed" } };
  assert.equal(routeCardProofLine(route, now), "Not confirmed yet · checked just now");
});

test("the one lifetime is the server's expiry, formatted local; nothing is computed from a label", () => {
  const session = { ...staleRoute, handle: { kind: "session" }, expiresAt: { known: true as const, value: "2026-11-18T15:05:00Z" } };
  assert.equal(expiryLine(session, utc), "Turns off at 3:05 PM");
  assert.equal(expiryLine({ ...session, expiresAt: { known: true, value: "2026-11-19T15:05:00Z" } }, utc), "Turns off at Nov 19, 3:05 PM");
  // Unknown expiry: a session says it is temporary and gives no number; a lasting route says nothing.
  const unknown = { ...session, expiresAt: { known: false as const, reason: "not-observed" } };
  assert.equal(expiryLine(unknown), "Temporary address; it may turn off or change");
  assert.equal(expiryLine({ ...unknown, handle: { kind: "external" } }), null);
  assert.doesNotMatch(String(expiryLine(unknown)), /\d/);
});

test("a route that ended at its expiry says when", () => {
  const ended = { ...releasedRoute, expiresAt: { known: true as const, value: "2026-11-18T15:05:00Z" } };
  assert.equal(routeSentence(ended, "Off", { ...utc, now: Date.parse("2026-11-18T16:00:00Z") }), "Your address turned off at 3:05 PM.");
  assert.equal(routeSentence(ended, "Off", { ...utc, now: Date.parse("2026-11-18T14:00:00Z") }), "Your address no longer works.");
});

test("the re-check delay comes from the window length the server reports, never from a clock comparison", () => {
  // Window 07:08:13.767 to 07:08:43.767 is 30 s: a third is 10 s.
  assert.equal(recheckDelay(staleRoute, "verified"), 20_000);
  const longWindow = { ...staleRoute, verification: { ...staleRoute.verification, observedAt: "2026-11-18T07:00:00Z", validUntil: { known: true as const, value: "2026-11-18T08:00:00Z" } } };
  assert.equal(recheckDelay(longWindow, "verified"), 3_540_000, "the margin is capped at a minute");
  const shortWindow = { ...staleRoute, verification: { ...staleRoute.verification, observedAt: "2026-11-18T07:00:00Z", validUntil: { known: true as const, value: "2026-11-18T07:00:01Z" } } };
  assert.equal(recheckDelay(shortWindow, "verified"), 2_000, "one-second windows cannot spin");
  assert.equal(recheckDelay(staleRoute, "stale"), 2_000, "stale reports also have a minimum positive delay");
  const noWindow = { ...staleRoute, verification: { ...staleRoute.verification, validUntil: { known: false as const, reason: "x" } } };
  assert.equal(recheckDelay(noWindow, "verified"), null);
});

test("a whole-scan failure warns even when no record count is reported", () => {
  assert.equal(journalUnreadableWarning(0, "ok"), null);
  assert.equal(
    journalUnreadableWarning(0, "unavailable"),
    "Remote-access records could not be read after a restart. An earlier address may still work; check your provider."
  );
});

test("an unreadable startup journal warns only when the host reports unreadable records", () => {
  assert.equal(journalUnreadableWarning(), null);
  assert.equal(journalUnreadableWarning(0), null);
  assert.equal(
    journalUnreadableWarning(2),
    "Some remote-access records could not be read after a restart. An earlier address may still work; check your provider."
  );
});

const base = { lifecycleReason: null, recheckFailed: false, acknowledged: false, now: Date.parse("2026-11-18T07:08:30Z"), lifecyclePhase: "verified", recheckUnderWay: false };
test("a lost route, a failed re-check and an unrenewed stale proof need the owner, with one sentence each", () => {
  assert.equal(routeAttention(staleRoute, { ...base, lifecycleReason: "agent-exited" }), "lost");
  assert.equal(routeAttention({ ...staleRoute, state: "lost" }, base), "lost");
  assert.equal(routeAttention(staleRoute, { ...base, recheckFailed: true }), "recheck-failed");
  assert.equal(routeAttention(staleRoute, { ...base, lifecyclePhase: "stale" }), "recheck-failed");
  assert.equal(routeAttention(staleRoute, { ...base, lifecyclePhase: "stale", recheckUnderWay: true }), null, "a re-check under way is not a failure");
  assert.equal(routeAttention(staleRoute, base), null);
  assert.equal(routeAttention(staleRoute, { ...base, lifecycleReason: "agent-exited", acknowledged: true }), null);
  assert.equal(routeHeadline(staleRoute, "verified", false, "lost"), "Needs your action");
  assert.match(attentionSentence("lost", staleRoute, "Tunnel service"), /^Your address stopped working\. Tunnel service closed the connection\. Turn it on again/);
  assert.match(attentionSentence("recheck-failed", staleRoute, "Tunnel service"), /^We can't confirm the address still works\. Turn it on again/);
});

test("a route the host could not confirm closed needs the owner and offers Turn off, not Turning off", () => {
  const unconfirmed: RouteDisplayInput = { ...staleRoute, cleanup: { state: "unconfirmed" } };
  const stopping = { ...base, lifecyclePhase: "stopping" };
  assert.equal(routeHeadline(unconfirmed, "stopping", false), "Turning off", "without the host's report the phase alone reads as under way");
  assert.equal(routeAttention(unconfirmed, { ...stopping, cleanupUnconfirmed: true }), "cleanup-unconfirmed");
  assert.equal(routeHeadline(unconfirmed, "stopping", false, "cleanup-unconfirmed"), "Needs your action");
  assert.equal(routeAttention(unconfirmed, stopping), null, "a stop still under way is not attention");
  assert.equal(routeAttention({ ...unconfirmed, cleanup: { state: "confirmed" } }, { ...stopping, cleanupUnconfirmed: true }), null);
  assert.equal(
    routeAttention(unconfirmed, { ...stopping, cleanupUnconfirmed: true, acknowledged: true }),
    "cleanup-unconfirmed",
    "the owner's own Turn off acknowledges the route; an unconfirmed close must still show"
  );
  for (const state of ["released", "usable"]) {
    const route = { ...unconfirmed, state };
    assert.equal(routeAttention(route, { ...base, cleanupUnconfirmed: true, acknowledged: true }), "cleanup-unconfirmed", state);
    assert.equal(
      routeAttention({ ...route, cleanup: { state: "confirmed" } }, { ...base, cleanupUnconfirmed: true, acknowledged: true }),
      null,
      `${state}: a confirmed close needs nothing`
    );
  }
  assert.match(attentionSentence("cleanup-unconfirmed", unconfirmed, "Tunnel service"), /^We couldn't confirm your address closed\. It may still work\. Turn it off/);
});

test("an address past its end time with a proof no longer verified needs the owner; a skewed clock alone does not", () => {
  const ended = { ...staleRoute, expiresAt: { known: true as const, value: "2026-11-18T07:08:00Z" } };
  const unverified = { ...ended, verification: { ...ended.verification, status: "unverified" } };
  assert.equal(routeAttention(unverified, base), "expired");
  assert.equal(routeAttention(ended, base), null);
  assert.match(attentionSentence("expired", unverified, "Tunnel service", utc), /^Your address turned off at 7:08 AM\./);
});

test("a released route with confirmed cleanup reads Off, not unknown", () => {
  assert.equal(routeHeadline(releasedRoute, "unknown", false), "Off");
  assert.equal(routeSentence(releasedRoute, "Off"), "Your address no longer works.");
});

test("unconfirmed cleanup on an ended route does not depend on a matching lifecycle", () => {
  for (const routeState of ["released", "inactive", "stopped"]) {
    const route: RouteDisplayInput = {
      ...releasedRoute, routeState, cleanup: { state: "unconfirmed" },
      verification: { ...releasedRoute.verification, status: "verified" },
    };
    const headline = routeHeadline(route, null, false);
    assert.equal(headline, "Needs your action");
    assert.equal(routeSentence(route, headline), "We couldn't confirm your address closed. It may still work.");
    assert.match(routeSentence(route, "Off") ?? "", /couldn't confirm/);
  }
});

test("released without confirmed cleanup keeps the lifecycle meaning; nothing is invented", () => {
  const unconfirmed = { ...releasedRoute, cleanup: { state: "unconfirmed" } };
  assert.equal(routeHeadline(unconfirmed, "stopping", false), "Turning off");
  assert.equal(routeHeadline({ ...staleRoute, state: "usable" }, "verified", false), "On");
  assert.equal(routeHeadline(staleRoute, null, false), "On");
  assert.equal(routeHeadline(staleRoute, "stale", true), "Needs your action");
  assert.equal(routeHeadline(staleRoute, "no-such-phase", false), "Needs your action");
});

// Real shape: after the tunnel process was killed the host reported the route released and inactive
// with cleanup confirmed, and no stop the owner asked for.
test("a route whose tunnel died shows Needs your action with Turn on again, never Off", () => {
  const attention = routeAttention(diedRoute, { ...base, lifecyclePhase: "inactive" });
  assert.equal(attention, "lost");
  assert.equal(routeHeadline(diedRoute, "inactive", false, attention), "Needs your action");
  assert.match(attentionSentence("lost", diedRoute, "Temporary address"), /stopped working/);
});

test("an owner's confirmed stop is Off, and a route with no stop information is not guessed at", () => {
  const stopped = { ...diedRoute, stopRequested: true };
  assert.equal(routeAttention(stopped, { ...base, lifecyclePhase: "stopped" }), null);
  assert.equal(routeHeadline(stopped, "stopped", false, null), "Off");
  const { stopRequested: _unknown, ...unknown } = diedRoute;
  assert.equal(routeAttention(unknown, { ...base, lifecyclePhase: "inactive" }), null);
});

test("a session that ran out with no owner stop says when it turned off", () => {
  const ranOut = { ...diedRoute, expiresAt: { known: true as const, value: "2026-11-18T07:00:00Z" } };
  assert.equal(routeAttention(ranOut, { ...base, lifecyclePhase: "inactive" }), "expired");
});

test("turning on and off twice lists one Off entry, the latest stop", () => {
  const off = (id: string) => ({ state: "released", cleanup: { state: "confirmed" }, stopRequested: true, handle: { id } });
  const routes = [off("first"), off("second")];
  assert.deepEqual(listedRoutes(routes, ["first", "second"]).map((route) => route.handle.id), ["second"]);
  assert.deepEqual(listedRoutes(routes, ["second", "first"]).map((route) => route.handle.id), ["first"]);
  assert.deepEqual(listedRoutes(routes, []), [], "a reload, which saw no stop, lists none");
  const on = { state: "usable", cleanup: { state: "none" }, handle: { id: "live" } };
  assert.deepEqual(listedRoutes([...routes, on], ["first", "second"]).map((route) => route.handle.id), ["live"], "a live route hides the history");
  const died = { state: "released", cleanup: { state: "confirmed" }, stopRequested: false, handle: { id: "died" } };
  assert.deepEqual(listedRoutes([died, off("first")], ["first"]).map((route) => route.handle.id), ["died", "first"], "an end the owner did not ask for stays");
});

test("settled temporary route history shows one quiet session even without an owner stop", () => {
  const endedRoute = (id: string) => ({ state: "released", cleanup: { state: "confirmed" }, stopRequested: false, handle: { id, kind: "session" }, providerId: "tunnel" });
  const old = endedRoute("old");
  const latest = endedRoute("latest");
  const cleanup = { ...endedRoute("cleanup"), cleanup: { state: "unconfirmed" }, handle: { id: "cleanup", kind: "external" } };
  const routeIds = (routes: readonly typeof old[]) => routes.map((route) => route.handle.id);
  assert.deepEqual(routeIds(listedRoutes([old, latest], [])), ["latest"]);
  assert.deepEqual(routeIds(listedRoutes([old, latest, cleanup], [], (route) => route.handle.id === "old")), ["old", "cleanup"]);
});

test("server presentation controls On even when the raw route and lifecycle say verified", () => {
  const route: RouteDisplayInput = { ...staleRoute, presentation: { label: "Unpublished", actions: [], reason: null } };
  assert.equal(routeHeadline(route, "verified", false), "Needs your action");
  assert.match(proofLine(route, Date.now()), /Not confirmed yet/);
  assert.equal(routeHeadline({ ...route, presentation: { label: "Verified", actions: [], reason: null } }, "verified", false), "On");
});
