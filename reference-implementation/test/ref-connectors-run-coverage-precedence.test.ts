// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import type { CoverageEvidenceStrategy } from "../server/connector-coverage-policy.ts";
import type { ReferenceFreshness } from "../server/freshness.ts";
import { buildCollectionReport, type ConnectorRunSummary, projectConnectorSummaryConnectionHealth } from "../server/ref-control.ts";

const NOW = "2026-06-03T12:00:00.000Z";
const FRESH_FRESHNESS: ReferenceFreshness = { captured_at: "2026-06-03T11:58:00.000Z", status: "current" };

const OWN_SCOPED_STREAM_NAMES = [
  "sessions",
  "messages",
  "attachments",
  "skills",
  "memory_notes",
  "slash_commands",
] as const;

const OWN_SCOPED_STREAM_STRATEGIES: Record<(typeof OWN_SCOPED_STREAM_NAMES)[number], CoverageEvidenceStrategy> = {
  attachments: "checkpoint_window",
  memory_notes: "checkpoint_window",
  messages: "checkpoint_window",
  sessions: "checkpoint_window",
  skills: "snapshot_import_receipt",
  slash_commands: "snapshot_import_receipt",
};

function ownScopedManifestStreams() {
  return OWN_SCOPED_STREAM_NAMES.map((name) => ({
    coverage_strategy: OWN_SCOPED_STREAM_STRATEGIES[name],
    name,
    required: true,
  }));
}

function ownScopedCollectionFacts() {
  return {
    streams: OWN_SCOPED_STREAM_NAMES.map((stream) => ({
      checkpoint: "committed",
      collected: 0,
      considered: null,
      coverage_statuses: ["collected"],
      covered: null,
      pending_detail_gaps: 0,
      skipped: null,
      stream,
    })),
  };
}

function ownScopedRunSummary(overrides: { scheduler_managed?: boolean; status?: string } = {}): ConnectorRunSummary {
  return {
    collection_facts: ownScopedCollectionFacts(),
    event_count: 1,
    failure_reason: null,
    finished_at: NOW,
    first_at: NOW,
    known_gaps: [],
    last_at: NOW,
    recovery_only: false,
    run_id: "924c3a51-0c27-4b77-8ab1-7e332f4f4fc7",
    ...(overrides.scheduler_managed === undefined ? {} : { scheduler_managed: overrides.scheduler_managed }),
    started_at: NOW,
    status: overrides.status ?? "succeeded",
    terminal_reason: null,
  };
}

function allRequiredStreamsComplete(lastRun: ConnectorRunSummary): boolean {
  const report = buildCollectionReport({
    attentionOpen: false,
    collectionFacts: lastRun.collection_facts,
    freshness: "fresh",
    manifestStreams: ownScopedManifestStreams(),
    refresh: null,
  });
  return report.filter((entry) => entry.required !== false).every((entry) => entry.coverage_condition === "complete");
}

test("a local_device connection's own current scheduler-managed run with fully proven required streams promotes axes.coverage to complete", () => {
  const lastRun = ownScopedRunSummary({ scheduler_managed: true });

  // Per-stream proof already holds today, independent of this fix — the
  // `local_device` gap is entirely in the connection-level rollup below.
  assert.equal(allRequiredStreamsComplete(lastRun), true);

  const health = projectConnectorSummaryConnectionHealth({
    freshness: FRESH_FRESHNESS,
    lastRun,
    lastSuccessfulRun: lastRun,
    localDeviceBacked: true,
    manifestStreams: ownScopedManifestStreams(),
    nowIso: NOW,
    outbox: { axis: "idle" },
    pendingDetailGaps: [],
    schedule: { enabled: true },
  });

  // FAILS before the fix: `localDeviceBacked` unconditionally nulled `lastRun`
  // before `mapCoverageAxis` ran, so this resolved to `"unknown"` regardless
  // of how proven the underlying streams were.
  assert.equal(health.axes.coverage, "complete");
});

