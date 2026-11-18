// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { test } from "node:test";
import { proofLine, routeHeadline, type RouteDisplayInput } from "./route-display.ts";

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

test("the stale header is explained: the verified proof's window has ended", () => {
  const line = proofLine(staleRoute, "Proof", Date.parse("2026-11-18T07:08:43.857Z"));
  assert.match(line, /^Proof: verified · public · 2026-11-18T07:08:13.767Z/);
  assert.match(line, /proof window ended 2026-11-18T07:08:43.767Z/);
  assert.equal(routeHeadline(staleRoute, "stale", false), "stale");
});

test("a proof inside its window is not called ended, and an unknown window claims nothing", () => {
  assert.doesNotMatch(proofLine(staleRoute, "Proof", Date.parse("2026-11-18T07:08:20Z")), /ended/);
  const unknownWindow = { ...staleRoute, verification: { ...staleRoute.verification, validUntil: { known: false as const, reason: "x" } } };
  assert.doesNotMatch(proofLine(unknownWindow, "Proof", Date.now()), /ended/);
});

test("a released route with confirmed cleanup reads Released, not unknown", () => {
  assert.equal(routeHeadline(releasedRoute, "unknown", false), "Released");
});

test("released without confirmed cleanup keeps the lifecycle label; nothing is invented", () => {
  const unconfirmed = { ...releasedRoute, cleanup: { state: "unconfirmed" } };
  assert.equal(routeHeadline(unconfirmed, "stopping", false), "stopping");
  assert.equal(routeHeadline({ ...staleRoute, state: "usable" }, "verified", false), "verified");
  assert.equal(routeHeadline(staleRoute, null, false), "verified");
  assert.equal(routeHeadline(staleRoute, "stale", true), "Unpublished");
});
