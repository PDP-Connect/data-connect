// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * biome-ignore-all lint/performance/useTopLevelRegex: This copy-heavy test
 * suite uses local regex assertions intentionally.
 *
 * Unit tests for the connection-evidence formatters. These cover the
 * honest-by-default rules required by tasks 6.1 and 6.5: never render
 * `0` records when evidence failed, never label coverage `complete`
 * when the axis is `unknown`, and surface unreliable projection
 * evidence explicitly rather than silently.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { formatCoverageAxis, formatFreshnessAxis, formatOutboxAxis } from "@pdpp/display";
import { formatStreamCollectionFacts } from "./collection-report.ts";
import {
  deriveAutoPausedBanner,
  deriveFailureSummary,
  derivePrimaryRowAction,
  deriveStreakDots,
  formatCollectionRateReadout,
  formatDominantCondition,
  formatForwardDisposition,
  formatProjectionFreshness,
  formatSourceHeartbeat,
  formatSourceOutboxState,
  formatSupportingCondition,
  outboxAxisIsApplicable,
  resolveRecordCountDisplay,
  summarizeAxisChips,
  summarizeOutboxStallRemediation,
  summarizeSchedule,
  summarizeStreakDots,
  syncActionIdleLabel,
  syncStartFailureLead,
} from "./connection-evidence.ts";
import type {
  RefConnectionHealthCondition,
  RefConnectionHealthSnapshot,
  RefDetailGapBacklog,
  RefRenderedVerdict,
  RefSchedule,
} from "./ref-client.ts";
import type { ConnectorOverview } from "./rs-client.ts";

function backlog(overrides: Partial<RefDetailGapBacklog> = {}): RefDetailGapBacklog {
  return {
    max_attempt_count: 0,
    next_attempt_at: null,
    pending: 0,
    pending_is_floor: false,
    pending_other: 0,
    pending_other_is_floor: false,
    recovered: null,
    ...overrides,
  };
}

test("formatForwardDisposition renders checking coverage as neutral, not resumable", () => {
  const out = formatForwardDisposition("checking");
  assert.equal(out?.label, "checking coverage");
  assert.equal(out?.tone, "neutral");
  assert.equal(out?.ownerActionNeeded, false);
  assert.doesNotMatch(out?.title, /retry|resum/i);
});

test("formatForwardDisposition renders unmeasured coverage as resting missing evidence, not checking", () => {
  const out = formatForwardDisposition("unmeasured");
  assert.equal(out?.label, "not measured");
  assert.equal(out?.tone, "neutral");
  assert.equal(out?.ownerActionNeeded, false);
  assert.match(out?.title, /not an active checking state/i);
});

function snapshot(overrides: Partial<RefConnectionHealthSnapshot> = {}): RefConnectionHealthSnapshot {
  return {
    axes: { attention: "none", coverage: "complete", freshness: "fresh", outbox: "idle" },
    badges: { stale: false, syncing: false },
    conditions: [],
    dominant_condition_id: null,
    last_success_at: "2026-05-19T12:00:00Z",
    next_action: null,
    next_attempt_at: null,
    reason_code: null,
    state: "healthy",
    unknown_reasons: [],
    ...overrides,
  };
}

function baseOverview(overrides: Partial<ConnectorOverview> = {}): ConnectorOverview {
  return {
    connector: { connector_id: "demo", display_name: "Demo" },
    isRunning: false,
    lastRun: null,
    lastSuccessfulRun: null,
    streams: [],
    totalRecords: 0,
    ...overrides,
  };
}

test("coverage axis never labels 'unknown' as 'complete'", () => {
  assert.equal(formatCoverageAxis("unknown").tone, "neutral");
  // B2: the `unknown` axis renders as "not measured" — never as "complete",
  // and never as the bare word "unknown" that competed with the disposition
  // line's "not measured" for the same underlying state.
  assert.equal(formatCoverageAxis("unknown").value, "not measured");
  assert.equal(formatCoverageAxis("unknown").label.toLowerCase().includes("complete"), false);
  assert.equal(formatCoverageAxis("complete").tone, "success");
  assert.equal(formatCoverageAxis("gaps").tone, "warning");
  assert.equal(formatCoverageAxis("partial").tone, "warning");
});

test("coverage axis covers the full reference-server vocabulary", () => {
  assert.equal(formatCoverageAxis("retryable_gap").tone, "warning");
  assert.equal(formatCoverageAxis("terminal_gap").tone, "danger");
  for (const axis of ["deferred", "inventory_only", "unavailable", "unsupported"] as const) {
    const chip = formatCoverageAxis(axis);
    assert.equal(chip.tone, "neutral");
    assert.equal(chip.label.startsWith("Coverage"), true);
  }
});

const TERMINAL_GAP_JARGON_RE = /terminal gap/i;
const RECORDS_SAFE_RE = /stay valid|not current data loss/i;
const RECOVERY_POINTER_RE = /run|stream|recovery/i;
const RETRYABLE_REASSURANCE_RE = /later run|no owner action|stay valid/i;

test("terminal_gap copy reassures records are safe and points at a recovery step (report 3)", () => {
  // The owner reported "Coverage · terminal gap" was unclear: it did not say
  // what terminated, whether records are safe, or how to recover. The chip
  // value drops the jargon; the title carries the three required signals.
  const chip = formatCoverageAxis("terminal_gap");
  assert.equal(chip.tone, "danger");
  assert.doesNotMatch(chip.value, TERMINAL_GAP_JARGON_RE);
  // Records-safe reassurance (not current data loss).
  assert.match(chip.title, RECORDS_SAFE_RE);
  // A concrete recovery pointer (the latest run / affected streams).
  assert.match(chip.title, RECOVERY_POINTER_RE);
});

test("retryable_gap copy reassures no owner action is needed yet (report 3)", () => {
  const chip = formatCoverageAxis("retryable_gap");
  assert.equal(chip.tone, "warning");
  assert.match(chip.title, RETRYABLE_REASSURANCE_RE);
});

const FORWARD_LOOKING_COLLECTION_COPY = /will collect|coming soon|not yet|owed later|\byet\b/i;
const SETTLED_ACCEPTED_ABSENCE_COPY = /settled|accepted|declares|out of scope/i;
const CONNECTOR_OR_STREAM_NAME_COPY = /\bgmail\b|\bchatgpt\b|\bslack\b|\bchase\b|\bamazon\b|\busaa\b/i;

test("accepted-absence coverage copy reads as settled, not queued (connector-neutral)", () => {
  // The manifest-declared accepted-absence policies (deferred / inventory_only /
  // unavailable / unsupported) are a settled, non-degrading verdict — never a
  // promise of future collection. "defers ... yet" previously read as queued
  // work; the fix states plainly that the state is accepted and settled.
  for (const axis of ["deferred", "inventory_only", "unavailable", "unsupported"] as const) {
    const chip = formatCoverageAxis(axis);
    assert.doesNotMatch(chip.title, FORWARD_LOOKING_COLLECTION_COPY, `${axis} title implies queued future work`);
    assert.match(chip.title, SETTLED_ACCEPTED_ABSENCE_COPY, `${axis} title does not read as settled/accepted`);
    assert.doesNotMatch(chip.title, CONNECTOR_OR_STREAM_NAME_COPY, `${axis} title names a specific connector`);
    assert.equal(chip.tone, "neutral");
  }
});

