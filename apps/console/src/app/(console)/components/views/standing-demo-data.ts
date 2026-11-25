// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type {
  DatasetSummary,
  GrantSummary,
  OwnerIssuedClient,
  PendingApproval,
  RefConnectionHealthSnapshot,
  RefConnectorRunSummary,
  RefConnectorSummary,
  RefRenderedVerdict,
  RefRequiredAction,
  TraceSummary,
} from "../../lib/ref-client.ts";
import type { HomeHrefs, HomeInputs } from "./standing-view-model.ts";

export type DemoScenario = "calm" | "alarm" | "decide";

const NOW = new Date("2026-11-24T12:00:00Z");

function ago(hours: number): string {
  return new Date(NOW.getTime() - hours * 3_600_000).toISOString();
}

function health(overrides: Partial<RefConnectionHealthSnapshot> = {}): RefConnectionHealthSnapshot {
  return {
    axes: {
      attention: "none",
      coverage: "complete",
      freshness: "fresh",
      outbox: "idle",
    },
    badges: { stale: false, syncing: false },
    last_success_at: ago(2),
    next_action: null,
    next_attempt_at: null,
    reason_code: null,
    state: "healthy",
    unknown_reasons: [],
    ...overrides,
  };
}

function requiredAction(overrides: Partial<RefRequiredAction> = {}): RefRequiredAction {
  return {
    affects: [],
    audience: "owner",
    cta: "Finish sign-in",
    kind: "reauth",
    satisfied_when: { kind: "credential_present_and_unrejected" },
    surface: { kind: "provider_interaction" },
    terminal: false,
    urgency: "now",
    ...overrides,
  };
}

function verdict(
  label: RefRenderedVerdict["pill"]["label"] = "Healthy",
  actions: RefRequiredAction[] = [],
): RefRenderedVerdict {
  return {
    annotations: [],
    channel: "calm",
    detail: {},
    forward_statement: "The source is ready.",
    pill: {
      label,
      tone: label === "Healthy" || label === "Import complete" ? "green" : "amber",
    },
    progress: {
      gaps_drained_last_run: null,
      headline: "Current status.",
      last_refreshed_at: null,
      mode: "scheduled",
      records_committed_last_run: null,
      retained_records: null,
    },
    required_actions: actions,
    streams: [],
    trace: {},
  };
}

const OBSERVED = {
  evidence_as_of: ago(2),
  owner_of_state: "system" as const,
  posture: "observed" as const,
  resolver: "healthy" as const,
};