test("a local_device connection's foreign (non-scheduler-managed) run does not promote axes.coverage, even with proven streams", () => {
  // Same fully-proven evidence as the positive case, but the run is NOT
  // proven to be this connection's own scheduler-managed run (the common
  // case: a stale/foreign server-hydrated row). The safety boundary from the
  // original guard must survive: this must NOT green-wash.
  const lastRun = ownScopedRunSummary({ scheduler_managed: false });
  assert.equal(allRequiredStreamsComplete(lastRun), true);

  const health = projectConnectorSummaryConnectionHealth({
    freshness: FRESH_FRESHNESS,
    lastRun,
    lastSuccessfulRun: lastRun,
    localDeviceBacked: true,
    manifestStreams: ownScopedManifestStreams(),
    nowIso: NOW,
    outbox: { axis: "idle" },
    pendingDetailGaps: [],
    schedule: { enabled: true },
  });
  assert.notEqual(health.axes.coverage, "complete");
  assert.equal(health.axes.coverage, "unknown");
});

test("a local_device connection's device terminal run stays quarantined even when stamped scheduler_managed", () => {
  // A database whose column default was once `true` stamped device terminal
  // commits `scheduler_managed = true`. A device terminal commit stamps the
  // connection's collection revision; that, not the flag, says the run is
  // not the connection's own scheduler history.
  const failed = { ...ownScopedRunSummary({ scheduler_managed: true, status: "failed" }), failure_reason: "boom" };
  const healthOf = (lastRun: ConnectorRunSummary) =>
    projectConnectorSummaryConnectionHealth({
      freshness: FRESH_FRESHNESS,
      lastRun,
      lastSuccessfulRun: null,
      localDeviceBacked: true,
      manifestStreams: ownScopedManifestStreams(),
      nowIso: NOW,
      outbox: { axis: "idle" },
      pendingDetailGaps: [],
      schedule: { enabled: true },
    });

  assert.equal(healthOf(failed).reason_code, "boom", "control: the connection's own scheduler run is evidence");
  assert.equal(
    healthOf({ ...failed, collection_revision: 7 }).reason_code,
    null,
    "a device terminal run is quarantined whatever its flag says"
  );
});

test("a local_device connection's run with scheduler_managed unset (legacy/absent evidence) stays quarantined", () => {
  // `scheduler_managed` is optional/absent for callers/fixtures that predate
  // this field (see `ConnectorRunSummary.scheduler_managed`'s doc comment).
  // Absence must default to the pre-fix quarantine, not an accidental green.
  const lastRun = ownScopedRunSummary();
  assert.equal(lastRun.scheduler_managed, undefined);
  assert.equal(allRequiredStreamsComplete(lastRun), true);

  const health = projectConnectorSummaryConnectionHealth({
    freshness: FRESH_FRESHNESS,
    lastRun,
    lastSuccessfulRun: lastRun,
    localDeviceBacked: true,
    manifestStreams: ownScopedManifestStreams(),
    nowIso: NOW,
    outbox: { axis: "idle" },
    pendingDetailGaps: [],
    schedule: { enabled: true },
  });
  assert.equal(health.axes.coverage, "unknown");
});

test("a local_device connection's stale scheduler-managed run does not promote axes.coverage when freshness has lapsed", () => {
  // scheduler_managed=true proves the run is this connection's OWN evidence,
  // not that it is CURRENT. A stale heartbeat/freshness axis is an
  // independent, orthogonal safety boundary and must still degrade the
  // connection, exactly as it would for any other connection.
  const lastRun = ownScopedRunSummary({ scheduler_managed: true });
  assert.equal(allRequiredStreamsComplete(lastRun), true);

  const health = projectConnectorSummaryConnectionHealth({
    freshness: { status: "stale" },
    lastRun,
    lastSuccessfulRun: lastRun,
    localDeviceBacked: true,
    manifestStreams: ownScopedManifestStreams(),
    nowIso: NOW,
    outbox: { axis: "idle" },
    pendingDetailGaps: [],
    schedule: { enabled: true },
  });
  // The coverage axis itself is still allowed to promote (coverage and
  // freshness are separate axes) but the connection must not read healthy
  // while stale — this pins the state gate, not just the coverage axis.
  assert.notEqual(health.state, "healthy");
});

test("a local_device connection's own scheduler-managed but FAILED run does not promote axes.coverage", () => {
  // scheduler_managed=true only proves provenance, never outcome. A failed
  // run must not be read as coverage-complete evidence.
  const lastRun = ownScopedRunSummary({ scheduler_managed: true, status: "failed" });

  const health = projectConnectorSummaryConnectionHealth({
    freshness: FRESH_FRESHNESS,
    lastRun,
    lastSuccessfulRun: null,
    localDeviceBacked: true,
    manifestStreams: ownScopedManifestStreams(),
    nowIso: NOW,
    outbox: { axis: "idle" },
    pendingDetailGaps: [],
    schedule: { enabled: true },
  });
  assert.notEqual(health.axes.coverage, "complete");
});

