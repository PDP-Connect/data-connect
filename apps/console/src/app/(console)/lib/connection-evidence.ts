// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure formatting helpers that turn the reference's projected
 * `connection_health` snapshot plus auxiliary evidence (last run, last
 * successful run, schedule, structured next_action) into the small set
 * of owner-facing strings the dashboard renders.
 *
 * The dashboard MUST NOT invent state. These helpers:
 *   - never label coverage `complete` when the axis is `unknown`;
 *   - never render `0` records when evidence collection failed;
 *   - never render green/healthy when the projection itself is `unknown`;
 *   - surface a "projection unreliable" caveat when the spine told us
 *     evidence was missing or stale.
 *
 * Side-effect-free and pure so the row stays thin and is testable
 * without a browser harness.
 */

import type { AxisChip, EvidenceTone } from "@pdpp/display";
import { formatAttentionAxis, formatCoverageAxis, formatFreshnessAxis, formatOutboxAxis } from "@pdpp/display";
import type {
  DeviceSourceInstance,
  RefCollectionRateSnapshot,
  RefConnectionHealthSnapshot,
  RefCoverageAsOf,
  RefForwardDisposition,
  RefLocalDeviceProgress,
  RefRenderedVerdict,
  RefRequiredAction,
  RefSchedule,
} from "./ref-client.ts";
import type { ConnectorOverview } from "./rs-client.ts";
import { formatTotalRecordsLabel, isTotalRecordsAuthoritative } from "./total-records-label.ts";

// The owner-facing axis vocabulary (coverage / freshness / outbox / attention)
// lives in `packages/display/src/health/axis-vocabulary.ts`, so the console
// and the headless `sources-report` CLI render the SAME words from the same
// evidence. Import the axis formatters and `AxisChip`/`EvidenceTone` from
// `@pdpp/display` directly — this module deliberately does not re-export them.

/**
 * Whether the outbox axis is meaningful for this connection.
 *
 * The reference computes the outbox axis ONLY from local-device exporter
 * heartbeats (`getConnectorOutboxAxis` → `projectConnectorOutboxAxisFrom
 * heartbeats`). A connector with no device-exporter rows — every API/OAuth and
 * browser-bound connection — has no heartbeats, so the reference projects
 * `outbox: "unknown"` as a *default of absence*, not a real signal. Rendering
 * that as an "Outbox · unknown" chip on, say, a Gmail or Chase connection is the
 * mysterious axis owners reported on 2026-06-01.
 *
 * The honest rule (per design-notes/dashboard-health-semantics-and-reliability-
 * 2026-06-01.md): show the outbox axis only for local/device-backed
 * connections. The console's available signal is the connection-summary
 * `local_device_progress` row, which the reference populates exactly when
 * `instance.sourceKind === "local_device"`. We also keep the axis when it
 * carries a real verdict (`stalled` / `active` / `idle`) regardless of that
 * signal, so a genuine local-collector state is never hidden — only the
 * absence-default `unknown` is suppressed for non-local connections.
 */
/**
 * Condition reason the reference attaches when the connector reported
 * collecting everything and the runtime holds no evidence of its own. Mirrors
 * `COVERAGE_REPORTED_COLLECTED` in the reference's `connection-health.ts`.
 */
export const COVERAGE_REPORTED_COLLECTED_REASON = "coverage_reported_collected";

/** True when the only coverage signal is the connector's own report. */
export function coverageIsReportedCollected(snapshot: RefConnectionHealthSnapshot | null | undefined): boolean {
  return (snapshot?.unknown_reasons ?? []).includes(COVERAGE_REPORTED_COLLECTED_REASON);
}

export function outboxAxisIsApplicable(
  axis: RefConnectionHealthSnapshot["axes"]["outbox"] | null | string | undefined,
  isLocalDeviceBacked: boolean
): boolean {
  // A concrete outbox verdict is always worth showing.
  if (axis === "stalled" || axis === "active" || axis === "idle") {
    return true;
  }
  // `unknown` (or any absence-default) is only meaningful for a connection that
  // actually has a local-device outbox whose evidence we could not read.
  return isLocalDeviceBacked;
}

/**
 * Axes that meaningfully refine the headline pill. Order is the order
 * the chips render in. `attention=none` is omitted because the next-action
 * pill already carries that signal.
 *
 * `isLocalDeviceBacked` gates the outbox axis: pass `true` when the connection
 * has a `local_device_progress` row (or is otherwise known to be a
 * local/device-backed collector). When `false`, an absence-default
 * `outbox: "unknown"` is omitted so non-local connections never render a
 * mysterious unknown outbox axis. Defaults to `false` (the common,
 * non-local case) so callers that do not yet thread the signal stay honest.
 */
