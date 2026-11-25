// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { formatStreamCollectionFacts, type StreamCollectionFacts } from "../../lib/collection-report.ts";
import type {
  DeviceSourceInstance,
  RefCollectionReportEntry,
  RefConnectionHealthSnapshot,
  RefConnectorRunSummary,
  RefConnectorSummary,
  RefRenderedVerdict,
  RefRequiredAction,
  RefSchedule,
  RunSummary,
} from "../../lib/ref-client.ts";
import type { StreamSummary } from "../../lib/rs-client.ts";
import { type SourceStatusRow, sourceStatusWords } from "../../lib/source-status-words.ts";
import type { ConnectorPageModel } from "./page.tsx";

const DEMO_NOW = new Date("2026-11-24T12:00:00.000Z");
const DEMO_SUCCESS = "2026-11-24T10:00:00.000Z";

function toRunRef(summary: RefConnectorRunSummary | null) {
  if (!summary) {
    return null;
  }
  return {
    event_count: summary.event_count,
    failure_reason: summary.failure_reason,
    first_at: summary.first_at,
    known_gaps: summary.known_gaps,
    last_at: summary.last_at,
    run_id: summary.run_id,
    status: summary.status,
  };
}

export function buildRecoveryDemoModel(
  statusRow: SourceStatusRow = 16,
  includePendingDetails = statusRow === 16
): ConnectorPageModel {
  const connectionId = "cin_demo_claude_code_workstation";
  const run: RunSummary = {
    connection_id: connectionId,
    connector_id: "claude-code",
    connector_instance_id: connectionId,
    event_count: 14,
    failure_reason: "local collector outbox has dead-lettered rows",
    first_at: "2026-07-01T11:15:00.000Z",
    grant_id: null,
    kinds: ["messages"],
    last_at: "2026-07-01T11:18:00.000Z",
    needs_input: false,
    object: "run_summary",
    run_id: "run_demo_recovery",
    status: "failed",
  };
  const streams: StreamSummary[] = [
    {
      last_updated: "2026-07-01T10:40:00.000Z",
      name: "messages",
      object: "stream",
      record_count: 428,
    },
    {
      last_updated: "2026-06-30T17:12:00.000Z",
      name: "sessions",
      object: "stream",
      record_count: 36,
    },
  ];
  const collectionReport: RefCollectionReportEntry[] = [
    {
      checkpoint: "committed",
      collected: 24,
      considered: 27,
      coverage_condition: "retryable_gap",
      covered: 24,
      forward_disposition: "resumable",
      pending_detail_gaps: 3,
      skipped: null,
      stream: "messages",
    },
  ];
  const collectionFactsByStream = new Map<string, StreamCollectionFacts>(
    collectionReport.map((entry) => [entry.stream, formatStreamCollectionFacts(entry)])
  );
  const renderedVerdict: RefRenderedVerdict = {
    annotations: [{ kind: "freshness", text: "collector checked in 12 minutes ago" }],
    channel: "attention",
    detail: { suppressed: [] },
    forward_statement: "The local collector has saved records that did not upload to this server.",
    pill: { label: "Can't collect", tone: "red" },
    progress: {
      gaps_drained_last_run: null,
      headline: "3 local rows need recovery before collection can resume.",
      last_refreshed_at: "2026-07-01T12:00:00.000Z",
      mode: "local_device",
      records_committed_last_run: 24,
      retained_records: 464,
    },
    required_actions: [
      {
        affects: ["messages"],
        audience: "owner",
        cta: "See recovery steps",
        kind: "retry_gap",
        remediation: {
          cause: "dead_letter_backlog",
          commands: [
            {
              command_template: "npx -y @pdpp/local-collector doctor --source-instance-id <source-instance-id>",
              kind: "local_collector_doctor",
              label: "Inspect the local queue",
            },
            {
              command_template:
                "npx -y @pdpp/local-collector retry-dead-letters --source-instance-id <source-instance-id> --apply",
              kind: "local_collector_retry_dead_letters_apply",
              label: "Retry failed rows",
            },
          ],
          kind: "local_collector_recovery",
          label: "Recover local collector outbox",
          summary: "Run these on the workstation that owns this source.",
          target: { identity_source: "source_instance_bindings", kind: "local_device" },
        },
        satisfied_when: { kind: "gap_recovered" },
        terminal: false,
        urgency: "now",
      },
    ],
    streams: [
      {
        action_ref: 0,
        collected: 24,
        considered: 27,
        coverage: "retryable_gap",
        disposition: "resumable",
        statement: "24 collected; 3 local rows need retry.",
        stream_id: "messages",
      },
    ],
    trace: { demo: true },
  };
  const connectionHealth: RefConnectionHealthSnapshot = {
    axes: {
      attention: "open",
      coverage: "retryable_gap",
      freshness: "stale",
      outbox: "stalled",
    },
    badges: { stale: true, syncing: false },
    conditions: [
      {
        current: true,
        expires_at: null,
        id: "cond_demo_dead_letter",
        message: "The local collector reported dead-lettered rows.",
        observed_at: "2026-07-01T11:58:00.000Z",
        origin: "local_collector",
        reason: "dead_letter_backlog",
        remediation: {
          action: "retry_local_outbox",
          label: "Retry local outbox",
          retryable: true,
          target: "source_instance",
        },
        sensitivity: "owner",
        severity: "blocked",
        status: "true",
        type: "local_collector_dead_letter",
      },
    ],
    detail_gap_backlog: {
      max_attempt_count: 6,
      next_attempt_at: null,
      pending: 3,
      pending_is_floor: false,
      recovered: 0,
      terminal: 0,
    },
    dominant_condition_id: "cond_demo_dead_letter",
    forward_disposition: "awaiting_owner",
    last_success_at: "2026-07-01T10:40:00.000Z",
    next_action: null,
    next_attempt_at: null,
    reason_code: "local_collector_dead_letter",
    state: "needs_attention",
    supporting_condition_ids: ["cond_demo_dead_letter"],
    unknown_reasons: [],
  };
  const sourceInstances: DeviceSourceInstance[] = [
    {
      accepted_record_count: 464,
      connector_id: "claude-code",
      connector_instance_id: connectionId,
      created_at: "2026-06-24T12:00:00.000Z",
      device_id: "device_demo_workstation",
      display_name: "workstation",
      last_error: null,
      last_heartbeat_at: "2026-07-01T11:58:00.000Z",
      last_heartbeat_status: "ok",
      last_ingest_at: "2026-07-01T10:40:00.000Z",
      local_binding_name: "workstation",
      object: "device_source_instance",
      outbox_diagnostics: { dead_letter: 3, pending: 3, total: 27 },
      outbox_state: "dead_letter",
      records_pending: 3,
      rejected_record_count: 3,
      source_instance_id: "src_demo_workstation",
    },
  ];
  const overview = {
    collectionReport,
    connectionHealth,
    connectionId,
    connectionStatus: "active",
    connector: {
      connector_id: "claude-code",
      display_name: "Claude Code",
      name: "Claude Code",
      streams: [{ name: "messages" }, { name: "sessions" }],
    },
    connectorDisplayName: "Claude Code",
    connectorInstanceId: connectionId,
    isRunning: false,
    lastRun: toRunRef({
      event_count: run.event_count,
      failure_reason: run.failure_reason,
      finished_at: "2026-07-01T11:18:00.000Z",
      first_at: run.first_at,
      last_at: run.last_at,
      run_id: run.run_id,
      started_at: run.first_at,
      status: run.status,
    }),
    lastSuccessfulRun: toRunRef({
      event_count: 8,
      failure_reason: null,
      finished_at: "2026-07-01T10:40:00.000Z",
      first_at: "2026-07-01T10:39:00.000Z",
      last_at: "2026-07-01T10:40:00.000Z",
      run_id: "run_demo_previous_success",
      started_at: "2026-07-01T10:39:00.000Z",
      status: "succeeded",
    }),
    localDeviceProgress: {
      last_heartbeat_at: "2026-07-01T11:58:00.000Z",
      last_heartbeat_status: "ok",
      last_ingest_at: "2026-07-01T10:40:00.000Z",
      outbox_counts: { dead_letter: 3, pending: 3, total: 27 },
      records_pending: 3,
      source_count: 1,
    },
    streamCount: streams.length,
    streams,
    totalRecords: 464,
    totalRetainedBytes: null,
  };
  const model: ConnectorPageModel = {
    activeRunId: null,
    collectionFactsByStream,
    collectionOwnerActionByStream: { messages: true, sessions: true },
    // The demo fixture carries no configuration read. `null` renders the panel
    // as unavailable rather than inventing a schema this demo connector never
    // declared — the same honesty the live path keeps.
    configRevisions: [],
    configuration: null,
    connectionHealth,
    connectionId,
    connectionLabelSeed: "Claude Code workstation",
    connectionPrimaryAction: renderedVerdict.required_actions[0] ?? null,
    connectionRenderedVerdict: renderedVerdict,
    connectorId: "claude-code",
    connectorInstallKey: "claude-code",
    connectorInstanceId: connectionId,
    // A local-device source: the reference reports no install state for it.
    connectorNotInstalled: false,
    coverageAsOf: null,
    coverageHorizons: [],
    accountDeviceLabels: ["workstation"],
    deviceLabels: ["workstation"],
    displayName: "Claude Code workstation",
    headerCount: "464 records",
    latestKnownGaps: [],
    manifest: {
      connector_id: "claude-code",
      display_name: "Claude Code",
      name: "Claude Code",
      streams: [{ name: "messages" }, { name: "sessions" }],
    },
    manualUploadHref: null,
    overview,
    providerOrigin: "https://pdpp.example.test",
    recentRuns: [run],
    retainedStorage: { breakdown: "current 4.50 MB · history 1.20 MB", total: "5.70 MB" },
    schedule: null,
    scheduleError: null,
    setupFailed: false,
    sourceBindingKind: null,
    source: {
      connection_health: connectionHealth,
      connection_id: connectionId,
      connector_id: "claude-code",
      display_name: "Claude Code workstation",
      freshness: {},
      last_run: null,
      last_successful_run: null,
      manifest_version: null,
      next_action: null,
      owner_state: {
        evidence_as_of: connectionHealth.last_success_at,
        owner_of_state: "system",
        posture: "observed",
        resolver: "system_degraded",
      },
      rendered_verdict: renderedVerdict,
      schedule: null,
      source_kind: "local_device",
      status: "active",
      streams: ["messages", "sessions"],
      total_records: 464,
    } as RefConnectorSummary,
    sourceInstances,
    sourceInstancesError: null,
    streams,
    totalRecords: 464,
  };
  return applyStatusRow(model, statusRow, includePendingDetails);
}