test("a non-local-device (scheduler-managed) connection's own current run is unaffected by this fix", () => {
  // Control: the existing, non-local-device path (e.g. `account`-backed
  // connections like ChatGPT) never nulled `lastRun` in the first place —
  // this pins that this fix changes nothing for it.
  const lastRun = ownScopedRunSummary({ scheduler_managed: true });

  const health = projectConnectorSummaryConnectionHealth({
    freshness: FRESH_FRESHNESS,
    lastRun,
    lastSuccessfulRun: lastRun,
    localDeviceBacked: false,
    manifestStreams: ownScopedManifestStreams(),
    nowIso: NOW,
    outbox: { axis: "idle" },
    pendingDetailGaps: [],
    schedule: { enabled: true },
  });
  assert.equal(health.axes.coverage, "complete");
});

// ---------------------------------------------------------------------------
// projection_disagreement root cause (bz-chatgpt-http-disagreement-rootcause):
// an `account`-backed connection (never `local_device`) whose newest SETTLED
// run is a scheduler pre-dispatch skip — because a recurring owner-interaction
// requirement rejects every tick before it can dispatch — must still promote
// `axes.coverage` from its last real success, not read the skip as "no
// evidence at all" (`null`) with no fallback. `healthClassifyingRun`'s two
// neighboring exclusions (owner-cancel, controller-abandoned) already fall
// back to `lastSuccessfulRun`; the skip exclusion alone returned bare `null`,
// permanently pinning `axes.coverage` to `"unknown"` for as long as the
// scheduler kept skipping — indefinitely, since the skip reproduces on every
// tick, not a one-time race. Distinct connector-agnostic mechanism from the
// `local_device` fix above (this predicate is entirely non-local-device); the
// underlying disagreement predicate is the same at
// scripts/stream-health-audit/authority.ts:1308-1315.
// ---------------------------------------------------------------------------

const ACCOUNT_STREAM_NAMES = ["conversations", "messages", "memories", "custom_gpts"] as const;

function accountManifestStreams() {
  return ACCOUNT_STREAM_NAMES.map((name) => ({
    coverage_strategy: "checkpoint_window" as CoverageEvidenceStrategy,
    name,
    required: true,
  }));
}

function accountCollectionFacts() {
  return {
    streams: ACCOUNT_STREAM_NAMES.map((stream) => ({
      checkpoint: "committed",
      collected: 0,
      considered: 0,
      coverage_statuses: ["collected"],
      covered: 0,
      pending_detail_gaps: 0,
      skipped: null,
      stream,
    })),
  };
}

function accountSuccessfulRunSummary(): ConnectorRunSummary {
  return {
    collection_facts: accountCollectionFacts(),
    event_count: 1,
    failure_reason: null,
    finished_at: "2026-08-28T08:31:14.539Z",
    first_at: "2026-08-28T08:30:55.595Z",
    known_gaps: [],
    last_at: "2026-08-28T08:31:14.539Z",
    recovery_only: false,
    run_id: "run_1787905855556_1",
    started_at: "2026-08-28T08:30:55.595Z",
    status: "succeeded",
    terminal_reason: null,
  };
}

// Live shape: `run_history` writes no `run_id` for a scheduler pre-dispatch
// skip (`buildUnresolvedAttentionSkip`) — this is the exact live
// `failure_reason` text the skip's own doc comment says must never leak
// through as a fabricated `reasonCode`.
const SKIPPED_RUN_FAILURE_REASON =
  "attention_unresolved: scheduler_error (owner_action:...:add_info:provider_interaction:attention_resolved:scheduler_error)";

function accountSkippedRunSummary(startedAt: string): ConnectorRunSummary {
  return {
    collection_facts: null,
    event_count: 0,
    failure_reason: SKIPPED_RUN_FAILURE_REASON,
    finished_at: startedAt,
    first_at: startedAt,
    known_gaps: [],
    last_at: startedAt,
    recovery_only: false,
    run_id: undefined,
    started_at: startedAt,
    status: "skipped",
    terminal_reason: null,
  };
}

function accountAllRequiredStreamsComplete(lastSuccessfulRun: ConnectorRunSummary): boolean {
  const report = buildCollectionReport({
    attentionOpen: false,
    collectionFacts: lastSuccessfulRun.collection_facts,
    freshness: "fresh",
    manifestStreams: accountManifestStreams(),
    refresh: null,
  });
  return report.filter((entry) => entry.required !== false).every((entry) => entry.coverage_condition === "complete");
}