test("accepted-absence coverage is distinct from required missing evidence", () => {
  // `unknown` is a required stream resting with no coverage proof — it MUST NOT
  // read like a settled accepted-absence policy, and vice versa.
  const unknownChip = formatCoverageAxis("unknown");
  assert.doesNotMatch(unknownChip.title, SETTLED_ACCEPTED_ABSENCE_COPY);
  for (const axis of ["deferred", "inventory_only", "unavailable", "unsupported"] as const) {
    assert.notEqual(formatCoverageAxis(axis).title, unknownChip.title);
  }
});

const DEFERRED_JARGON_RE = /\bdeferre?s?\b/i;

test("the visible deferred pill reads optional/not-collected, not policy jargon (owner-gate revision)", () => {
  // A tooltip-only fix does not resolve the live concern: the owner reads the
  // pill's visible value/label, not its hover text. The underlying axis key
  // stays "deferred" (durable manifest/runtime contract), but the
  // product-facing value/label must not render that word — "deferred" reads
  // as queued work to an owner scanning a stream row.
  const chip = formatCoverageAxis("deferred");
  assert.doesNotMatch(chip.value, DEFERRED_JARGON_RE, "visible value must not say deferred");
  assert.doesNotMatch(chip.label, DEFERRED_JARGON_RE, "visible label must not say deferred");
  assert.match(chip.value, /optional/i);
  assert.match(chip.value, /not collected/i);
  assert.equal(chip.label.startsWith("Coverage"), true);
  assert.equal(chip.tone, "neutral");
});

test("inventory_only says plainly that it is complete by design, and stays neutral", () => {
  // B4 (owner ledger 2026-08-22): the owner asked whether the neutral/green tone
  // on `inventory only` was intentional. It IS, and it is honest —
  // `inventory_only` is an AcceptedAbsencePolicy that `hasOutstandingGap`
  // excludes and `deriveForwardDisposition` resolves to `complete`, so the
  // connection genuinely owes no further data. The tone therefore stays
  // neutral. What changed is the WORD: "inventory only" read as a limitation
  // the owner might have to act on, so the value now states that this is a
  // finished state by design.
  const chip = formatCoverageAxis("inventory_only");
  assert.equal(chip.tone, "neutral");
  assert.match(chip.value, /complete/i);
  assert.match(chip.value, /design/i);
  assert.equal(chip.label.startsWith("Coverage"), true);
  // It must NOT read as an unmeasured or gapped state — those are real defects
  // and this is not one.
  assert.doesNotMatch(chip.value, /not measured|unknown|gap|missing/i);
  assert.equal(formatCoverageAxis("unavailable").value, "unavailable");
  assert.equal(formatCoverageAxis("unavailable").label, "Coverage · unavailable");
  assert.equal(formatCoverageAxis("unsupported").value, "unsupported");
  assert.equal(formatCoverageAxis("unsupported").label, "Coverage · unsupported");
});

test("axis chips degrade safely when runtime axes are missing or novel", () => {
  // A novel outbox value is not a concrete verdict (stalled/active/idle), so for
  // a non-local connection it is suppressed like the absence-default `unknown`.
  const out = summarizeAxisChips({
    attention: "none",
    coverage: "future_gap",
    freshness: undefined,
    outbox: "future_outbox",
  } as unknown as RefConnectionHealthSnapshot["axes"]);
  assert.equal(out.length, 2);
  assert.deepEqual(
    out.map((c) => c.label),
    ["Coverage · not measured", "Freshness · not measured"]
  );
  assert.equal(
    out.every((c) => c.tone === "neutral"),
    true
  );
});

test("axis chips: a novel outbox value still degrades to neutral 'unknown' for a local-backed connection", () => {
  const out = summarizeAxisChips(
    {
      attention: "none",
      coverage: "future_gap",
      freshness: undefined,
      outbox: "future_outbox",
    } as unknown as RefConnectionHealthSnapshot["axes"],
    { isLocalDeviceBacked: true }
  );
  // Local-backed: the outbox axis is applicable. A novel (non-"unknown") value
  // degrades through formatOutboxAxis to the neutral unknown fallback chip; the
  // "evidence unavailable" sharpening only applies to a literal `unknown` axis.
  assert.equal(out.length, 3);
  assert.equal(out[2]?.label, "Outbox · not measured");
  assert.equal(out[2]?.tone, "neutral");
});

test("freshness axis maps known states honestly", () => {
  assert.equal(formatFreshnessAxis("fresh").tone, "success");
  assert.equal(formatFreshnessAxis("stale").tone, "warning");
  assert.equal(formatFreshnessAxis("unknown").tone, "neutral");
});

test("outbox stalled is danger, unknown is neutral, idle is success", () => {
  assert.equal(formatOutboxAxis("stalled").tone, "danger");
  assert.equal(formatOutboxAxis("unknown").tone, "neutral");
  assert.equal(formatOutboxAxis("idle").tone, "success");
});

test("outbox active is colour-coded as a progressing (non-neutral) state", () => {
  // Report 2 (2026-06-01): `Outbox · active` previously shared the muted
  // `neutral` tone with `unknown`, so a draining outbox was visually
  // indistinguishable from one whose evidence we could not read. It must now
  // carry a distinct, non-neutral tone.
  const active = formatOutboxAxis("active");
  assert.equal(active.tone, "success");
  assert.notEqual(active.tone, "neutral");
});

test("formatSourceOutboxState distinguishes granular local collector states", () => {
  const failedUploadOutbox = formatSourceOutboxState({
    outbox_diagnostics: { dead_letter: 1 },
    outbox_state: "dead_letter",
  });
  assert.equal(failedUploadOutbox.tone, "danger");
  assert.equal(failedUploadOutbox.label, "Outbox · failed uploads");
  assert.equal(failedUploadOutbox.value, "failed uploads");
  assert.doesNotMatch(failedUploadOutbox.title, /dead-letter/i);
  assert.equal(
    formatSourceOutboxState({ outbox_diagnostics: { stale_leases: 1 }, outbox_state: "stale" }).tone,
    "danger"
  );
  assert.equal(
    formatSourceOutboxState({ outbox_diagnostics: { retrying: 1 }, outbox_state: "retrying" }).tone,
    "warning"
  );
  assert.equal(
    formatSourceOutboxState({ outbox_diagnostics: { pending: 1 }, outbox_state: "pending" }).label,
    "Outbox · pending"
  );
  assert.equal(
    formatSourceOutboxState({ outbox_diagnostics: { backlog_open: 1 }, outbox_state: "backlog" }).tone,
    "warning"
  );
  assert.equal(
    formatSourceOutboxState({ outbox_diagnostics: { succeeded: 2, total: 2 }, outbox_state: "drained" }).tone,
    "success"
  );
  assert.equal(formatSourceOutboxState({ outbox_diagnostics: null, outbox_state: undefined }).tone, "neutral");
});