export function summarizeAxisChips(
  axes: RefConnectionHealthSnapshot["axes"] | undefined | null,
  options: {
    coverageAsOf?: RefCoverageAsOf | null;
    /** The connector reported full collection; the runtime has not checked it. */
    coverageReportedCollected?: boolean;
    isLocalDeviceBacked?: boolean;
  } = {}
): AxisChip[] {
  if (!axes) {
    return [];
  }
  const coverageChip =
    options.coverageReportedCollected === true && axes.coverage === "unknown"
      ? withCoverageAsOf(
          {
            ...formatCoverageAxis(axes.coverage),
            label: "Coverage · reported collected",
            title:
              "The connector reports it collected everything in its latest run. PDP Connect has not independently checked coverage of the source.",
            tone: "neutral" as const,
            value: "reported collected",
          },
          axes.coverage,
          options.coverageAsOf
        )
      : withCoverageAsOf(formatCoverageAxis(axes.coverage), axes.coverage, options.coverageAsOf);
  const out: AxisChip[] = [coverageChip, formatFreshnessAxis(axes.freshness)];
  const attention = formatAttentionAxis(axes.attention);
  if (attention) {
    out.push(attention);
  }
  // Outbox is meaningful only for local/device-backed connections (and whenever
  // it carries a concrete verdict). For everything else the reference defaults
  // it to `unknown` simply because there are no heartbeats — we omit that rather
  // than show a mysterious axis.
  if (outboxAxisIsApplicable(axes.outbox, options.isLocalDeviceBacked ?? false)) {
    const outbox = formatOutboxAxis(axes.outbox);
    // Sharpen the copy for the one case that survives the gate as `unknown`: a
    // local-device connection whose outbox evidence failed to load. The bare
    // "Outbox state cannot be read from durable evidence" is right, but a
    // local-backed operator benefits from the "evidence unavailable" framing.
    if (axes.outbox === "unknown") {
      out.push({
        ...outbox,
        label: "Outbox · evidence unavailable",
        title:
          "This local collector's outbox evidence could not be read right now. It is not a current data-loss signal; retry, or open the connection's diagnostics for the device state.",
        value: "evidence unavailable",
      });
    } else {
      out.push(outbox);
    }
  }
  return out;
}

const FRACTIONAL_SECONDS = /\.\d+Z$/;

/** UTC, to the second: "2026-10-22 10:00:00Z". Empty for a missing or unparseable time. */
function formatCoverageAsOfTime(iso: string | null | undefined): string {
  const parsed = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(parsed)
    ? new Date(parsed).toISOString().replace("T", " ").replace(FRACTIONAL_SECONDS, "Z")
    : "";
}

/**
 * Coverage is a fact about one run, never a present-tense claim. When the
 * reference names the run a coverage verdict describes, the chip reads
 * "complete as of <time>" and its title names the run, release and collection
 * revision. Unknown coverage has no run behind it, so it is left unchanged.
 */
export function withCoverageAsOf(
  chip: AxisChip,
  axis: string | null | undefined,
  asOf: RefCoverageAsOf | null | undefined
): AxisChip {
  const committedAt = formatCoverageAsOfTime(asOf?.committed_at);
  if (!(asOf && committedAt) || axis === "unknown" || axis === null || axis === undefined) {
    return chip;
  }
  return {
    ...chip,
    label: `${chip.label} as of ${committedAt}`,
    title: `${chip.title} This is a fact about run ${asOf.run_id} (release ${asOf.artifact_digest}), committed at ${committedAt} as collection revision ${asOf.collection_revision}. A later run the reference has not heard about is not reflected.`,
    value: `${chip.value} as of ${committedAt}`,
  };
}

/**
 * Owner-facing copy for the connection-level forward disposition — the
 * reference's single answer to "what is the next run expected to do?". This is
 * deliberately NOT another axis chip: coverage / freshness / outbox / attention
 * each describe one dimension of the *current* state, whereas the disposition
 * fuses them into a forward statement. The dashboard renders it as one short
 * line so the two never blur together.
 *
 * Wording stays protocol/reference-accurate: the reference describes what a
 * run on the owner's own instance is expected to do. It never promises a
 * hosted sync service ("we'll refresh nightly"), and the label is connector-
 * agnostic — the same disposition values mean the same thing for every connector.
 */
export interface ForwardDispositionSummary {
  /**
   * Short bare label for the line, e.g. "nothing owed". The renderer supplies
   * the "Next run:" lead-in, so the label stays free of it.
   */
  label: string;
  /** Whether the owner must act before a run can make progress. */
  ownerActionNeeded: boolean;
  /** Long-form hover/title describing what the next run does. */
  title: string;
  tone: EvidenceTone;
  /**
   * The bare disposition value, kept for data-attributes and tooltips.
   * `connector_not_installed` is console-local: it replaces the reference's
   * disposition when the connection's connector has no implementation to run,
   * because no next run can happen until it is installed.
   */
  value: RefForwardDisposition | "connector_not_installed";
}

const FORWARD_DISPOSITION_LABELS: Record<RefForwardDisposition, ForwardDispositionSummary> = {
  awaiting_owner: {
    label: "blocked on you",
    ownerActionNeeded: true,
    title:
      "A coverage gap is blocked on open owner attention (such as re-auth or a prompt). A run cannot make progress until you act; open the connection's attention to resolve it.",
    tone: "warning",
    value: "awaiting_owner",
  },
  checking: {
    label: "checking coverage",
    ownerActionNeeded: false,
    title:
      "Active work is expected to produce coverage evidence. This is a checking state, not an owner-action prompt.",
    tone: "neutral",
    value: "checking",
  },
  complete: {
    label: "nothing owed",
    ownerActionNeeded: false,
    title:
      "Coverage is established and fresh. A future run re-checks the source but is not expected to collect anything new or fill a gap.",
    tone: "success",
    value: "complete",
  },
  owner_refresh_due: {
    label: "refresh due",
    ownerActionNeeded: true,
    title:
      "Coverage is complete but the retained data has gone stale, and this connection needs an owner-initiated run to refresh — either because it refreshes only when you run it, or because it refreshes on schedule but may need your bounded help to catch up. Start a run on your instance to bring it current. This is aged data, not missing data.",
    tone: "warning",
    value: "owner_refresh_due",
  },
  resumable: {
    label: "resumes collection",
    ownerActionNeeded: false,
    title:
      "There is outstanding work an ordinary future run is expected to pick up — an open boundary or retryable gap. Records already collected stay valid; no owner action is needed.",
    tone: "warning",
    value: "resumable",
  },
  terminal: {
    label: "won't backfill",
    ownerActionNeeded: false,
    title:
      "An outstanding gap will not backfill on its own — the source or connector cannot recover it without a change. Records already collected stay valid and usable; open the latest run to see which streams are affected.",
    tone: "danger",
    value: "terminal",
  },
  unmeasured: {
    label: "not measured",
    ownerActionNeeded: false,
    title:
      "Coverage evidence is not available in the latest report. This is not an owner-action prompt and not an active checking state.",
    tone: "neutral",
    value: "unmeasured",
  },
};

