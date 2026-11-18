// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { test } from "node:test";
import { proofLine, routeHeadline, routeSentence, type RouteDisplayInput } from "./route-display.ts";

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

test("the proof line says when it was checked in local time and when its window has ended", () => {
  const line = proofLine(staleRoute, Date.parse("2026-11-18T07:08:43.857Z"), utc);
  assert.match(line, /^Works from the internet · checked 7:08.AM/);
  assert.match(line, /check expired/);
  assert.doesNotMatch(line, /\d{4}-\d{2}-\d{2}T/);
  assert.equal(routeHeadline(staleRoute, "stale", false), "Needs your action");
});

test("a proof inside its window is not called expired, and an unknown window claims nothing", () => {
  assert.doesNotMatch(proofLine(staleRoute, Date.parse("2026-11-18T07:08:20Z"), utc), /expired/);
  const unknownWindow = { ...staleRoute, verification: { ...staleRoute.verification, validUntil: { known: false as const, reason: "x" } } };
  assert.doesNotMatch(proofLine(unknownWindow, Date.now(), utc), /expired/);
});

test("an unverified route is not called working; test data is labelled", () => {
  assert.match(proofLine(releasedRoute, Date.now(), utc), /^Not confirmed yet · checked 7:11.AM/);
  assert.match(proofLine(staleRoute, 0, { ...utc, synthetic: true }), /^Test data: Works from the internet/);
});

test("a released route with confirmed cleanup reads Off, not unknown", () => {
  assert.equal(routeHeadline(releasedRoute, "unknown", false), "Off");
  assert.equal(routeSentence(releasedRoute, "Off"), "Your address no longer works.");
});

test("released without confirmed cleanup keeps the lifecycle meaning; nothing is invented", () => {
  const unconfirmed = { ...releasedRoute, cleanup: { state: "unconfirmed" } };
  assert.equal(routeHeadline(unconfirmed, "stopping", false), "Turning off");
  assert.equal(routeHeadline({ ...staleRoute, state: "usable" }, "verified", false), "On");
  assert.equal(routeHeadline(staleRoute, null, false), "On");
  assert.equal(routeHeadline(staleRoute, "stale", true), "Needs your action");
  assert.equal(routeHeadline(staleRoute, "no-such-phase", false), "Needs your action");
});