test("summarizeAxisChips omits attention when none and always includes coverage/freshness/outbox", () => {
  const out = summarizeAxisChips(
    snapshot({ axes: { attention: "none", coverage: "complete", freshness: "fresh", outbox: "idle" } }).axes
  );
  assert.equal(
    out.some((c) => c.label.startsWith("Attention")),
    false
  );
  assert.equal(out.length, 3);
  const labels = out.map((c) => c.label);
  assert.ok(labels.some((l) => l.startsWith("Coverage")));
  assert.ok(labels.some((l) => l.startsWith("Freshness")));
  assert.ok(labels.some((l) => l.startsWith("Outbox")));
});

test("summarizeAxisChips surfaces attention when open", () => {
  const out = summarizeAxisChips(
    snapshot({ axes: { attention: "open", coverage: "gaps", freshness: "fresh", outbox: "idle" } }).axes
  );
  assert.equal(out.length, 4);
  assert.ok(out.some((c) => c.label.startsWith("Attention")));
});

test("summarizeAxisChips returns empty when axes are missing (no false success)", () => {
  assert.deepEqual(summarizeAxisChips(null), []);
  assert.deepEqual(summarizeAxisChips(undefined), []);
});

const OUTBOX_NOT_DATA_LOSS_RE = /not a current data-loss signal/i;

// ─── outbox applicability gate (report 1) ─────────────────────────────────
//
// The reference defaults `outbox: "unknown"` for every non-local connection
// (no device-exporter heartbeats). The console must NOT render that as an
// "Outbox · unknown" chip on API/browser connectors. It renders only for
// local/device-backed connections, or when the axis carries a real verdict.

test("outboxAxisIsApplicable: concrete verdicts always apply, even for non-local", () => {
  for (const axis of ["stalled", "active", "idle"] as const) {
    assert.equal(outboxAxisIsApplicable(axis, false), true, `verdict ${axis} should apply`);
  }
});

test("outboxAxisIsApplicable: unknown applies only for local-device-backed connections", () => {
  assert.equal(outboxAxisIsApplicable("unknown", false), false);
  assert.equal(outboxAxisIsApplicable("unknown", true), true);
  // A novel / absent value behaves like unknown.
  assert.equal(outboxAxisIsApplicable("future_outbox", false), false);
  assert.equal(outboxAxisIsApplicable(null, false), false);
  assert.equal(outboxAxisIsApplicable(undefined, true), true);
});

test("summarizeAxisChips omits the outbox chip for a non-local connection with unknown outbox", () => {
  // The exact owner-reported defect: a Gmail/Chase-class connection shows
  // "Outbox · unknown" purely because the reference has no heartbeats for it.
  const out = summarizeAxisChips(
    snapshot({ axes: { attention: "none", coverage: "complete", freshness: "fresh", outbox: "unknown" } }).axes,
    { isLocalDeviceBacked: false }
  );
  assert.equal(out.length, 2);
  assert.equal(
    out.some((c) => c.dimension === "Outbox"),
    false
  );
});

test("summarizeAxisChips keeps the outbox chip for a local-backed connection with unknown outbox, sharpened to 'evidence unavailable'", () => {
  const out = summarizeAxisChips(
    snapshot({ axes: { attention: "none", coverage: "complete", freshness: "fresh", outbox: "unknown" } }).axes,
    { isLocalDeviceBacked: true }
  );
  assert.equal(out.length, 3);
  const outbox = out.find((c) => c.dimension === "Outbox");
  assert.ok(outbox);
  assert.equal(outbox?.label, "Outbox · evidence unavailable");
  // Still neutral — an unreadable outbox is not a current data-loss signal.
  assert.equal(outbox?.tone, "neutral");
  assert.match(outbox?.title ?? "", OUTBOX_NOT_DATA_LOSS_RE);
});

test("summarizeAxisChips shows a stalled outbox even for a non-local connection (concrete verdict wins)", () => {
  // Defensive: if the reference ever projects a real stalled verdict without a
  // local_device_progress row, the danger signal must not be hidden.
  const out = summarizeAxisChips(
    snapshot({ axes: { attention: "none", coverage: "complete", freshness: "fresh", outbox: "stalled" } }).axes,
    { isLocalDeviceBacked: false }
  );
  const outbox = out.find((c) => c.dimension === "Outbox");
  assert.ok(outbox);
  assert.equal(outbox?.tone, "danger");
});

test("summarizeAxisChips shows a colour-coded active outbox for a local-backed connection", () => {
  const out = summarizeAxisChips(
    snapshot({ axes: { attention: "none", coverage: "complete", freshness: "fresh", outbox: "active" } }).axes,
    { isLocalDeviceBacked: true }
  );
  const outbox = out.find((c) => c.dimension === "Outbox");
  assert.equal(outbox?.value, "active");
  assert.equal(outbox?.tone, "success");
});

test("summarizeAxisChips defaults to omitting an unknown outbox when no local-backing signal is passed", () => {
  // Back-compat: callers that have not threaded the signal get the honest
  // (non-local) default — an absence-default unknown outbox is suppressed.
  const out = summarizeAxisChips(
    snapshot({ axes: { attention: "none", coverage: "complete", freshness: "fresh", outbox: "unknown" } }).axes
  );
  assert.equal(
    out.some((c) => c.dimension === "Outbox"),
    false
  );
});

test("formatProjectionFreshness flags unreliable when unknown_reasons is non-empty", () => {
  const out = formatProjectionFreshness(
    snapshot({ state: "unknown", unknown_reasons: ["schedule_unavailable", "freshness_unknown"] })
  );
  assert.equal(out.unreliable, true);
  assert.equal(out.reasons.length, 2);
  assert.equal(out.detail.includes("schedule unavailable"), true);
  assert.equal(out.detail.includes("freshness unknown"), true);
});

test("formatProjectionFreshness returns reliable when no unknown_reasons", () => {
  const out = formatProjectionFreshness(snapshot());
  assert.equal(out.unreliable, false);
  assert.equal(out.reasons.length, 0);
});

test("formatProjectionFreshness handles missing snapshot", () => {
  const out = formatProjectionFreshness(null);
  assert.equal(out.unreliable, false);
});

test("formatDominantCondition surfaces only false dominant evidence", () => {
  const out = formatDominantCondition(
    snapshot({
      conditions: [
        {
          expires_at: null,
          id: "CredentialsValid:auth_expired",
          message: "The source rejected the configured credentials.",
          observed_at: null,
          origin: "readiness",
          reason: "auth_expired",
          remediation: {
            action: "refresh_credentials",
            label: "Reconnect this account",
            retryable: false,
            target: "credentials",
          },
          sensitivity: "secret_redacted",
          severity: "blocked",
          status: "false",
          type: "CredentialsValid",
        },
      ],
      dominant_condition_id: "CredentialsValid:auth_expired",
      state: "blocked",
    })
  );
  assert.equal(out?.tone, "danger");
  assert.equal(out.label.includes("rejected"), true);
  assert.equal(out.title.includes("Reconnect"), true);
});