/**
 * Format the connection-level forward disposition for display. Returns `null`
 * when the reference did not supply the field (e.g. a reference predating
 * `define-connector-progress-evidence-contract`), so the console renders nothing
 * rather than inventing a disposition. An unrecognized value is surfaced
 * honestly as a neutral "unknown to this console" line rather than dropped.
 */
export function formatForwardDisposition(
  disposition: RefForwardDisposition | null | string | undefined,
  options: { coverageReportedCollected?: boolean } = {}
): ForwardDispositionSummary | null {
  if (disposition === null || disposition === undefined) {
    return null;
  }
  if (disposition === "complete" && options.coverageReportedCollected === true) {
    return {
      ...FORWARD_DISPOSITION_LABELS.complete,
      label: "nothing owed (reported)",
      title:
        "The connector reports it collected everything and nothing in the run contradicts that. PDP Connect has not independently checked coverage; a future run re-checks the source.",
      tone: "neutral",
    };
  }
  if (disposition !== undefined && Object.hasOwn(FORWARD_DISPOSITION_LABELS, disposition)) {
    return FORWARD_DISPOSITION_LABELS[disposition as RefForwardDisposition];
  }
  return {
    label: "unknown",
    ownerActionNeeded: false,
    title: `The reference reported a forward disposition "${disposition}" this console does not recognize.`,
    tone: "neutral",
    value: disposition as RefForwardDisposition,
  };
}

export interface ProjectionFreshness {
  /** Hover/title text listing the unknown reasons. */
  detail: string;
  reasons: readonly string[];
  /** True when the spine told us evidence was missing or stale. */
  unreliable: boolean;
}

export interface DominantConditionSummary {
  label: string;
  title: string;
  tone: EvidenceTone;
}

export function formatDominantCondition(
  snapshot: RefConnectionHealthSnapshot | null | undefined
): DominantConditionSummary | null {
  const condition = dominantCondition(snapshot);
  if (condition?.status !== "false") {
    return null;
  }
  const remediation = condition.remediation?.label ? ` ${condition.remediation.label}.` : "";
  return {
    label: condition.message,
    title: `${humanizeReason(condition.reason)}. ${condition.message}.${remediation}`.trim(),
    tone: toneForConditionSeverity(condition.severity),
  };
}

/**
 * Owner-facing labels for the `ConnectionConditionType` enum. The reference
 * emits CamelCase enum keys (`BacklogClear`); rendering those verbatim leaked an
 * internal identifier into the diagnostics list. Unlisted types fall back to a
 * CamelCase split so a new reference condition degrades to "Some New Check"
 * rather than disappearing or throwing.
 */
const CONDITION_TYPE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  AttentionClear: "Attention clear",
  BacklogClear: "Backlog clear",
  CollectionSucceeded: "Collection succeeded",
  CredentialContinuity: "Credential continuity",
  CredentialsValid: "Credentials valid",
  Fresh: "Fresh",
  LocalExporterAvailable: "Local exporter available",
  ProjectionReliable: "Projection reliable",
  RemoteSurfaceAvailable: "Remote surface available",
  RetryPolicyClear: "Retry policy clear",
  RuntimeAvailable: "Runtime available",
  ScheduleEligible: "Schedule eligible",
  SourceCoverageComplete: "Source coverage complete",
});

/** Owner-facing labels for the condition status enum. */
const CONDITION_STATUS_LABELS: Readonly<Record<string, string>> = Object.freeze({
  false: "No",
  not_applicable: "Not applicable",
  true: "Yes",
  unknown: "Unknown",
});

export function conditionTypeLabel(type: string): string {
  const known = CONDITION_TYPE_LABELS[type];
  if (known) {
    return known;
  }
  // Split CamelCase into words, then sentence-case the result.
  const split = type.replace(/([a-z0-9])([A-Z])/g, "$1 $2").trim();
  if (split.length === 0) {
    return type;
  }
  return `${split.charAt(0).toUpperCase()}${split.slice(1).toLowerCase()}`;
}

export function conditionStatusLabel(status: string): string {
  return CONDITION_STATUS_LABELS[status] ?? humanizeReason(status);
}

export interface SupportingConditionSummary {
  id: string;
  label: string;
  message: string;
  status: string;
  statusLabel: string;
  title: string;
}

/**
 * View model for one row of the diagnostics supporting-condition list.
 *
 * Three prior defects are fixed here rather than in JSX: the raw enum key is
 * mapped to a label, the raw snake_case reason is humanized before it reaches
 * the tooltip, and `message` is carried for EVERY status. Previously `message`
 * rendered only when the status was `false`, which dropped the one
 * human-readable field exactly on the healthy connections where the bare
 * "Unknown" was least self-explanatory.
 */
export function formatSupportingCondition(condition: {
  id: string;
  message: string;
  reason: string;
  remediation?: { label?: string | null } | null;
  status: string;
  type: string;
}): SupportingConditionSummary {
  const remediation = condition.remediation?.label ? ` ${condition.remediation.label}.` : "";
  const message = condition.message.trim();
  const title = `${humanizeReason(condition.reason)}.${message ? ` ${message}` : ""}${remediation}`.trim();
  return {
    id: condition.id,
    label: conditionTypeLabel(condition.type),
    message,
    status: condition.status,
    statusLabel: conditionStatusLabel(condition.status),
    title,
  };
}