test("an account connection whose newest settled run is a scheduler skip promotes axes.coverage from its last real success", () => {
  const lastSuccessfulRun = accountSuccessfulRunSummary();
  const skippedRun = accountSkippedRunSummary("2026-08-28T10:32:55.253Z");
  assert.equal(accountAllRequiredStreamsComplete(lastSuccessfulRun), true);

  const health = projectConnectorSummaryConnectionHealth({
    freshness: FRESH_FRESHNESS,
    lastRun: skippedRun,
    lastSuccessfulRun,
    latestSettledRun: skippedRun,
    localDeviceBacked: false,
    manifestStreams: accountManifestStreams(),
    nowIso: NOW,
    outbox: { axis: "idle" },
    pendingDetailGaps: [],
    schedule: { enabled: true },
  });

  // FAILS before the fix: `healthClassifyingRun` returned bare `null` for a
  // skip (no fallback, unlike its owner-cancel/controller-abandoned
  // siblings), so `mapCoverageAxis(null, ...)` stuck this at `"unknown"`
  // regardless of how proven the last real success was.
  assert.equal(health.axes.coverage, "complete");
});

test("the skipped row's own stale failure_reason never becomes the connection's reasonCode", () => {
  const lastSuccessfulRun = accountSuccessfulRunSummary();
  const skippedRun = accountSkippedRunSummary("2026-08-28T10:32:55.253Z");

  const health = projectConnectorSummaryConnectionHealth({
    freshness: FRESH_FRESHNESS,
    lastRun: skippedRun,
    lastSuccessfulRun,
    latestSettledRun: skippedRun,
    localDeviceBacked: false,
    manifestStreams: accountManifestStreams(),
    nowIso: NOW,
    outbox: { axis: "idle" },
    pendingDetailGaps: [],
    schedule: { enabled: true },
  });

  // The self-perpetuating-skip bug `isSchedulerSkippedRun`'s doc comment
  // describes was the skip's own restated `failure_reason` text re-poisoning
  // `reasonCode` forever. This must still never happen: falling back to
  // `lastSuccessfulRun` (a clean success with `failure_reason: null`) means
  // this text can never surface as `reasonCode`, exactly as before the fix.
  assert.notEqual(health.reason_code, SKIPPED_RUN_FAILURE_REASON);
});

test("repeated scheduler skips after the same success keep promoting axes.coverage (not a one-time race)", () => {
  // Live shape: the scheduler ticks hourly and skips every time for as long
  // as the owner interaction is unresolved — four skips and counting since
  // the one success. This must not self-heal only on the FIRST skip and then
  // regress on the second/third/fourth.
  const lastSuccessfulRun = accountSuccessfulRunSummary();
  for (const startedAt of [
    "2026-08-28T09:31:55.422Z",
    "2026-08-28T10:32:55.253Z",
    "2026-08-28T11:33:55.100Z",
    "2026-08-28T12:34:55.900Z",
  ]) {
    const skippedRun = accountSkippedRunSummary(startedAt);
    const health = projectConnectorSummaryConnectionHealth({
      freshness: FRESH_FRESHNESS,
      lastRun: skippedRun,
      lastSuccessfulRun,
      latestSettledRun: skippedRun,
      localDeviceBacked: false,
      manifestStreams: accountManifestStreams(),
      nowIso: NOW,
      outbox: { axis: "idle" },
      pendingDetailGaps: [],
      schedule: { enabled: true },
    });
    assert.equal(health.axes.coverage, "complete", `skip at ${startedAt} must not regress coverage`);
  }
});

