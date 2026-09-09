// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression test for the two surfaces disagreeing about a dead collector.
 *
 * The console shows a local device source in two places. The sources list shows
 * a card with a coloured pill derived from the connector's rendered verdict; the
 * source detail page shows a heartbeat line derived from `heartbeat_health`. For
 * eleven days both were rendered from the same dead heartbeat and said opposite
 * things — the card said "Healthy" in green while the detail line, one click
 * away, said the check-in was stale. Two surfaces contradicting each other is
 * worse than one missing surface: a reader who sees the green card never clicks
 * through, and a reader who does now has to decide which one is lying.
 *
 * The two derivations are independent by construction and stay in agreement only
 * because two constants happen to be equal: `HEARTBEAT_LEASE_MS`
 * (`server/heartbeat-lease.ts`), which the detail line uses, and
 * `OUTBOX_STALE_HEARTBEAT_THRESHOLD_MS`, which the card's outbox axis uses.
 * Nothing in the code forces those to match — only a comment asks. So this test
 * drives BOTH derivations from ONE heartbeat fixture and asserts they reach the
 * same verdict, including at the exact boundary where a one-constant drift would
 * first show up.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { HeartbeatOutboxEvidence } from "../runtime/connection-health.ts";
import { deriveOutboxAxisFromHeartbeat } from "../runtime/connection-health.ts";
import { synthesizeConnectorVerdict } from "../runtime/connector-verdict-input.ts";
import { OUTBOX_STALE_HEARTBEAT_THRESHOLD_MS } from "../server/connector-outbox-axis.ts";
import { HEARTBEAT_LEASE_MS, presentHeartbeatHealth } from "../server/heartbeat-lease.ts";
import { projectConnectorSummaryConnectionHealth } from "../server/ref-control.ts";

const NOW = "2026-05-19T12:00:00.000Z";
const NOW_MS = Date.parse(NOW);

/** A heartbeat that landed exactly `ageMs` before NOW. */
function heartbeatAt(ageMs: number): string {
  return new Date(NOW_MS - ageMs).toISOString();
}

/**
 * The one shared fixture. Every assertion below is a projection of this and
 * nothing else — if the test set the card's input and the line's input
 * separately it would be asserting its own arithmetic, not the product's.
 */
function scenario({ ageMs, lastHeartbeatStatus }: { ageMs: number; lastHeartbeatStatus: string }) {
  const lastHeartbeatAt = heartbeatAt(ageMs);

  const detail = presentHeartbeatHealth({ lastHeartbeatAt, lastHeartbeatStatus, nowIso: NOW });

  const evidence: HeartbeatOutboxEvidence = {
    evidenceTrusted: true,
    lastHeartbeatAt,
    lastHeartbeatStatus: lastHeartbeatStatus as HeartbeatOutboxEvidence["lastHeartbeatStatus"],
    recordsPending: 0,
  };
  const outbox = deriveOutboxAxisFromHeartbeat(evidence, {
    nowIso: NOW,
    staleHeartbeatThresholdMs: OUTBOX_STALE_HEARTBEAT_THRESHOLD_MS,
  });
  const snapshot = projectConnectorSummaryConnectionHealth({
    freshness: { status: "current" },
    lastRun: null,
    lastSuccessfulRun: null,
    localCoverage: null,
    localDeviceBacked: true,
    manifestStreams: [{ name: "messages" }],
    nowIso: NOW,
    outbox: { axis: outbox.axis, cause: outbox.cause },
    pendingDetailGaps: [],
    schedule: null,
  });
  const verdict = synthesizeConnectorVerdict({
    manifestStreams: [{ name: "messages" }],
    progress: null,
    refresh: null,
    report: [],
    snapshot,
  });

  return { card: verdict.pill, detail, outbox };
}

/**
 * The live-collector statuses whose staleness must age out. A collector reports
 * one of these and then dies; nothing rewrites the column, so the status alone
 * can never reveal the death and only the age can.
 */
const AGING_STATUSES = ["healthy", "stopped", "starting", "retrying"];

for (const lastHeartbeatStatus of AGING_STATUSES) {
  test(`card and detail agree that a "${lastHeartbeatStatus}" collector past the lease is not healthy`, () => {
    const { card, detail, outbox } = scenario({ ageMs: HEARTBEAT_LEASE_MS + 60_000, lastHeartbeatStatus });

    assert.equal(detail.status, "stale", "the detail line ages the check-in out");
    assert.equal(outbox.axis, "stalled", "the card's outbox axis ages the same check-in out");
    assert.equal(outbox.cause, "stale_heartbeat");
    assert.notEqual(card.tone, "green", "the card must not stay green while the detail line says stale");
    assert.notEqual(card.label, "Healthy");
  });

  test(`card and detail agree that a "${lastHeartbeatStatus}" collector inside the lease is still current`, () => {
    const { card, detail, outbox } = scenario({ ageMs: 60_000, lastHeartbeatStatus });

    assert.notEqual(detail.status, "stale", "a recent check-in is not stale");
    assert.notEqual(outbox.cause, "stale_heartbeat", "and the card must not claim it is");
    // The fixture carries no run or report evidence, so the card settles on the
    // unmeasured tone rather than a healthy one. That is the coverage axis
    // speaking, not the heartbeat, and asserting `green` here would make this
    // test fail for a reason it is not about. What must hold is the narrower
    // claim: the heartbeat has not driven the card to the tone it reserves for
    // a collector that cannot collect.
    assert.notEqual(card.tone, "red", "a live collector must not read as unable to collect");
  });
}

test("the two surfaces flip on the same instant, so neither can drift ahead of the other", () => {
  // Both derivations use a strict `>` against their own threshold, so the exact
  // lease instant is still fresh and one millisecond past it is stale. If the
  // two constants ever diverge, this is the first assertion that fails: a
  // one-millisecond window is wide enough to catch any real difference and
  // narrow enough that no other condition can explain the disagreement.
  const atBoundary = scenario({ ageMs: HEARTBEAT_LEASE_MS, lastHeartbeatStatus: "healthy" });
  assert.notEqual(atBoundary.detail.status, "stale");
  assert.notEqual(atBoundary.outbox.cause, "stale_heartbeat");
  assert.notEqual(atBoundary.card.tone, "red");

  const pastBoundary = scenario({ ageMs: HEARTBEAT_LEASE_MS + 1, lastHeartbeatStatus: "healthy" });
  assert.equal(pastBoundary.detail.status, "stale");
  assert.equal(pastBoundary.outbox.cause, "stale_heartbeat");
  assert.equal(pastBoundary.card.tone, "red", "one millisecond past the lease the card turns");
});

test("the lease the detail line applies is the threshold the card's outbox axis applies", () => {
  // The agreement above holds only while these two are equal. Asserting it
  // directly names the coupling, so a future edit to either constant fails here
  // with an obvious cause rather than in a scenario test with an obscure one.
  assert.equal(
    HEARTBEAT_LEASE_MS,
    OUTBOX_STALE_HEARTBEAT_THRESHOLD_MS,
    "the presented lease and the outbox stale threshold must stay equal or the two surfaces diverge"
  );
});