function clearBacklogCondition(overrides: Partial<RefConnectionHealthCondition> = {}): RefConnectionHealthCondition {
  return {
    expires_at: null,
    id: "cond-backlog",
    message: "Local exporter work is stalled or blocked.",
    observed_at: "2026-05-19T12:00:00Z",
    origin: "local_device",
    reason: "local_exporter_stalled",
    remediation: {
      action: "clear_backlog",
      label: "Inspect the local collector backlog",
      retryable: true,
      target: "local_device",
    },
    sensitivity: "owner",
    severity: "error",
    status: "false",
    type: "LocalExporterAvailable",
    ...overrides,
  };
}

test("summarizeOutboxStallRemediation surfaces the reference remediation label for a clear_backlog condition", () => {
  const remediation = summarizeOutboxStallRemediation(
    snapshot({
      axes: { attention: "none", coverage: "complete", freshness: "fresh", outbox: "stalled" },
      conditions: [clearBacklogCondition()],
      state: "degraded",
    })
  );
  assert.equal(remediation?.label, "Inspect the local collector backlog");
  assert.equal(remediation?.reason, "local exporter stalled");
});

test("summarizeOutboxStallRemediation stays quiet for a stalled axis without a clear_backlog action", () => {
  const remediation = summarizeOutboxStallRemediation(
    snapshot({ axes: { attention: "none", coverage: "complete", freshness: "fresh", outbox: "stalled" } })
  );

  assert.equal(remediation, null);
});

test("summarizeOutboxStallRemediation stays quiet for healthy/idle/active/unknown outboxes", () => {
  for (const outbox of ["idle", "active", "unknown"] as const) {
    assert.equal(
      summarizeOutboxStallRemediation(
        snapshot({ axes: { attention: "none", coverage: "complete", freshness: "fresh", outbox } })
      ),
      null,
      `expected no remediation for outbox=${outbox}`
    );
  }
  assert.equal(summarizeOutboxStallRemediation(null), null);
});

test("summarizeOutboxStallRemediation ignores a clear_backlog remediation on a resolved (status=true) condition", () => {
  // A backlog condition that has cleared (status true) must not keep showing
  // remediation noise once the outbox is no longer stalled.
  const remediation = summarizeOutboxStallRemediation(
    snapshot({
      axes: { attention: "none", coverage: "complete", freshness: "fresh", outbox: "idle" },
      conditions: [clearBacklogCondition({ status: "true" })],
    })
  );
  assert.equal(remediation, null);
});

test("summarizeOutboxStallRemediation: scale is null when no count rollup is available", () => {
  const remediation = summarizeOutboxStallRemediation(
    snapshot({
      axes: { attention: "none", coverage: "complete", freshness: "fresh", outbox: "stalled" },
      conditions: [clearBacklogCondition()],
    })
  );
  assert.equal(remediation?.scale, null);
});

test("summarizeOutboxStallRemediation: surfaces a count-backed scale from outbox_counts on a stall", () => {
  const remediation = summarizeOutboxStallRemediation(
    snapshot({
      axes: { attention: "none", coverage: "complete", freshness: "fresh", outbox: "stalled" },
      conditions: [clearBacklogCondition()],
    }),
    {
      last_heartbeat_at: "2026-05-19T11:55:00Z",
      last_heartbeat_status: "blocked",
      last_ingest_at: null,
      outbox_counts: { dead_letter: 2, pending: 12, stale_leases: 1, total: 15 },
      records_pending: 12,
      source_count: 1,
    }
  );
  assert.equal(remediation?.scale, "12 pending · 1 stale lease · 2 failed uploads");
});

test("summarizeOutboxStallRemediation: scale omits zero categories so it never reads as alarming noise", () => {
  const remediation = summarizeOutboxStallRemediation(
    snapshot({
      axes: { attention: "none", coverage: "complete", freshness: "fresh", outbox: "stalled" },
      conditions: [clearBacklogCondition()],
    }),
    {
      last_heartbeat_at: "2026-05-19T11:55:00Z",
      last_heartbeat_status: "blocked",
      last_ingest_at: null,
      outbox_counts: { dead_letter: 3, pending: 0, stale_leases: 0, total: 3 },
      records_pending: 0,
      source_count: 1,
    }
  );
  assert.equal(remediation?.scale, "3 failed uploads");
});

test("summarizeOutboxStallRemediation: counts never attach to a quiet (non-stalled) connection", () => {
  // Even with a populated rollup, an idle/active/unknown outbox returns null —
  // so the count-backed scale can never appear on a healthy connection.
  for (const outbox of ["idle", "active", "unknown"] as const) {
    assert.equal(
      summarizeOutboxStallRemediation(
        snapshot({ axes: { attention: "none", coverage: "complete", freshness: "fresh", outbox } }),
        {
          last_heartbeat_at: "2026-05-19T11:55:00Z",
          last_heartbeat_status: "healthy",
          last_ingest_at: "2026-05-19T11:55:00Z",
          outbox_counts: { dead_letter: 1, pending: 5 },
          records_pending: 5,
          source_count: 1,
        }
      ),
      null,
      `expected no remediation (and thus no counts) for outbox=${outbox}`
    );
  }
});

// ─── syncStartFailureLead (report 5) ──────────────────────────────────────
//
// A failed `Sync now` must stay a row-local toast that tells the owner whether
// the run-start request reached the reference server, never fall through to the
// dashboard error boundary.

const LEAD_UNREACHABLE_RE = /reach the reference server/i;
const LEAD_DID_NOT_START_RE = /did not start/i;
const LEAD_REJECTED_RE = /reference server rejected/i;

test("syncStartFailureLead distinguishes a before-server (unreachable) failure", () => {
  const lead = syncStartFailureLead("before_server");
  assert.match(lead, LEAD_UNREACHABLE_RE);
  assert.match(lead, LEAD_DID_NOT_START_RE);
});

test("syncStartFailureLead distinguishes an after-server (rejected) failure", () => {
  const lead = syncStartFailureLead("after_server");
  assert.match(lead, LEAD_REJECTED_RE);
  assert.match(lead, LEAD_DID_NOT_START_RE);
  // The two phases must read differently so the owner knows where the failure
  // happened.
  assert.notEqual(lead, syncStartFailureLead("before_server"));
});

function baseSchedule(overrides: Partial<RefSchedule> = {}): RefSchedule {
  return {
    active_run_id: null,
    automation_mode: "manual_only",
    automation_summary: "manual only",
    connector_id: "demo",
    created_at: "2026-05-19T11:00:00Z",
    effective_mode: "manual",
    enabled: true,
    human_attention_needed: false,
    ineligibility_reason: null,
    interval_seconds: 3600,
    jitter_seconds: 0,
    last_error_code: null,
    last_finished_at: null,
    last_started_at: null,
    last_successful_at: null,
    minimum_interval_warning: null,
    next_due_at: null,
    notification_posture: "none",
    object: "schedule",
    recommended_policy: null,
    scheduler_backoff: null,
    trigger_kind: "scheduled",
    updated_at: "2026-05-19T11:00:00Z",
    ...overrides,
  };
}

test("summarizeSchedule returns null when no schedule", () => {
  assert.equal(summarizeSchedule(null), null);
});