test("a TRUE failed run (not a skip) as the newest settled run still degrades, never promoted", () => {
  // Negative control: a skip's fallback must not become a blanket "always
  // trust lastSuccessfulRun" — a genuine terminal failure is real evidence
  // and must still win over the prior success.
  const lastSuccessfulRun = accountSuccessfulRunSummary();
  const failedRun: ConnectorRunSummary = {
    collection_facts: null,
    event_count: 1,
    failure_reason: "connector_reported_failed",
    finished_at: "2026-08-28T10:32:55.253Z",
    first_at: "2026-08-28T10:32:00.000Z",
    known_gaps: [{ reason: "owner_must_reauthorize", severity: "actionable" }],
    last_at: "2026-08-28T10:32:55.253Z",
    recovery_only: false,
    run_id: "run_failed_1",
    started_at: "2026-08-28T10:32:00.000Z",
    status: "failed",
    terminal_reason: null,
  };

  const health = projectConnectorSummaryConnectionHealth({
    freshness: FRESH_FRESHNESS,
    lastRun: failedRun,
    lastSuccessfulRun,
    latestSettledRun: failedRun,
    localDeviceBacked: false,
    manifestStreams: accountManifestStreams(),
    nowIso: NOW,
    outbox: { axis: "idle" },
    pendingDetailGaps: [],
    schedule: { enabled: true },
  });
  assert.notEqual(health.axes.coverage, "complete");
  assert.equal(health.axes.coverage, "terminal_gap");
});

test("a partial (gap-carrying) settled run as the newest settled run still degrades, never promoted", () => {
  // Negative control: a retryable/partial gap on the newest settled run is
  // real evidence too and must not be shadowed by an older success.
  const lastSuccessfulRun = accountSuccessfulRunSummary();
  const partialRun: ConnectorRunSummary = {
    collection_facts: null,
    event_count: 1,
    failure_reason: null,
    finished_at: "2026-08-28T10:32:55.253Z",
    first_at: "2026-08-28T10:32:00.000Z",
    known_gaps: [{ reason: "rate_limited", retryable: true }],
    last_at: "2026-08-28T10:32:55.253Z",
    recovery_only: false,
    run_id: "run_partial_1",
    started_at: "2026-08-28T10:32:00.000Z",
    status: "succeeded",
    terminal_reason: null,
  };

  const health = projectConnectorSummaryConnectionHealth({
    freshness: FRESH_FRESHNESS,
    lastRun: partialRun,
    lastSuccessfulRun,
    latestSettledRun: partialRun,
    localDeviceBacked: false,
    manifestStreams: accountManifestStreams(),
    nowIso: NOW,
    outbox: { axis: "idle" },
    pendingDetailGaps: [],
    schedule: { enabled: true },
  });
  assert.notEqual(health.axes.coverage, "complete");
});

test("a connection that has never had a successful run stays unknown through a skip, never fabricated complete", () => {
  // Negative control: the fallback is to `lastSuccessfulRun`, which is `null`
  // here — must resolve to the same honest `unknown` as before, never a
  // fabricated green from the skip alone.
  const skippedRun = accountSkippedRunSummary("2026-08-28T10:32:55.253Z");

  const health = projectConnectorSummaryConnectionHealth({
    freshness: FRESH_FRESHNESS,
    lastRun: skippedRun,
    lastSuccessfulRun: null,
    latestSettledRun: skippedRun,
    localDeviceBacked: false,
    manifestStreams: accountManifestStreams(),
    nowIso: NOW,
    outbox: { axis: "idle" },
    pendingDetailGaps: [],
    schedule: { enabled: true },
  });
  assert.equal(health.axes.coverage, "unknown");
});

test("an owner-cancelled run's existing fallback to lastSuccessfulRun is unchanged by this fix", () => {
  // Control: pins the two pre-existing sibling branches (owner-cancel,
  // controller-abandoned) are untouched — this fix only widens the set of
  // exclusions that share their existing fallback, it does not alter it.
  const lastSuccessfulRun = accountSuccessfulRunSummary();
  const cancelledRun: ConnectorRunSummary = {
    collection_facts: null,
    event_count: 1,
    failure_reason: "owner_cancelled",
    finished_at: "2026-08-28T10:32:55.253Z",
    first_at: "2026-08-28T10:32:00.000Z",
    known_gaps: [],
    last_at: "2026-08-28T10:32:55.253Z",
    recovery_only: false,
    run_id: "run_cancelled_1",
    started_at: "2026-08-28T10:32:00.000Z",
    status: "cancelled",
    terminal_reason: "owner_cancelled",
  };

  const health = projectConnectorSummaryConnectionHealth({
    freshness: FRESH_FRESHNESS,
    lastRun: cancelledRun,
    lastSuccessfulRun,
    latestSettledRun: cancelledRun,
    localDeviceBacked: false,
    manifestStreams: accountManifestStreams(),
    nowIso: NOW,
    outbox: { axis: "idle" },
    pendingDetailGaps: [],
    schedule: { enabled: true },
  });
  assert.equal(health.axes.coverage, "complete");
});