function source(row: number, name: string, overrides: Partial<RefConnectorSummary> = {}): RefConnectorSummary {
  const base: RefConnectorSummary = {
    connection_health: health(),
    connection_id: `demo-${row}`,
    connector_id: name.toLowerCase().replaceAll(" ", "-"),
    display_name: name,
    freshness: {},
    last_run: null,
    last_successful_run: null,
    manifest_version: null,
    next_action: null,
    owner_state: OBSERVED,
    rendered_verdict: verdict(),
    schedule: null,
    streams: [],
    total_records: 120,
  };
  const successRun: RefConnectorRunSummary = {
    event_count: 18,
    failure_reason: null,
    finished_at: ago(2),
    first_at: ago(2),
    last_at: ago(2),
    run_id: `run-demo-${row}`,
    started_at: ago(2),
    status: "succeeded",
  };

  switch (row) {
    case 4:
      return {
        ...base,
        connector_implementation: {
          connector_id: base.connector_id,
          state: "not_installed",
        },
        ...overrides,
      };
    case 5:
      return {
        ...base,
        terminal_setup_disposition: "unverified_missing_counts",
        ...overrides,
      };
    case 6:
      return {
        ...base,
        terminal_setup_disposition: "unverified_zero",
        ...overrides,
      };
    case 7:
      return {
        ...base,
        terminal_setup_disposition: "verified_empty",
        ...overrides,
      };
    case 8:
      return {
        ...base,
        owner_state: {
          ...OBSERVED,
          owner_of_state: "owner",
          resolver: "needs_owner",
        },
        rendered_verdict: verdict("Can't collect", [requiredAction()]),
        ...overrides,
      };
    case 9:
      return {
        ...base,
        owner_state: {
          ...OBSERVED,
          owner_of_state: "owner",
          resolver: "setup_in_progress",
        },
        ...overrides,
      };
    case 10:
      return {
        ...base,
        owner_state: {
          ...OBSERVED,
          owner_of_state: "owner",
          resolver: "owner_paused",
        },
        status: "paused",
        ...overrides,
      };
    case 11:
      return {
        ...base,
        last_run: { ...successRun, finished_at: null, status: "started" },
        owner_state: { ...OBSERVED, resolver: "collecting" },
        ...overrides,
      };
    case 12:
      return {
        ...base,
        owner_state: { ...OBSERVED, resolver: "system_degraded" },
        rendered_verdict: verdict("Missing data"),
        schedule: {
          active_run_id: null,
          automation_mode: "unattended",
          automation_summary: "Automatic",
          connector_id: base.connector_id,
          created_at: ago(40),
          effective_mode: "automatic",
          enabled: true,
          human_attention_needed: false,
          ineligibility_reason: null,
          interval_seconds: 3600,
          jitter_seconds: 0,
          last_error_code: null,
          last_finished_at: ago(2),
          last_started_at: ago(2),
          last_successful_at: ago(2),
          minimum_interval_warning: null,
          next_due_at: null,
          notification_posture: "none",
          object: "schedule",
          recommended_policy: null,
          scheduler_backoff: {
            backoff_applied: true,
            consecutive_failures: 2,
            next_run_at: null,
            reason_class: "retry",
            recommended_health_state: "cooling_off",
          },
          trigger_kind: "scheduled",
          updated_at: ago(2),
        },
        ...overrides,
      };
    case 13:
      return {
        ...base,
        owner_state: { ...OBSERVED, resolver: "blocked_maintainer" },
        ...overrides,
      };
    case 14:
      return {
        ...base,
        owner_state: { ...OBSERVED, resolver: "system_degraded" },
        rendered_verdict: verdict("Missing optional data"),
        ...overrides,
      };
    case 15:
      return {
        ...base,
        owner_state: { ...OBSERVED, resolver: "system_degraded" },
        rendered_verdict: verdict("Some records stuck"),
        ...overrides,
      };
    case 16:
      return {
        ...base,
        owner_state: { ...OBSERVED, resolver: "system_degraded" },
        rendered_verdict: verdict("Missing data"),
        ...overrides,
      };
    case 17:
      return {
        ...base,
        owner_state: {
          ...OBSERVED,
          owner_of_state: "owner",
          resolver: "refresh_due",
        },
        ...overrides,
      };
    case 18:
      return {
        ...base,
        owner_state: { ...OBSERVED, resolver: "healthy" },
        rendered_verdict: verdict("Import complete"),
        ...overrides,
      };
    case 19:
      return {
        ...base,
        connection_health: health({ lateness: { state: "on_time" } }),
        ...overrides,
      };
    case 20:
      return {
        ...base,
        owner_state: { ...OBSERVED, posture: "frozen-since-last-run" },
        ...overrides,
      };
    case 21:
      return {
        ...base,
        last_successful_run: successRun,
        owner_state: { ...OBSERVED, resolver: "not_measured" },
        rendered_verdict: verdict("Collected, not independently checked"),
        ...overrides,
      };
    case 22:
      return {
        ...base,
        connection_health: health({ last_success_at: null }),
        last_successful_run: null,
        owner_state: { ...OBSERVED, resolver: "not_measured" },
        source_kind: "account",
        ...overrides,
      };
    case 23:
      return {
        ...base,
        owner_state: undefined,
        rendered_verdict: verdict("Healthy"),
        ...overrides,
      };
    default:
      return {
        ...base,
        connection_health: health({ last_success_at: null }),
        owner_state: undefined,
        rendered_verdict: null,
        status: undefined,
        source_visibility: undefined,
        ...overrides,
      };
  }
}