test("summarizeSchedule surfaces backoff when applied", () => {
  const out = summarizeSchedule(
    baseSchedule({
      scheduler_backoff: {
        backoff_applied: true,
        consecutive_failures: 3,
        next_run_at: "2026-05-19T13:00:00Z",
        reason_class: "rate_limited",
        recommended_health_state: "cooling_off",
      },
    })
  );
  assert.ok(out);
  assert.equal(out.backoffLabel?.includes("Backoff applied"), true);
  assert.equal(out.backoffLabel?.includes("rate limited"), true);
  assert.equal(out.backoffLabel?.includes("3 consecutive failures"), true);
});

test("summarizeSchedule labels a source-pressure cooldown without inventing failures", () => {
  // The cross-run source-pressure cooldown sets `backoff_applied: true` with
  // `reason_class: "source_pressure"` and `consecutive_failures: 0` (the run
  // succeeded). The label must not read as "0 consecutive failures."
  const out = summarizeSchedule(
    baseSchedule({
      scheduler_backoff: {
        backoff_applied: true,
        consecutive_failures: 0,
        next_run_at: "2026-05-19T13:00:00Z",
        reason_class: "source_pressure",
        recommended_health_state: "cooling_off",
      },
    })
  );
  assert.ok(out);
  assert.match(out.backoffLabel ?? "", /source pressure/i);
  assert.match(out.backoffLabel ?? "", /progress retained/i);
  assert.doesNotMatch(out.backoffLabel ?? "", /failure/i);
});

test("summarizeSchedule surfaces ineligibility reason without inventing automation", () => {
  const out = summarizeSchedule(baseSchedule({ ineligibility_reason: "browser_runtime_unavailable" }));
  assert.equal(out?.ineligibilityReason, "browser_runtime_unavailable");
});

test("resolveRecordCountDisplay refuses to show 0 when overview has an error", () => {
  const out = resolveRecordCountDisplay(baseOverview({ error: "boom", totalRecords: 0 }));
  assert.equal(out.label, null);
  assert.equal(out.reliable, false);
  assert.equal(out.title.includes("unavailable"), true);
});

test("resolveRecordCountDisplay renders the count normally when reliable", () => {
  const out = resolveRecordCountDisplay(baseOverview({ totalRecords: 1234 }));
  assert.equal(out.label, "1,234");
  assert.equal(out.reliable, true);
});

test("resolveRecordCountDisplay handles 0 records as honest 0 when there is no error", () => {
  const out = resolveRecordCountDisplay(baseOverview({ totalRecords: 0 }));
  assert.equal(out.label, "0");
  assert.equal(out.reliable, true);
});

// Sol fourth-verdict P1.3: `resolveRecordCountDisplay` unconditionally
// returned `reliable: true` regardless of `totalRecordsState` — a
// non-authoritative (stale/unobserved/unknown) snapshot's carried-over
// number, including a carried-over zero, must never render as reliable.

test("resolveRecordCountDisplay marks a stale prior-nonzero count unreliable and unverified, never a bare confident number", () => {
  const out = resolveRecordCountDisplay(baseOverview({ totalRecords: 1234, totalRecordsState: "stale" }));
  assert.equal(out.reliable, false);
  assert.match(String(out.label), /1,234.*unverified/);
});

test("resolveRecordCountDisplay marks a stale prior-ZERO count unreliable and unverified, never an authoritative bare 0", () => {
  const out = resolveRecordCountDisplay(baseOverview({ totalRecords: 0, totalRecordsState: "stale" }));
  assert.equal(out.reliable, false);
  assert.notEqual(
    out.label,
    "0",
    "a stale carried-over zero must never render as an indistinguishable authoritative '0'"
  );
  assert.match(String(out.label), /0.*unverified/);
});

test("resolveRecordCountDisplay marks unobserved/unknown states unreliable without fabricating a number", () => {
  const unobserved = resolveRecordCountDisplay(baseOverview({ totalRecords: 0, totalRecordsState: "unobserved" }));
  assert.equal(unobserved.reliable, false);
  assert.match(String(unobserved.label), /unavailable/);

  const unknown = resolveRecordCountDisplay(baseOverview({ totalRecords: 0, totalRecordsState: "unknown" }));
  assert.equal(unknown.reliable, false);
  assert.match(String(unknown.label), /unavailable/);
});

test("resolveRecordCountDisplay treats known/known_zero states as reliable, matching the omitted-state behavior", () => {
  const known = resolveRecordCountDisplay(baseOverview({ totalRecords: 1234, totalRecordsState: "known" }));
  assert.equal(known.reliable, true);
  assert.equal(known.label, "1,234");

  const knownZero = resolveRecordCountDisplay(baseOverview({ totalRecords: 0, totalRecordsState: "known_zero" }));
  assert.equal(knownZero.reliable, true);
  assert.equal(knownZero.label, "0");
});

test("formatProjectionFreshness does not call a connector-reported collection missing evidence", () => {
  const out = formatProjectionFreshness(
    snapshot({ state: "unknown", unknown_reasons: ["coverage_reported_collected"] })
  );
  assert.equal(out.unreliable, false);
  assert.equal(out.detail, "");
});

test("summarizeAxisChips attributes a reported-collected coverage chip to the connector", () => {
  const axes = snapshot({
    axes: { attention: "none", coverage: "unknown", freshness: "fresh", outbox: "idle" },
  }).axes;
  const [coverage] = summarizeAxisChips(axes, { coverageReportedCollected: true });
  assert.equal(coverage?.label, "Coverage · reported collected");
  assert.equal(coverage?.tone, "neutral");
  assert.match(coverage?.title ?? "", /connector reports/i);
  // Without the cause flag the same axis stays the plain unknown chip.
  const [plain] = summarizeAxisChips(axes);
  assert.notEqual(plain?.label, "Coverage · reported collected");
});

test("formatForwardDisposition does not say coverage is established when it is only reported", () => {
  const reported = formatForwardDisposition("complete", { coverageReportedCollected: true });
  assert.equal(reported?.tone, "neutral");
  assert.doesNotMatch(reported?.title ?? "", /Coverage is established/);
  assert.match(reported?.title ?? "", /connector reports/i);
  assert.match(formatForwardDisposition("complete")?.title ?? "", /Coverage is established/);
});

test("derivePrimaryRowAction keeps Sync now for an owner-syncable connector", () => {
  const action = derivePrimaryRowAction({ connectorId: "gmail", hasLocalDeviceProgress: false });
  assert.equal(action.kind, "sync");
});

const DEVICE_WAIT_DETAIL_RE = /local-collector device|local collector/i;

test("derivePrimaryRowAction never returns sync for a push-mode local-collector row", () => {
  const action = derivePrimaryRowAction({ connectorId: "claude-code", hasLocalDeviceProgress: true });
  assert.equal(action.kind, "device_wait");
  assert.notEqual(action.kind, "sync");
  if (action.kind === "device_wait") {
    assert.ok(action.label.trim().length > 0);
    assert.match(action.detail, DEVICE_WAIT_DETAIL_RE);
  }
});

test("derivePrimaryRowAction keeps Sync now for an existing browser-bound connection", () => {
  assert.equal(derivePrimaryRowAction({ connectorId: "chatgpt", hasLocalDeviceProgress: false }).kind, "sync");
  assert.equal(derivePrimaryRowAction({ connectorId: "amazon", hasLocalDeviceProgress: false }).kind, "sync");
});