function dominantCondition(snapshot: RefConnectionHealthSnapshot | null | undefined) {
  const conditions = snapshot?.conditions ?? [];
  const dominantId = snapshot?.dominant_condition_id ?? null;
  if (dominantId) {
    const found = conditions.find((condition) => condition.id === dominantId);
    if (found) {
      return found;
    }
  }
  return conditions.find((condition) => condition.status === "false") ?? null;
}

function toneForConditionSeverity(severity: string): EvidenceTone {
  if (severity === "blocked" || severity === "error") {
    return "danger";
  }
  if (severity === "warning") {
    return "warning";
  }
  return "neutral";
}

/**
 * Whether the projection itself is unreliable. The reference signals
 * this by setting `state === "unknown"` AND populating
 * `unknown_reasons`. We separate the two so the dashboard can warn
 * about partial unreliability (e.g. a schedule read failed) even when
 * the projection is otherwise usable.
 */
export function formatProjectionFreshness(
  snapshot: RefConnectionHealthSnapshot | null | undefined
): ProjectionFreshness {
  // A connector-reported coverage is a labelled report, not missing evidence.
  const reasons = (snapshot?.unknown_reasons ?? []).filter((reason) => reason !== COVERAGE_REPORTED_COLLECTED_REASON);
  if (reasons.length === 0) {
    return { detail: "", reasons: [], unreliable: false };
  }
  const humanized = reasons.map(humanizeReason);
  return {
    detail: `Projection evidence missing: ${humanized.join(", ")}.`,
    reasons: humanized,
    unreliable: true,
  };
}

export function humanizeReason(reason: string): string {
  const cleaned = reason.trim();
  if (cleaned.length === 0) {
    return reason;
  }
  return cleaned.replace(/[_-]+/g, " ");
}

/**
 * Operator remediation for a stalled local-device outbox.
 *
 * The reference projects `outbox === "stalled"` and a `clear_backlog`
 * condition (with a `remediation.label`) when retryable outbound work on a
 * local collector host is no longer progressing. The dashboard cannot fix a
 * device-local outbox remotely — only the operator, on the host, can. So this
 * helper turns that projection into a *visible* next step:
 *
 *   - the reference's own `remediation.label` as readable copy (today it only
 *     appears in hover/title text), and
 *   - a deterministic, non-secret local command the operator runs on the host.
 *
 * It returns `null` for healthy / idle / active / unknown outboxes so we never
 * add remediation noise to a connection that is fine or whose state we cannot
 * read. The trigger is intentionally narrow: a stalled outbox axis, or a
 * current `clear_backlog` remediation that the projection surfaced as a
 * blocking condition.
 */
export interface OutboxStallRemediation {
  /** The reference-authored operator copy, e.g. "Inspect the local collector backlog". */
  label: string;
  /**
   * The condition reason backing the remediation, humanized for a tooltip.
   * Null when the trigger was the outbox axis alone (no matching condition).
   */
  reason: string | null;
  /**
   * Count-backed scale of the stuck work, when the connection summary
   * carries a rollup of the device-reported outbox diagnostics. `null` when
   * no counts are available, so the panel never renders a misleading "0
   * records" or implies precision the reference did not provide.
   */
  scale: string | null;
}

/**
 * Render the device-reported outbox count rollup as one short operator line,
 * e.g. "12 pending · 2 failed uploads · 1 stale lease". Only the
 * decision-relevant, non-zero categories are shown so a healthy-but-counted
 * rollup does not read as alarming. Returns `null` when the rollup is absent
 * or carries no positive counts.
 */