const CLIENTS: OwnerIssuedClient[] = [
  {
    active_token_count: 2,
    client_id: "Atlas Mortgage",
    client_name: "Atlas Mortgage",
    created_at: ago(120),
  },
];

const GRANTS: GrantSummary[] = [
  {
    client_id: "Atlas Mortgage",
    client: {
      client_id: "Atlas Mortgage",
      client_name: "Atlas Mortgage",
      registration_mode: "dynamic",
    },
    connector_id: "plaid",
    event_count: 14,
    failure: null,
    first_at: ago(200),
    grant_id: "grant-atlas",
    kinds: ["pay_statements", "transactions"],
    last_at: ago(4),
    object: "grant_summary",
    status: "active",
  },
];

const TRACES: TraceSummary[] = [
  {
    actor_id: "Atlas Mortgage",
    actor_type: "client",
    client_id: "Atlas Mortgage",
    event_count: 14,
    failure: null,
    first_at: ago(4),
    grant_id: "grant-atlas",
    kinds: ["transactions"],
    last_at: ago(4),
    object: "trace_summary",
    request_id: null,
    run_id: null,
    status: "succeeded",
    trace_id: "trace-atlas",
  },
];

const PENDING: PendingApproval[] = [
  {
    approval_id: "approval-demo",
    batch: false,
    client_id: "Northstar HR",
    created_at: ago(1),
    grant_preview: {
      streams: [{ name: "employment" }, { name: "pay_statements" }],
    },
    kind: "consent",
    object: "approval",
  },
];

const SUMMARY: DatasetSummary = {
  blob_bytes: 0,
  connector_count: 10,
  earliest_ingested_at: ago(1000),
  earliest_record_time: ago(1000),
  latest_ingested_at: ago(2),
  latest_record_time: ago(2),
  object: "dataset_summary",
  projection: { computed_at: ago(2), state: "fresh" },
  record_changes_json_bytes: 0,
  record_count: 48_120,
  record_json_bytes: 0,
  stream_count: 24,
  top_connectors: [],
  total_retained_bytes: 0,
};

export function buildDemoInputs(scenario: DemoScenario, hrefs: HomeHrefs): HomeInputs {
  const rows =
    scenario === "calm"
      ? [source(18, "Pocket"), source(19, "Spotify")]
      : scenario === "alarm"
        ? [
            source(4, "Amazon"),
            source(5, "Facebook"),
            source(6, "Gmail"),
            source(8, "Google Calendar"),
            source(9, "Notion"),
            source(10, "Reddit"),
            source(11, "Slack"),
            source(12, "TikTok"),
            source(13, "Uber"),
            source(14, "Venmo"),
            source(15, "WhatsApp"),
            source(16, "YouTube"),
            source(17, "YNAB"),
          ]
        : [
            source(7, "Jellyfin"),
            source(20, "Oura"),
            source(21, "GitHub"),
            source(22, "Fitbit"),
            source(23, "Apple Photos"),
            source(24, "Doordash"),
          ];

  const inputs: HomeInputs = {
    approvals: scenario === "decide" ? PENDING : [],
    approvalsFailed: false,
    approvalsHaveMore: false,
    grants: GRANTS,
    grantsFailed: false,
    grantsHaveMore: false,
    hrefs,
    now: NOW,
    ownerClients: CLIENTS,
    ownerClientsFailed: false,
    ownerClientsHaveMore: false,
    reloadHref: `/?demo=${scenario}`,
    sourcePage: { hasMore: false, kind: "ok", sources: rows },
    summary: SUMMARY,
    summaryFailed: false,
    traces: TRACES,
    tracesFailed: false,
    tracesHaveMore: false,
  };

  return inputs;
}

export function isDemoScenario(value: string | undefined): value is DemoScenario {
  return value === "calm" || value === "alarm" || value === "decide";
}