test("derivePrimaryRowAction disables ordinary sync during source-pressure cooldown", () => {
  const action = derivePrimaryRowAction({
    connectorId: "chatgpt",
    hasLocalDeviceProgress: false,
    health: snapshot({
      next_attempt_at: "2026-06-10T22:30:00.000Z",
      reason_code: "source_pressure",
      state: "cooling_off",
    }),
  });
  assert.equal(action.kind, "cooldown_wait");
  if (action.kind === "cooldown_wait") {
    assert.equal(action.label, "Cooling off");
    assert.match(action.detail, /2026-06-10T22:30:00\.000Z/);
    assert.match(action.detail, /retained/i);
  }
});

test("derivePrimaryRowAction disables ordinary sync when source-pressure backlog coexists with a blocked headline state", () => {
  const action = derivePrimaryRowAction({
    connectorId: "chatgpt",
    hasLocalDeviceProgress: false,
    health: snapshot({
      detail_gap_backlog: backlog({
        max_attempt_count: 10,
        pending: 100,
        pending_is_floor: true,
      }),
      next_attempt_at: "2026-06-11T14:17:24.984Z",
      reason_code: "connector_reported_failed",
      state: "blocked",
    }),
  });
  assert.equal(action.kind, "cooldown_wait");
  if (action.kind === "cooldown_wait") {
    assert.equal(action.label, "Cooling off");
    assert.ok(action.detail.includes("at least 100 pending provider-pressure gaps"));
    assert.ok(action.detail.includes("ordinary sync may be rejected"));
    assert.ok(action.detail.includes("retained"));
  }
});

test("derivePrimaryRowAction keeps ordinary sync for non-pressure cooling-off", () => {
  const action = derivePrimaryRowAction({
    connectorId: "github",
    hasLocalDeviceProgress: false,
    health: snapshot({ reason_code: "scheduler_backoff_active", state: "cooling_off" }),
  });
  assert.equal(action.kind, "sync");
});

test("derivePrimaryRowAction keeps local-device push mode non-clickable even for a browser-bound key", () => {
  const action = derivePrimaryRowAction({ connectorId: "chase", hasLocalDeviceProgress: true });
  assert.equal(action.kind, "device_wait");
});

test("derivePrimaryRowAction defaults to sync for an unknown connector with no device progress", () => {
  // Unknown/no-data owner-syncable rows: the clickable Sync now IS the honest
  // next step. The false-affordance suppression only fires for push-mode
  // local-device connections.
  assert.equal(derivePrimaryRowAction({ connectorId: "demo", hasLocalDeviceProgress: false }).kind, "sync");
  assert.equal(derivePrimaryRowAction({ connectorId: null, hasLocalDeviceProgress: false }).kind, "sync");
  assert.equal(derivePrimaryRowAction({ connectorId: undefined, hasLocalDeviceProgress: false }).kind, "sync");
});

test("syncActionIdleLabel names failed and cancelled runs as retries", () => {
  assert.equal(syncActionIdleLabel("failed"), "Retry sync");
  assert.equal(syncActionIdleLabel("cancelled"), "Retry sync");
  assert.equal(syncActionIdleLabel("canceled"), "Retry sync");
});

test("syncActionIdleLabel keeps non-failed idle sync copy", () => {
  assert.equal(syncActionIdleLabel("succeeded"), "Sync now");
  assert.equal(syncActionIdleLabel("started"), "Sync now");
  assert.equal(syncActionIdleLabel(null), "Sync now");
  assert.equal(syncActionIdleLabel(undefined), "Sync now");
});

// ─── deriveFailureSummary ─────────────────────────────────────────────────────

// Top-level regex constants for useTopLevelRegex compliance
const PROSE_THROTTLE_RE = /throttl/i;
function renderedVerdict(overrides: Partial<RefRenderedVerdict> = {}): RefRenderedVerdict {
  return {
    annotations: [],
    channel: "attention",
    detail: {},
    forward_statement: "The server has an owner-facing next step.",
    pill: { label: "Can't collect", tone: "red" },
    progress: {
      gaps_drained_last_run: null,
      headline: "Collection needs review.",
      last_refreshed_at: null,
      mode: "manual",
      records_committed_last_run: null,
      retained_records: null,
    },
    required_actions: [],
    streams: [],
    trace: null,
    ...overrides,
  };
}

test("deriveFailureSummary never classifies a raw health snapshot without a server verdict", () => {
  for (const health of [
    snapshot({ state: "degraded" }),
    snapshot({ state: "cooling_off", reason_code: "source_pressure" }),
    snapshot({ state: "blocked" }),
    snapshot({ state: "needs_attention" }),
  ]) {
    assert.equal(deriveFailureSummary(health), null);
  }
});

test("deriveFailureSummary formats the server verdict and only borrows facts from raw health", () => {
  const result = deriveFailureSummary(
    snapshot({
      last_success_at: "2026-04-28T19:33:00Z",
      next_attempt_at: "2026-05-15T15:36:00Z",
      reason_code: "browser_context_died",
      state: "blocked",
    }),
    renderedVerdict({
      required_actions: [
        {
          affects: [],
          audience: "owner",
          cta: "Reconnect this account",
          kind: "reauth",
          satisfied_when: { kind: "credential_present_and_unrejected" },
          terminal: true,
          urgency: "now",
        },
      ],
    })
  );
  assert.ok(result);
  assert.equal(result.actionLabel, "Reconnect this account");
  assert.equal(result.cta, "connection_detail");
  assert.equal(result.reasonCode, "browser_context_died");
  assert.equal(result.nextAttemptAt, "2026-05-15T15:36:00Z");
  assert.equal(result.lastSuccessAt, "2026-04-28T19:33:00Z");
});

test("deriveFailureSummary uses the server wait verdict even when raw health says source pressure", () => {
  const result = deriveFailureSummary(
    snapshot({ reason_code: "source_pressure", state: "blocked" }),
    renderedVerdict({
      channel: "advisory",
      forward_statement: "The source is throttling this connection; it will retry automatically.",
      pill: { label: "Missing data", tone: "amber" },
      required_actions: [
        {
          affects: [],
          audience: "none",
          cta: "No action needed",
          kind: "wait",
          satisfied_when: { kind: "none" },
          terminal: false,
          urgency: "soon",
        },
      ],
    })
  );
  assert.ok(result);
  assert.equal(result.cta, "wait");
  assert.match(result.prose, PROSE_THROTTLE_RE);
});

// ─── deriveStreakDots ─────────────────────────────────────────────────────────

test("deriveStreakDots returns empty array for no runs", () => {
  assert.deepEqual(deriveStreakDots([]), []);
});

test("deriveStreakDots maps succeeded → ✓ success", () => {
  const dots = deriveStreakDots([{ first_at: "2026-05-15T00:00:00Z", status: "succeeded" }]);
  assert.equal(dots.length, 1);
  assert.ok(dots[0]);
  assert.equal(dots[0].symbol, "✓");
  assert.equal(dots[0].tone, "success");
});