export function withStatusDemoVariant(model: ConnectorPageModel, variant: string): ConnectorPageModel {
  let source = model.source;
  let sourceInstances = model.sourceInstances;
  const currentActions = source.rendered_verdict?.required_actions ?? [];

  if (variant === "no-server-action") {
    source = {
      ...source,
      rendered_verdict: source.rendered_verdict ? { ...source.rendered_verdict, required_actions: [] } : null,
    };
  } else if (variant === "failed-last-run") {
    source = {
      ...source,
      last_run: {
        event_count: 0,
        failure_reason: "The source did not return records.",
        finished_at: DEMO_SUCCESS,
        first_at: DEMO_SUCCESS,
        last_at: DEMO_SUCCESS,
        run_id: "run_demo_failed_without_rows",
        started_at: DEMO_SUCCESS,
        status: "failed",
      },
    };
  } else if (variant === "historical-archive") {
    source = { ...source, source_binding_kind: "historical_archive" };
  } else if (variant === "local-device") {
    source = { ...source, source_kind: "local_device" };
    sourceInstances = buildRecoveryDemoModel(1).sourceInstances;
  } else if (variant === "stored-credential" || variant === "provider-interaction" || variant === "owner-device") {
    const surface = variant === "stored-credential"
      ? "stored_credential"
      : variant === "provider-interaction"
        ? "provider_interaction"
        : "local_device";
    const label = variant === "stored-credential"
      ? "Update sign-in details"
      : variant === "provider-interaction"
        ? "Continue sign in"
        : "See device steps";
    source = {
      ...source,
      source_kind: variant === "owner-device" ? "local_device" : source.source_kind,
      rendered_verdict: source.rendered_verdict
        ? { ...source.rendered_verdict, required_actions: [ownerAction(label, "reauth", surface)] }
        : null,
    };
    if (variant === "owner-device") sourceInstances = buildRecoveryDemoModel(1).sourceInstances;
  } else if (variant !== "browser-session" && currentActions.length === 0) {
    return model;
  }

  const renderedVerdict = source.rendered_verdict ?? null;
  return {
    ...model,
    connectionPrimaryAction: renderedVerdict?.required_actions[0] ?? null,
    connectionRenderedVerdict: renderedVerdict,
    source,
    sourceBindingKind: source.source_binding_kind ?? null,
    sourceInstances,
  };
}