function formatOutboxCountScale(counts: RefLocalDeviceProgress["outbox_counts"] | null | undefined): string | null {
  if (!counts) {
    return null;
  }
  const parts: string[] = [];
  const pending = counts.pending ?? 0;
  const retrying = counts.retrying ?? 0;
  const staleLeases = counts.stale_leases ?? 0;
  const deadLetter = counts.dead_letter ?? 0;
  const backlog = counts.backlog_open ?? 0;
  if (pending > 0) {
    parts.push(`${pending.toLocaleString()} pending`);
  }
  if (retrying > 0) {
    parts.push(`${retrying.toLocaleString()} retrying`);
  }
  if (staleLeases > 0) {
    parts.push(`${staleLeases.toLocaleString()} stale lease${staleLeases === 1 ? "" : "s"}`);
  }
  if (deadLetter > 0) {
    parts.push(`${deadLetter.toLocaleString()} failed upload${deadLetter === 1 ? "" : "s"}`);
  }
  if (backlog > 0) {
    parts.push(`${backlog.toLocaleString()} backlog`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

export function summarizeOutboxStallRemediation(
  snapshot: RefConnectionHealthSnapshot | null | undefined,
  localDeviceProgress?: RefLocalDeviceProgress | null
): OutboxStallRemediation | null {
  if (!snapshot) {
    return null;
  }
  const backlogCondition = (snapshot.conditions ?? []).find(
    (condition) => condition.status === "false" && condition.remediation?.action === "clear_backlog"
  );
  if (!backlogCondition) {
    return null;
  }

  // Render recovery only from the server-owned control action. A raw stalled
  // axis can lag terminal reconciliation and should not create a recovery loop.
  const label = backlogCondition.remediation?.label ?? "Inspect the local collector backlog";
  return {
    label,
    reason: humanizeReason(backlogCondition.reason),
    // Count-backed scale is only ever attached to the stalled-remediation
    // path. Healthy / idle / active / unknown outboxes return `null` above, so
    // counts never appear on a quiet connection.
    scale: formatOutboxCountScale(localDeviceProgress?.outbox_counts),
  };
}

/**
 * Heartbeat chip for one source instance.
 *
 * Reads the server-derived `heartbeat_health`, NEVER the raw
 * `last_heartbeat_status`. The collector is one-shot, so nothing rewrites that
 * column when the process dies: a collector killed mid-run left `starting`
 * there and the dashboard reported an actively-starting collector for 38
 * hours. Past the lease, `heartbeat_health` is `stale` and the last observed
 * status moves into the title as clearly-dated evidence.
 */
export function formatSourceHeartbeat(
  source: Pick<DeviceSourceInstance, "heartbeat_health" | "heartbeat_lease_ms" | "last_heartbeat_status">
): AxisChip {
  const health = source.heartbeat_health ?? "unknown";
  const observed = source.last_heartbeat_status ?? null;
  if (health === "stale") {
    return {
      dimension: "Heartbeat",
      label: "Heartbeat · stale",
      title: observed
        ? `Last reported "${observed}", but that check-in is older than the ${formatLeaseWindow(source.heartbeat_lease_ms)} lease, so it no longer describes the collector's current state.`
        : `No check-in within the ${formatLeaseWindow(source.heartbeat_lease_ms)} lease.`,
      tone: "warning",
      value: "stale",
    };
  }
  if (health === "unknown") {
    return {
      dimension: "Heartbeat",
      label: "Heartbeat · unknown",
      title: "No usable heartbeat has been recorded for this source.",
      tone: "neutral",
      value: "unknown",
    };
  }
  return {
    dimension: "Heartbeat",
    label: `Heartbeat · ${health}`,
    title: `Reported within the ${formatLeaseWindow(source.heartbeat_lease_ms)} lease.`,
    tone: health === "blocked" ? "danger" : "neutral",
    value: health,
  };
}

/** Render the declared lease as a human window for the heartbeat explanation. */
function formatLeaseWindow(leaseMs: number | undefined): string {
  if (!leaseMs || leaseMs <= 0) {
    return "configured";
  }
  const minutes = Math.round(leaseMs / 60_000);
  if (minutes < 60) {
    return `${minutes}-minute`;
  }
  return `${Math.round(minutes / 60)}-hour`;
}

export function formatSourceOutboxState(
  source: Pick<DeviceSourceInstance, "outbox_diagnostics" | "outbox_state">
): AxisChip {
  const state = source.outbox_state ?? "unknown";
  const diagnostics = source.outbox_diagnostics ?? null;
  const counts = diagnostics
    ? [
        `pending ${diagnostics.pending ?? 0}`,
        `retrying ${diagnostics.retrying ?? 0}`,
        `stale ${diagnostics.stale_leases ?? 0}`,
        `failed upload ${diagnostics.dead_letter ?? 0}`,
        `backlog ${diagnostics.backlog_open ?? 0}`,
      ].join(" · ")
    : "no granular outbox diagnostics reported";

  switch (state) {
    case "dead_letter":
      return {
        dimension: "Outbox",
        label: "Outbox · failed uploads",
        title: counts,
        tone: "danger",
        value: "failed uploads",
      };
    case "stale":
      return {
        dimension: "Outbox",
        label: "Outbox · stale lease",
        title: counts,
        tone: "danger",
        value: "stale lease",
      };
    case "retrying":
      return { dimension: "Outbox", label: "Outbox · retrying", title: counts, tone: "warning", value: "retrying" };
    case "pending":
      return { dimension: "Outbox", label: "Outbox · pending", title: counts, tone: "neutral", value: "pending" };
    case "backlog":
      return { dimension: "Outbox", label: "Outbox · backlog", title: counts, tone: "warning", value: "backlog" };
    case "drained":
      return { dimension: "Outbox", label: "Outbox · drained", title: counts, tone: "success", value: "drained" };
    // B2: "no evidence taken" uses ONE owner-facing word everywhere.
    case "unknown":
      return {
        dimension: "Outbox",
        label: "Outbox · not measured",
        title: counts,
        tone: "neutral",
        value: "not measured",
      };
    default:
      return {
        dimension: "Outbox",
        label: "Outbox · not measured",
        title: counts,
        tone: "neutral",
        value: "not measured",
      };
  }
}

export interface ScheduleSummary {
  /** Concise backoff blurb (only set when scheduler_backoff applies). */
  backoffLabel: string | null;
  enabled: boolean;
  /** Ineligibility reason if the schedule is enabled but ineligible. */
  ineligibilityReason: string | null;
  /** Effective mode (automatic | manual | paused). */
  mode: RefSchedule["effective_mode"];
  /** Concise next-attempt blurb, e.g. "Next attempt 3 min from now". */
  nextAttemptLabel: string | null;
}

export function summarizeSchedule(schedule: RefSchedule | null | undefined): ScheduleSummary | null {
  if (!schedule) {
    return null;
  }
  const backoff = schedule.scheduler_backoff;
  let backoffLabel: string | null = null;
  if (backoff?.backoff_applied) {
    if (backoff.reason_class === "source_pressure") {
      // A cross-run source-pressure cooldown is not a failure streak: the run
      // succeeded and deferred the rest as resumable gaps under upstream
      // throttling. Naming "N consecutive failures" here (which is 0) would be
      // misleading. Describe the cooldown honestly instead.
      backoffLabel = "Cooling off under source pressure · captured progress retained";
    } else {
      const reason = backoff.reason_class ? ` (${backoff.reason_class.replace(/[_-]+/g, " ")})` : "";
      const failures = backoff.consecutive_failures;
      backoffLabel = `Backoff applied${reason} · ${failures} consecutive failure${failures === 1 ? "" : "s"}`;
    }
  }
  return {
    backoffLabel,
    enabled: schedule.enabled,
    ineligibilityReason: schedule.ineligibility_reason,
    mode: schedule.effective_mode,
    nextAttemptLabel: schedule.next_due_at ? `Next attempt ${schedule.next_due_at}` : null,
  };
}

export interface RecordCountDisplay {
  /** What to render in the row. `null` = render an em-dash placeholder. */
  label: string | null;
  /** True when the underlying count is honest. */
  reliable: boolean;
  title: string;
}

/**
 * Resolve how to display the records count for a connector row.
 *
 * The crucial honest-by-default rule: when the overview reports an
 * evidence-collection error, do NOT render `0`. Render a placeholder
 * and a hover tooltip explaining why. Sol fourth-verdict P1.3: the same
 * rule applies when `totalRecordsState` reports a non-authoritative
 * (`stale`/`unobserved`/`unknown`) snapshot — a carried-over number,
 * including a carried-over ZERO, must never render as `reliable: true`.
 *
 * Also: when the connection projection is `unknown`, the records count
 * we see may not yet be consistent with the spine. Surface that as a
 * tooltip but still render the numeric count (records-in-store is
 * canonical evidence, not a projection).
 */
export function resolveRecordCountDisplay(overview: ConnectorOverview): RecordCountDisplay {
  if (overview.error) {
    return {
      label: null,
      reliable: false,
      title: `Records count unavailable: ${overview.error}`,
    };
  }
  if (!isTotalRecordsAuthoritative(overview.totalRecordsState)) {
    return {
      label: formatTotalRecordsLabel(overview.totalRecords, overview.totalRecordsState, "records"),
      reliable: false,
      title: `Records count unverified: the latest snapshot is ${overview.totalRecordsState}`,
    };
  }
  return {
    label: overview.totalRecords.toLocaleString(),
    reliable: true,
    title: `${overview.totalRecords.toLocaleString()} records ingested`,
  };
}

/**
 * The reason code the reference projects onto a `cooling_off` connection when
 * the pause is a cross-run **source-pressure cooldown** (the scheduler is
 * deferring the next automatic attempt because the connection still has pending
 * retryable source-pressure detail gaps), not a failure streak. It is the
 * `reason_class` the reference's `mergeBackoffAndCooldown` stamps when the
 * cooldown governor — not failure back-off — is the sole driver. Connector-
 * agnostic: any connector that defers work under upstream pressure surfaces it.
 */
const SOURCE_PRESSURE_REASON_CODE = "source_pressure";

/**
 * The honest primary action for a records row.
 *
 * The owner-triggered sync action starts an owner-controlled connector run.
 * Existing browser-bound connections are owner-runnable: if they need browser
 * assistance, the run timeline surfaces that after start. The class that remains
 * non-clickable here is push-mode / local-collector connections (those with
 * `localDeviceProgress`): they fill in when their local-collector device pushes
 * a batch, and there is no remote pull to start.
 *
 * Everything else keeps the clickable sync action; the visible label may read
 * `Retry sync` when the most recent attempt failed or was cancelled.
 *
 * Pure and JSX-free so the row stays thin and this is unit-testable without a
 * browser harness.
 */
export type PrimaryRowAction =
  | { kind: "sync" }
  | { kind: "cooldown_wait"; detail: string; label: string }
  | { kind: "device_wait"; detail: string; label: string };

export type SyncActionIdleLabel = "Retry sync" | "Sync now";

/**
 * Owner-facing label for the owner-triggered sync action while no run is
 * active. A failed/cancelled last attempt should read as recovery, not as a
 * fresh first-time action; the underlying endpoint is the same.
 */
export function syncActionIdleLabel(lastRunStatus: string | null | undefined): SyncActionIdleLabel {
  if (lastRunStatus === "failed" || lastRunStatus === "cancelled" || lastRunStatus === "canceled") {
    return "Retry sync";
  }
  return "Sync now";
}

/**
 * Owner-facing lead sentence for a failed `Sync now`, keyed on whether the
 * run-start request reached the reference server.
 *
 * `before_server` — the request never reached the server (network / deployment
 * down): the run definitely did not start; the owner should check their
 * deployment. `after_server` — the server responded with an error: the run
 * did not start, but the cause is the server's (the full message carries its
 * reason). Keeping this pure and JSX-free lets both the records row and the
 * connection detail page render identical, tested copy without a browser
 * harness, and keeps a run-start failure a row-local toast — never a fall
 * through to the dashboard error boundary.
 */
export function syncStartFailureLead(phase: "before_server" | "after_server"): string {
  if (phase === "before_server") {
    return "Couldn't reach the reference server, so the sync did not start.";
  }
  return "The reference server rejected the sync, so it did not start.";
}

// ─── What's wrong? expander ───────────────────────────────────────────────────

/**
 * Structured failure summary for the "What's wrong?" expander on the
 * connector detail page.
 *
 * Shown only when health is degraded, cooling_off, blocked, or needs_attention.
 * The expander's trigger label follows design decision 9 in the mocks:
 * `degraded` opens "What's missing?"; everything else opens "What's wrong?".
 *
 * Pure and JSX-free so it can be unit-tested without a browser harness.
 */
export interface FailureSummary {
  /** Label for the primary CTA/status line. Current references source this from `RenderedVerdict.required_actions[0].cta`. */
  actionLabel: string | null;
  /**
   * Primary remediation CTA.
   * - `connection_detail` → link to the connection detail page using `actionLabel`
   * - `reconnect` → legacy link to the connection detail page (credential/browser failures)
   * - `view_runs` → link to the runs list (protocol failures, gaps)
   * - `wait` → informational, no link (cooling_off in back-off)
   */
  cta: "connection_detail" | "reconnect" | "view_runs" | "wait";
  /** ISO timestamp of the last known success. */
  lastSuccessAt: string | null;
  /** next_attempt_at from the health snapshot — when the next retry fires. */
  nextAttemptAt: string | null;
  /** True only when the owner is the sole resolution and the card should count under "need your hand". */
  ownerActionRequired: boolean;
  /**
   * One or two prose sentences the operator reads first. Plain English, no
   * codes. Current references source this from `RenderedVerdict.forward_statement`.
   */
  prose: string;
  /** reason_code to show in the fact box, or null when absent. */
  reasonCode: string | null;
  /** Button label for the collapsed expander. */
  triggerLabel: "What's missing?" | "What's wrong?";
}

function renderedActionIsOwnerSatisfiable(action: RefRequiredAction | null): boolean {
  return Boolean(action && action.audience === "owner" && action.satisfied_when.kind !== "none");
}

function triggerLabelFromRenderedVerdict(verdict: RefRenderedVerdict): FailureSummary["triggerLabel"] {
  return verdict.channel === "attention" || verdict.pill.tone === "red" ? "What's wrong?" : "What's missing?";
}

function deriveRenderedFailureSummary(
  health: RefConnectionHealthSnapshot,
  verdict: RefRenderedVerdict
): FailureSummary | null {
  const primaryAction = verdict.required_actions[0] ?? null;
  const ownerAction = renderedActionIsOwnerSatisfiable(primaryAction);
  const statusAction = primaryAction !== null && !ownerAction && primaryAction.kind !== "wait";

  if (verdict.channel === "calm" && !ownerAction && !statusAction) {
    return null;
  }

  let cta: FailureSummary["cta"] = "view_runs";
  if (ownerAction) {
    cta = "connection_detail";
  } else if (statusAction || primaryAction?.kind === "wait") {
    cta = "wait";
  }

  // A device-local recovery (stalled outbox: the owner runs commands on the host
  // that holds the data) is NOT performed by clicking — the button only NAVIGATES
  // to where the commands are shown. Restating the device-local recovery action
  // on a navigating button makes the owner click it expecting it to act, which
  // just routes them in a circle. So when the action
  // is device-local, the navigable label is an honest "See recovery steps", and
  // it routes to the connection detail page where the commands live.
  const isDeviceLocalRecovery = primaryAction?.remediation?.target.kind === "local_device";
  if (isDeviceLocalRecovery && cta === "connection_detail") {
    return {
      actionLabel: "See recovery steps",
      cta,
      lastSuccessAt: health.last_success_at,
      nextAttemptAt: health.next_attempt_at,
      ownerActionRequired: verdict.channel === "attention",
      prose: verdict.forward_statement,
      reasonCode: health.reason_code,
      triggerLabel: triggerLabelFromRenderedVerdict(verdict),
    };
  }

  return {
    actionLabel: primaryAction?.cta ?? (cta === "view_runs" ? "View runs" : null),
    cta,
    lastSuccessAt: health.last_success_at,
    nextAttemptAt: health.next_attempt_at,
    ownerActionRequired: ownerAction && verdict.channel === "attention",
    prose: verdict.forward_statement,
    reasonCode: health.reason_code,
    triggerLabel: triggerLabelFromRenderedVerdict(verdict),
  };
}

/**
 * Derive a `FailureSummary` from the server-owned rendered verdict.
 *
 * A raw `connection_health` snapshot is evidence for timestamps and diagnostic
 * facts only. It is not a fallback classifier: without the server-rendered
 * verdict there is no client-side failure summary to render.
 *
 * Returns `null` for states that do not warrant an expander (`healthy`,
 * `idle`, `unknown`).
 */
export function deriveFailureSummary(
  health: RefConnectionHealthSnapshot | null | undefined,
  renderedVerdict?: RefRenderedVerdict | null
): FailureSummary | null {
  if (!(health && renderedVerdict)) {
    return null;
  }
  return deriveRenderedFailureSummary(health, renderedVerdict);
}

// ─── 14-day streak strip ──────────────────────────────────────────────────────

/** Symbol and tone for one run in the streak strip. */
export interface StreakDot {
  /** ISO timestamp used for the title tooltip. */
  at: string;
  /** Human-readable status for the title tooltip. */
  statusLabel: string;
  /** Unicode symbol for the dot. */
  symbol: "✓" | "⚠" | "✕" | "⊘" | "⏸";
  tone: "success" | "warning" | "danger" | "neutral";
}

/**
 * Derive streak dots from an array of run summaries (newest-first).
 *
 * Symbols follow design decision 8 in the mocks: `✓ ⚠ ✕ ⊘ ⏸`.
 * Limited to the most recent 14 runs to keep the strip compact.
 *
 * Pure and JSX-free so it can be unit-tested without a browser harness.
 */
export function deriveStreakDots(
  runs: readonly { status: string; first_at: string; failure_reason?: string | null }[]
): StreakDot[] {
  return runs.slice(0, 14).map((r): StreakDot => {
    const s = r.status;
    if (s === "succeeded_with_gaps") {
      return { at: r.first_at, statusLabel: "Succeeded with gaps", symbol: "⚠", tone: "warning" };
    }
    if (s === "succeeded" || s === "success" || s === "completed") {
      return { at: r.first_at, statusLabel: "Succeeded", symbol: "✓", tone: "success" };
    }
    if (s === "failed" || s === "error") {
      return { at: r.first_at, statusLabel: r.failure_reason ?? "Failed", symbol: "✕", tone: "danger" };
    }
    if (s === "cancelled" || s === "canceled") {
      return { at: r.first_at, statusLabel: "Cancelled", symbol: "⊘", tone: "neutral" };
    }
    if (s === "paused" || s === "skipped") {
      return { at: r.first_at, statusLabel: "Skipped", symbol: "⏸", tone: "neutral" };
    }
    if (s === "degraded" || s === "partial") {
      return { at: r.first_at, statusLabel: "Partial", symbol: "⚠", tone: "warning" };
    }
    // in_progress / started — not shown in a historical strip but included
    // defensively so the map never throws.
    return { at: r.first_at, statusLabel: s.replace(/_/g, " "), symbol: "⚠", tone: "neutral" };
  });
}

export function summarizeStreakDots(dots: readonly StreakDot[]): string {
  const failureCount = dots.filter((d) => d.tone === "danger").length;
  const partialCount = dots.filter((d) => d.tone === "warning").length;
  const parts: string[] = [];
  if (failureCount > 0) {
    parts.push(`${failureCount} failure${failureCount === 1 ? "" : "s"}`);
  }
  if (partialCount > 0) {
    parts.push(`${partialCount} with gaps`);
  }
  return parts.length > 0 ? parts.join(" · ") : "0 failures";
}

// ─── Auto-paused banner ───────────────────────────────────────────────────────

/**
 * Derive the auto-paused banner data from the schedule's backoff field.
 *
 * Returns `null` when no backoff is active, so callers can conditionally
 * render the banner without duplicating the predicate.
 *
 * Pure and JSX-free so it can be unit-tested without a browser harness.
 */
export interface AutoPausedBanner {
  /** Number of consecutive failures that triggered the back-off. */
  consecutiveFailures: number;
  /**
   * Whether the recommended_health_state says `blocked` (gave up / terminal)
   * vs `cooling_off` (back-off, will retry).
   */
  isTerminal: boolean;
  /** ISO timestamp for when the next attempt will fire, or null. */
  nextRunAt: string | null;
  /** reason_class from the backoff, humanized for display. */
  reasonLabel: string | null;
}

export function deriveAutoPausedBanner(
  schedule:
    | {
        scheduler_backoff: {
          backoff_applied: boolean;
          consecutive_failures: number;
          next_run_at: string | null;
          reason_class: string | null;
          recommended_health_state: "blocked" | "cooling_off" | null;
        } | null;
      }
    | null
    | undefined
): AutoPausedBanner | null {
  const backoff = schedule?.scheduler_backoff;
  if (!backoff?.backoff_applied) {
    return null;
  }
  return {
    consecutiveFailures: backoff.consecutive_failures,
    isTerminal: backoff.recommended_health_state === "blocked",
    nextRunAt: backoff.next_run_at,
    reasonLabel: backoff.reason_class ? backoff.reason_class.replace(/[_-]+/g, " ") : null,
  };
}

export function derivePrimaryRowAction(input: {
  connectorId: string | null | undefined;
  health?: RefConnectionHealthSnapshot | null;
  /** True when the reference has a push-mode local-device progress row for this connection. */
  hasLocalDeviceProgress: boolean;
}): PrimaryRowAction {
  const { hasLocalDeviceProgress, health } = input;
  if (hasLocalDeviceProgress) {
    return {
      detail:
        "This connection fills in when its local-collector device pushes new data — the dashboard cannot start a run. Confirm the collector is running on the host that holds the data.",
      kind: "device_wait",
      label: "Waiting for the local device",
    };
  }

  if (health?.state === "cooling_off" && health.reason_code === SOURCE_PRESSURE_REASON_CODE) {
    return {
      detail: health.next_attempt_at
        ? `This source is throttling PDPP, so the next ordinary sync waits until ${health.next_attempt_at}. Captured progress is retained.`
        : "This source is throttling PDPP, so ordinary sync is paused until the next scheduled retry. Captured progress is retained.",
      kind: "cooldown_wait",
      label: "Cooling off",
    };
  }

  const sourcePressureBacklog = health?.detail_gap_backlog;
  if (sourcePressureBacklog && sourcePressureBacklog.pending > 0) {
    const pending = `${sourcePressureBacklog.pending_is_floor ? "at least " : ""}${sourcePressureBacklog.pending.toLocaleString()}`;
    return {
      detail: `This connection has ${pending} pending provider-pressure gap${
        sourcePressureBacklog.pending === 1 ? "" : "s"
      }, so ordinary sync may be rejected by the provider-pressure cooldown. Captured progress is retained.`,
      kind: "cooldown_wait",
      label: "Cooling off",
    };
  }

  return { kind: "sync" };
}

export interface CollectionRateReadout {
  /** "last backed off to Xms (reason)" or null when no back-off has fired. */
  backoffLabel: string | null;
  /** "ceiling N/min" sub-line. */
  ceilingLabel: string;
  /** "current N/min" headline. */
  currentLabel: string;
}

/**
 * Format the adaptive collection rate controller's state into the small
 * operator-facing readout the diagnostics panel renders. Returns null when no
 * controller state is available — the caller then shows an explicit unknown,
 * never a false zero or a false green (honest-by-default).
 */
export function formatCollectionRateReadout(
  rate: RefCollectionRateSnapshot | null | undefined
): CollectionRateReadout | null {
  if (!rate) {
    return null;
  }
  if (
    !(
      Number.isFinite(rate.ceiling_interval_ms) &&
      Number.isFinite(rate.ceiling_rate_per_min) &&
      Number.isFinite(rate.current_interval_ms) &&
      Number.isFinite(rate.effective_rate_per_min)
    )
  ) {
    return null;
  }
  const backoff = rate.last_backoff;
  const backoffLabel =
    backoff &&
    typeof backoff.at_interval_ms === "number" &&
    Number.isFinite(backoff.at_interval_ms) &&
    typeof backoff.reason === "string"
      ? `last backed off to ${backoff.at_interval_ms.toLocaleString()}ms (${backoff.reason})`
      : null;
  return {
    backoffLabel,
    ceilingLabel: `ceiling ${rate.ceiling_rate_per_min.toLocaleString()}/min · interval ${rate.ceiling_interval_ms.toLocaleString()}ms`,
    currentLabel: `${rate.effective_rate_per_min.toLocaleString()}/min · interval ${rate.current_interval_ms.toLocaleString()}ms`,
  };
}