test("deriveStreakDots maps failed → ✕ danger", () => {
  const dots = deriveStreakDots([
    { failure_reason: "browser_timeout", first_at: "2026-05-15T00:00:00Z", status: "failed" },
  ]);
  assert.ok(dots[0]);
  assert.equal(dots[0].symbol, "✕");
  assert.equal(dots[0].tone, "danger");
  assert.equal(dots[0].statusLabel, "browser_timeout");
});

test("deriveStreakDots maps cancelled → ⊘ neutral", () => {
  const dots = deriveStreakDots([{ first_at: "2026-05-15T00:00:00Z", status: "cancelled" }]);
  assert.ok(dots[0]);
  assert.equal(dots[0].symbol, "⊘");
  assert.equal(dots[0].tone, "neutral");
});

test("deriveStreakDots maps degraded → ⚠ warning", () => {
  const dots = deriveStreakDots([{ first_at: "2026-05-15T00:00:00Z", status: "degraded" }]);
  assert.ok(dots[0]);
  assert.equal(dots[0].symbol, "⚠");
  assert.equal(dots[0].tone, "warning");
});

test("deriveStreakDots maps succeeded_with_gaps → ⚠ warning", () => {
  const dots = deriveStreakDots([{ first_at: "2026-05-15T00:00:00Z", status: "succeeded_with_gaps" }]);
  assert.ok(dots[0]);
  assert.equal(dots[0].symbol, "⚠");
  assert.equal(dots[0].tone, "warning");
  assert.equal(dots[0].statusLabel, "Succeeded with gaps");
});

test("summarizeStreakDots distinguishes clean, failed, and completed-with-gaps runs", () => {
  assert.equal(
    summarizeStreakDots(deriveStreakDots([{ first_at: "2026-05-15T00:00:00Z", status: "succeeded" }])),
    "0 failures"
  );
  assert.equal(
    summarizeStreakDots(deriveStreakDots([{ first_at: "2026-05-15T00:00:00Z", status: "succeeded_with_gaps" }])),
    "1 with gaps"
  );
  assert.equal(
    summarizeStreakDots(
      deriveStreakDots([
        { first_at: "2026-05-15T00:00:00Z", status: "failed" },
        { first_at: "2026-05-14T00:00:00Z", status: "succeeded_with_gaps" },
      ])
    ),
    "1 failure · 1 with gaps"
  );
});