function statusSchedule(
  effectiveMode: RefSchedule["effective_mode"],
  backoff: RefSchedule["scheduler_backoff"] = null,
  nextDueAt: string | null = null
): RefSchedule {
  return {
    active_run_id: null,
    automation_mode: "unattended",
    automation_summary: effectiveMode === "manual" ? "Manual" : "Automatic",
    connector_id: "claude-code",
    created_at: DEMO_SUCCESS,
    effective_mode: effectiveMode,
    enabled: effectiveMode === "automatic",
    human_attention_needed: false,
    ineligibility_reason: null,
    interval_seconds: 3600,
    jitter_seconds: 0,
    last_error_code: null,
    last_finished_at: null,
    last_started_at: null,
    last_successful_at: DEMO_SUCCESS,
    minimum_interval_warning: null,
    next_due_at: nextDueAt,
    notification_posture: "none",
    object: "schedule",
    recommended_policy: null,
    scheduler_backoff: backoff,
    trigger_kind: "scheduled",
    updated_at: DEMO_SUCCESS,
  };
}

function ownerAction(
  label: string,
  kind: RefRequiredAction["kind"] = "refresh_now",
  surface: NonNullable<RefRequiredAction["surface"]>["kind"] = "runtime_retry"
): RefRequiredAction {
  return {
    affects: ["messages"],
    audience: "owner",
    cta: label,
    kind,
    satisfied_when: { kind: kind === "reauth" ? "credential_present_and_unrejected" : "attention_resolved" },
    surface: { kind: surface },
    terminal: false,
    urgency: "now",
  };
}

function applyStatusRow(model: ConnectorPageModel, row: SourceStatusRow, includePendingDetails: boolean): ConnectorPageModel {
  if (row === 16) {
    return {
      ...model,
      latestKnownGaps: [
        {
          boundary_claim: "provider_history_boundary",
          earliest_available: "2021-04-03",
          note: "Provider export says this is the oldest available message.",
          reason_code: "provider_retention_policy",
          stream: "messages",
        },
        { recovery_hint: { action: "not_retriable" }, stream: "sessions" },
      ],
    };
  }

  const demoHealth = model.connectionHealth!;
  const statusActionSource = {
    ...model.source,
    connection_health: { ...demoHealth, last_success_at: DEMO_SUCCESS },
    display_name: `Status example ${row}`,
    last_successful_run: {
      event_count: 8,
      failure_reason: null,
      finished_at: DEMO_SUCCESS,
      first_at: DEMO_SUCCESS,
      last_at: DEMO_SUCCESS,
      run_id: "run_demo_previous_success",
      started_at: DEMO_SUCCESS,
      status: "succeeded",
    },
    owner_state: {
      evidence_as_of: DEMO_SUCCESS,
      owner_of_state: "system" as const,
      posture: "observed" as const,
      resolver: "healthy" as const,
    },
    rendered_verdict: {
      ...model.connectionRenderedVerdict!,
      channel: "calm",
      pill: { label: "Healthy", tone: "green" },
      required_actions: [],
    },
    schedule: null,
    source_binding_kind: null,
    source_kind: "account",
    source_visibility: "active",
    status: "active",
    revoked_at: null,
    terminal_setup_disposition: null,
  } satisfies RefConnectorSummary;

  let source: RefConnectorSummary = statusActionSource;
  let schedule: RefSchedule | null = null;
  let connectionStatus = "active";
  let running = false;
  let setupFailed = false;
  let connectorNotInstalled = false;

  switch (row) {
    case 1:
      source = { ...source, source_kind: "local_device", source_visibility: "archived", status: "paused" };
      break;
    case 2:
      source = { ...source, revoked_at: DEMO_SUCCESS, source_visibility: "setup_failed", status: "revoked" };
      connectionStatus = "revoked";
      setupFailed = true;
      break;
    case 3:
      source = { ...source, revoked_at: DEMO_SUCCESS, status: "revoked" };
      connectionStatus = "revoked";
      break;
    case 4:
      source = { ...source, connector_implementation: { connector_id: source.connector_id, state: "not_installed" } };
      connectorNotInstalled = true;
      break;
    case 5:
    case 6:
    case 7: {
      const disposition = row === 5 ? "unverified_missing_counts" : row === 6 ? "unverified_zero" : "verified_empty";
      const label = row === 5 ? "Review setup" : row === 6 ? "Retry first sync" : "Review result";
      source = {
        ...source,
        terminal_setup_disposition: disposition,
        rendered_verdict: {
          ...source.rendered_verdict!,
          required_actions: row === 6 ? [] : [ownerAction(label)],
        },
      };
      break;
    }
    case 8:
      source = {
        ...source,
        owner_state: { evidence_as_of: DEMO_SUCCESS, owner_of_state: "owner", posture: "observed", resolver: "needs_owner" },
        rendered_verdict: {
          ...source.rendered_verdict!,
          pill: { label: "Can't collect", tone: "red" },
          required_actions: [ownerAction("Sign in again", "reauth", "browser_session")],
        },
        source_binding_kind: "browser_collector",
      };
      break;
    case 9:
      source = {
        ...source,
        owner_state: { evidence_as_of: DEMO_SUCCESS, owner_of_state: "owner", posture: "observed", resolver: "setup_in_progress" },
      };
      break;
    case 10:
      source = { ...source, owner_state: { evidence_as_of: DEMO_SUCCESS, owner_of_state: "owner", posture: "observed", resolver: "owner_paused" }, status: "paused" };
      connectionStatus = "paused";
      break;
    case 11: {
      const startedAt = "2026-11-24T11:58:00.000Z";
      source = {
        ...source,
        last_run: { event_count: 0, failure_reason: null, finished_at: null, first_at: startedAt, last_at: startedAt, run_id: "run_demo_active", started_at: startedAt, status: "started" },
        owner_state: { evidence_as_of: DEMO_SUCCESS, owner_of_state: "system", posture: "observed", resolver: "collecting" },
      };
      running = true;
      break;
    }
    case 12:
      schedule = statusSchedule("automatic", {
        backoff_applied: true,
        consecutive_failures: 2,
        next_run_at: "2026-11-24T12:20:00.000Z",
        reason_class: "retry",
        recommended_health_state: "cooling_off",
      });
      source = { ...source, owner_state: { evidence_as_of: DEMO_SUCCESS, owner_of_state: "system", posture: "observed", resolver: "system_degraded" }, rendered_verdict: { ...source.rendered_verdict!, pill: { label: "Missing data", tone: "amber" } }, schedule };
      break;
    case 13:
      source = { ...source, owner_state: { evidence_as_of: DEMO_SUCCESS, owner_of_state: "system", posture: "observed", resolver: "blocked_maintainer" } };
      break;
    case 14:
    case 15: {
      const label = row === 14 ? "Missing optional data" : "Some records stuck";
      source = { ...source, owner_state: { evidence_as_of: DEMO_SUCCESS, owner_of_state: "system", posture: "observed", resolver: "system_degraded" }, rendered_verdict: { ...source.rendered_verdict!, pill: { label, tone: "amber" } } };
      break;
    }
    case 17:
      source = { ...source, owner_state: { evidence_as_of: DEMO_SUCCESS, owner_of_state: "owner", posture: "observed", resolver: "refresh_due" }, schedule: statusSchedule("manual") };
      schedule = source.schedule;
      break;
    case 18:
      source = { ...source, owner_state: { evidence_as_of: DEMO_SUCCESS, owner_of_state: "system", posture: "observed", resolver: "healthy" }, rendered_verdict: { ...source.rendered_verdict!, pill: { label: "Import complete", tone: "green" } }, source_kind: "manual" };
      break;
    case 19:
      schedule = statusSchedule("automatic", null, "2026-11-24T16:00:00.000Z");
      source = { ...source, connection_health: { ...source.connection_health, lateness: { state: "on_time" } }, owner_state: { evidence_as_of: DEMO_SUCCESS, owner_of_state: "system", posture: "observed", resolver: "healthy" }, schedule };
      break;
    case 20:
      source = { ...source, owner_state: { evidence_as_of: DEMO_SUCCESS, owner_of_state: "system", posture: "frozen-since-last-run", resolver: "healthy" } };
      break;
    case 21:
      source = { ...source, owner_state: { evidence_as_of: DEMO_SUCCESS, owner_of_state: "system", posture: "observed", resolver: "not_measured" }, rendered_verdict: { ...source.rendered_verdict!, pill: { label: "Collected, not independently checked", tone: "grey" } } };
      break;
    case 22:
      source = { ...source, connection_health: { ...source.connection_health, last_success_at: null }, last_successful_run: null, owner_state: { evidence_as_of: DEMO_SUCCESS, owner_of_state: "system", posture: "observed", resolver: "not_measured" }, rendered_verdict: null, source_kind: "manual" };
      break;
    case 23:
      source = { ...source, owner_state: undefined };
      break;
    case 24:
      source = { ...source, owner_state: undefined, rendered_verdict: null, status: undefined, source_visibility: undefined };
      break;
  }

  const status = sourceStatusWords(source, { now: DEMO_NOW });
  if (["review_setup", "review_result"].includes(status.action?.kind ?? "")) {
    const action = status.action;
    source = {
      ...source,
      rendered_verdict: {
        ...source.rendered_verdict!,
        required_actions: [ownerAction(action!.label)],
      },
    };
  }
  const sourceRun = source.last_run ?? null;
  const recentRuns = row === 11 && sourceRun
    ? [{ ...model.recentRuns[0]!, event_count: sourceRun.event_count, failure_reason: null, first_at: sourceRun.first_at, last_at: sourceRun.last_at, run_id: sourceRun.run_id, status: sourceRun.status }]
    : row === 12
      ? model.recentRuns
      : [];
  const health = source.connection_health && !includePendingDetails
    ? { ...source.connection_health, conditions: [], detail_gap_backlog: null }
    : source.connection_health;
  const visibleFacts = includePendingDetails ? model.collectionFactsByStream : new Map<string, StreamCollectionFacts>();
  const visibleReport = includePendingDetails ? source.collection_report : [];
  source = {
    ...source,
    collection_report: visibleReport,
    connection_health: health,
  };

  return {
    ...model,
    collectionFactsByStream: visibleFacts,
    connectionHealth: health,
    connectionPrimaryAction: source.rendered_verdict?.required_actions[0] ?? null,
    connectionRenderedVerdict: source.rendered_verdict ?? null,
    connectorNotInstalled,
    deviceLabels: row === 1 ? model.deviceLabels : [],
    overview: {
      ...model.overview,
      acquisitionCoverage: includePendingDetails ? model.overview.acquisitionCoverage : null,
      collectionReport: visibleReport,
      connectionHealth: health,
      connectionStatus,
      isRunning: running,
      lastRun: sourceRun ? toRunRef(sourceRun) : null,
      lastSuccessfulRun: source.last_successful_run ? toRunRef(source.last_successful_run) : null,
      localDeviceProgress: row === 1 || includePendingDetails ? model.overview.localDeviceProgress : null,
      revokedAt: source.revoked_at ?? null,
    },
    recentRuns,
    schedule,
    latestKnownGaps: [],
    setupFailed,
    source,
    sourceBindingKind: source.source_binding_kind ?? null,
    sourceInstances: row === 1 || includePendingDetails ? model.sourceInstances : [],
  };
}