test("deriveStreakDots caps at 14 runs", () => {
  const runs = Array.from({ length: 20 }, (_, i) => ({
    first_at: `2026-05-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
    status: "succeeded",
  }));
  assert.equal(deriveStreakDots(runs).length, 14);
});

test("deriveStreakDots preserves the at timestamp for tooltip", () => {
  const ts = "2026-05-15T13:00:00Z";
  const dots = deriveStreakDots([{ first_at: ts, status: "succeeded" }]);
  assert.ok(dots[0]);
  assert.equal(dots[0].at, ts);
});

// ─── deriveAutoPausedBanner ───────────────────────────────────────────────────

test("deriveAutoPausedBanner returns null when no schedule", () => {
  assert.equal(deriveAutoPausedBanner(null), null);
  assert.equal(deriveAutoPausedBanner(undefined), null);
});

test("deriveAutoPausedBanner returns null when backoff not applied", () => {
  const schedule = {
    scheduler_backoff: {
      backoff_applied: false,
      consecutive_failures: 0,
      next_run_at: null,
      reason_class: null,
      recommended_health_state: null as "blocked" | "cooling_off" | null,
    },
  };
  assert.equal(deriveAutoPausedBanner(schedule), null);
});

test("deriveAutoPausedBanner returns null when scheduler_backoff is null", () => {
  assert.equal(deriveAutoPausedBanner({ scheduler_backoff: null }), null);
});

test("deriveAutoPausedBanner returns banner with consecutive failures and reason", () => {
  const schedule = {
    scheduler_backoff: {
      backoff_applied: true,
      consecutive_failures: 5,
      next_run_at: "2026-05-15T15:36:00Z",
      reason_class: "reddit_login_unexpected_ui",
      recommended_health_state: "cooling_off" as const,
    },
  };
  const banner = deriveAutoPausedBanner(schedule);
  assert.ok(banner);
  assert.equal(banner.consecutiveFailures, 5);
  assert.equal(banner.nextRunAt, "2026-05-15T15:36:00Z");
  assert.equal(banner.reasonLabel, "reddit login unexpected ui");
  assert.equal(banner.isTerminal, false);
});

test("deriveAutoPausedBanner marks terminal when recommended_health_state is blocked", () => {
  const schedule = {
    scheduler_backoff: {
      backoff_applied: true,
      consecutive_failures: 47,
      next_run_at: null,
      reason_class: "connector_reported_failed",
      recommended_health_state: "blocked" as const,
    },
  };
  const banner = deriveAutoPausedBanner(schedule);
  assert.ok(banner);
  assert.equal(banner.isTerminal, true);
});

test("deriveAutoPausedBanner handles null reason_class gracefully", () => {
  const schedule = {
    scheduler_backoff: {
      backoff_applied: true,
      consecutive_failures: 3,
      next_run_at: null,
      reason_class: null,
      recommended_health_state: "cooling_off" as const,
    },
  };
  const banner = deriveAutoPausedBanner(schedule);
  assert.ok(banner);
  assert.equal(banner.reasonLabel, null);
});

test("formatCollectionRateReadout degrades to null when no controller state is present (honest unknown)", () => {
  assert.equal(formatCollectionRateReadout(null), null, "null state → no false rate");
  assert.equal(formatCollectionRateReadout(undefined), null, "absent field → no false rate");
});

test("formatCollectionRateReadout surfaces current rate, ceiling, and last back-off", () => {
  const readout = formatCollectionRateReadout({
    ceiling_interval_ms: 250,
    ceiling_rate_per_min: 240,
    current_interval_ms: 500,
    effective_rate_per_min: 120,
    last_backoff: { at: null, at_interval_ms: 1000, reason: "throttle" },
  });
  assert.ok(readout);
  assert.match(readout.currentLabel, /120\/min/);
  assert.match(readout.currentLabel, /500ms/);
  assert.match(readout.ceilingLabel, /240\/min/);
  assert.equal(readout.backoffLabel, "last backed off to 1,000ms (throttle)");
});

test("formatCollectionRateReadout omits the back-off line when none has fired", () => {
  const readout = formatCollectionRateReadout({
    ceiling_interval_ms: 250,
    ceiling_rate_per_min: 240,
    current_interval_ms: 250,
    effective_rate_per_min: 240,
    last_backoff: null,
  });
  assert.ok(readout);
  assert.equal(readout.backoffLabel, null, "no back-off → no back-off line");
});

test("formatCollectionRateReadout fails closed for partial projection payloads", () => {
  const partialBackoff = formatCollectionRateReadout({
    ceiling_interval_ms: 250,
    ceiling_rate_per_min: 240,
    current_interval_ms: 250,
    effective_rate_per_min: 240,
    last_backoff: { reason: "throttle" },
  });
  assert.ok(partialBackoff);
  assert.equal(partialBackoff.backoffLabel, null, "partial back-off → omit optional line");

  assert.equal(
    formatCollectionRateReadout({
      ceiling_interval_ms: 250,
      ceiling_rate_per_min: 240,
      current_interval_ms: Number.NaN,
      effective_rate_per_min: 240,
      last_backoff: null,
    }),
    null,
    "invalid core rate → honest unknown"
  );
});

test("formatSupportingCondition labels the type instead of leaking the enum key", () => {
  const view = formatSupportingCondition({
    id: "BacklogClear:outbox_unknown",
    message: "No trusted local-device outbox evidence is available.",
    reason: "outbox_unknown",
    status: "unknown",
    type: "BacklogClear",
  });

  assert.equal(view.label, "Backlog clear", "the raw CamelCase enum key must never reach the owner");
  assert.equal(view.statusLabel, "Unknown", "the bare lowercase status is capitalized");
  assert.match(view.title, /outbox unknown/, "the snake_case reason is humanized before the tooltip");
  assert.doesNotMatch(view.title, /outbox_unknown/);
});

test("formatSupportingCondition keeps the message on every status, not just false", () => {
  // The old renderer dropped `message` unless the status was `false`, which hid
  // the one human-readable field exactly on the healthy connections where a bare
  // "Unknown" explained nothing.
  for (const status of ["true", "false", "unknown", "not_applicable"]) {
    const view = formatSupportingCondition({
      id: `RuntimeAvailable:runtime_not_managed:${status}`,
      message: "No managed runtime surface is required for this connection.",
      reason: "runtime_not_managed",
      status,
      type: "RuntimeAvailable",
    });
    assert.match(view.message, /No managed runtime surface is required/, `${status} must carry its message`);
    assert.match(view.title, /No managed runtime surface is required/);
  }
});

test("formatSupportingCondition folds the remediation label into the tooltip", () => {
  const view = formatSupportingCondition({
    id: "LocalExporterAvailable:local_exporter_stalled",
    message: "The local collector is not making progress.",
    reason: "local_exporter_stalled",
    remediation: { label: "Check the local collector" },
    status: "false",
    type: "LocalExporterAvailable",
  });

  assert.equal(view.statusLabel, "No");
  assert.match(view.title, /Check the local collector\.$/);
});

test("formatSupportingCondition degrades gracefully for an unknown condition type", () => {
  // A newer reference may add a condition type this console build has no label
  // for; it must still read as words rather than vanishing or throwing.
  const view = formatSupportingCondition({
    id: "SomeNewCheck:whatever",
    message: "",
    reason: "whatever",
    status: "unknown",
    type: "SomeNewCheck",
  });

  assert.equal(view.label, "Some new check");
  assert.equal(view.message, "", "an empty message stays empty rather than rendering a stray separator");
});

// The single-voice "handling it" badge synthesizer (`synthesizeConnectionVerdict`
// / `badgeState`) that used to live here was deleted (Wave 10a/10b, 2026-07-09
// state-model convergence): the server-owned `RenderedVerdict.pill` is the one
// badge every owner surface renders now. The source-pressure-cooldown
// classification this synthesizer relied on (`isSourcePressureCooldown`)
// remains load-bearing for `deriveFailureSummary`'s `blocked` branch and is
// covered above (`deriveFailureSummary blocked + source_pressure reason_code`).

/**
 * Reproduces the live UAT shape: a one-shot collector killed with its
 * terminal, leaving `last_heartbeat_status = 'starting'` in the column for
 * 38+ hours. The dashboard rendered "Heartbeat: starting" the whole time.
 */
test("formatSourceHeartbeat never presents a stale status verbatim", () => {
  const chip = formatSourceHeartbeat({
    heartbeat_health: "stale",
    heartbeat_lease_ms: 30 * 60 * 1000,
    last_heartbeat_status: "starting",
  });

  assert.equal(chip.value, "stale", "beyond the lease the presented health is stale");
  assert.doesNotMatch(chip.label, /starting/, "the dead process's last 'starting' must not be the label");
  assert.match(chip.title, /Last reported "starting"/, "but it is retained as dated evidence");
  assert.match(chip.title, /30-minute lease/, "and the declared lease is named");
});

test("formatSourceHeartbeat passes a within-lease status through", () => {
  const chip = formatSourceHeartbeat({
    heartbeat_health: "starting",
    heartbeat_lease_ms: 30 * 60 * 1000,
    last_heartbeat_status: "starting",
  });

  assert.equal(chip.value, "starting", "a fresh 'starting' really is starting");
  assert.equal(chip.label, "Heartbeat · starting");
});

test("formatSourceHeartbeat reports unknown when the server derived no health", () => {
  // An older reference that does not project `heartbeat_health` must degrade
  // to unknown, never fall back to the raw status it also sends.
  const chip = formatSourceHeartbeat({ last_heartbeat_status: "starting" });

  assert.equal(chip.value, "unknown");
  assert.doesNotMatch(chip.label, /starting/, "an underived status is not evidence of life");
});

// Local coverage is a fact about one run, never a present-tense claim: the
// owner sees "complete as of <time>", and the chip names the run, release and
// revision it describes.
const COVERAGE_AS_OF = {
  artifact_digest: `sha256:${"a".repeat(64)}`,
  collection_revision: 7,
  committed_at: "2026-10-22T10:00:00.000Z",
  evidence: "terminal_run",
  run_id: "run-a",
  run_sequence: 3,
} as const;

test("coverage chip reads 'complete as of <time>' when the reference names the run it describes", () => {
  const axes = {
    attention: null,
    coverage: "complete",
    freshness: "fresh",
    outbox: "idle",
  } as const;
  const [coverage] = summarizeAxisChips(axes as never, {
    coverageAsOf: COVERAGE_AS_OF,
    isLocalDeviceBacked: true,
  });
  assert.equal(coverage?.label, "Coverage · complete as of 2026-10-22 10:00:00Z");
  assert.equal(coverage?.value, "complete as of 2026-10-22 10:00:00Z");
  assert.match(coverage?.title ?? "", /run run-a/);
  assert.match(coverage?.title ?? "", /sha256:a{12}/);
  assert.match(coverage?.title ?? "", /revision 7/);
});

test("coverage chip adds no as-of to unknown coverage or when the reference sends none", () => {
  const unknown = {
    attention: null,
    coverage: "unknown",
    freshness: "fresh",
    outbox: "idle",
  } as const;
  const [unknownChip] = summarizeAxisChips(unknown as never, {
    coverageAsOf: COVERAGE_AS_OF,
    isLocalDeviceBacked: true,
  });
  assert.equal(unknownChip?.label, formatCoverageAxis("unknown").label);
  const complete = {
    attention: null,
    coverage: "complete",
    freshness: "fresh",
    outbox: "idle",
  } as const;
  const [plain] = summarizeAxisChips(complete as never, {
    coverageAsOf: null,
    isLocalDeviceBacked: true,
  });
  assert.equal(plain?.label, formatCoverageAxis("complete").label);
});

test("per-stream coverage reads 'complete as of <time>' with the connection's as-of", () => {
  const facts = formatStreamCollectionFacts({ coverage_condition: "complete", stream: "messages" } as never, {
    coverageAsOf: COVERAGE_AS_OF,
  });
  assert.equal(facts.coverage.label, "Coverage · complete as of 2026-10-22 10:00:00Z");
});
