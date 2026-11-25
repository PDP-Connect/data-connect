// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * DEV-ONLY seeded Sources fixtures.
 *
 * Lets a reviewer screenshot the Recordroom Sources view (every status flag,
 * the passport, the revoke ceremony, the stream manifest) without a live
 * reference server or real owner data. Imported ONLY when `?demo=` is present
 * AND `NODE_ENV !== "production"` (see records/page.tsx). The live path never
 * imports this module, so no fictional data can leak into a real deployment.
 *
 * The shapes are real `RefConnectorSummary`s so the same `toSourcesView`
 * mapping the live page uses runs unchanged against them — the demo exercises
 * the real projection, not a parallel one.
 */

import type {
  RefConnectionHealthSnapshot,
  RefConnectorSummary,
  RefRenderedVerdict,
  RefRequiredAction,
} from "../lib/ref-client.ts";
import type { SourceStatusRow } from "../lib/source-status-words.ts";

export type SourcesDemoScenario = "mixed" | "healthy" | "attention";

const VALID = new Set<SourcesDemoScenario>(["mixed", "healthy", "attention"]);

export function isSourcesDemoScenario(value: string): value is SourcesDemoScenario {
  return VALID.has(value as SourcesDemoScenario);
}

const EMPTY_AXES: RefConnectionHealthSnapshot["axes"] = {
  attention: {} as RefConnectionHealthSnapshot["axes"]["attention"],
  coverage: {} as RefConnectionHealthSnapshot["axes"]["coverage"],
  freshness: {} as RefConnectionHealthSnapshot["axes"]["freshness"],
  outbox: {} as RefConnectionHealthSnapshot["axes"]["outbox"],
};

function health(
  state: RefConnectionHealthSnapshot["state"],
  extra: Partial<RefConnectionHealthSnapshot> = {}
): RefConnectionHealthSnapshot {
  return {
    axes: EMPTY_AXES,
    badges: { stale: false, syncing: false },
    last_success_at: "2026-06-12T08:00:00Z",
    next_action: null,
    next_attempt_at: null,
    reason_code: null,
    state,
    unknown_reasons: [],
    ...extra,
  };
}

const TYPE_LABEL_SEP_RE = /[-_]/;
const DEMO_SUCCESS = "2026-11-24T10:00:00.000Z";
const HEALTHY_OWNER_STATE = {
  evidence_as_of: DEMO_SUCCESS,
  owner_of_state: "system" as const,
  posture: "observed" as const,
  resolver: "healthy" as const,
};

function requiredAction(cta: string): RefRequiredAction {
  return {
    affects: [],
    audience: "owner",
    cta,
    kind: "reauth",
    satisfied_when: { kind: "credential_present_and_unrejected" },
    surface: { kind: "browser_session" },
    terminal: false,
    urgency: "now",
  };
}

function verdict(label: RefRenderedVerdict["pill"]["label"], actions: RefRequiredAction[] = []): RefRenderedVerdict {
  return {
    annotations: [],
    channel: "calm",
    detail: {},
    forward_statement: "The data source is ready.",
    pill: { label, tone: label === "Healthy" || label === "Import complete" ? "green" : "amber" },
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

const HEALTHY_VERDICT = verdict("Healthy");

/**
 * One real-looking data source per status row, using the names and bundled
 * logos Home's samples use (lead decision list-pictures 8). Names never repeat
 * a named sample in the same scenario, so no duplicate-label notice appears.
 */
const STATUS_SAMPLE_SOURCES: Readonly<Record<SourceStatusRow, { connectorId: string; name: string }>> = {
  1: { connectorId: "linkedin", name: "LinkedIn" },
  2: { connectorId: "discord-browser", name: "Discord" },
  3: { connectorId: "steam", name: "Steam" },
  4: { connectorId: "facebook", name: "Facebook" },
  5: { connectorId: "notion", name: "Notion" },
  6: { connectorId: "google-calendar", name: "Google Calendar" },
  7: { connectorId: "jellyfin", name: "Jellyfin" },
  8: { connectorId: "reddit", name: "Reddit" },
  9: { connectorId: "pocket", name: "Pocket" },
  10: { connectorId: "strava", name: "Strava" },
  11: { connectorId: "slack", name: "Slack" },
  12: { connectorId: "tiktok", name: "TikTok" },
  13: { connectorId: "uber", name: "Uber" },
  14: { connectorId: "venmo", name: "Venmo" },
  15: { connectorId: "whatsapp", name: "WhatsApp" },
  16: { connectorId: "youtube", name: "YouTube" },
  17: { connectorId: "ynab", name: "YNAB" },
  18: { connectorId: "apple-photos", name: "Apple Photos" },
  19: { connectorId: "fitbit", name: "Fitbit" },
  20: { connectorId: "oura", name: "Oura" },
  21: { connectorId: "perplexity", name: "Perplexity" },
  22: { connectorId: "netflix-export", name: "Netflix" },
  23: { connectorId: "usaa", name: "USAA" },
  24: { connectorId: "doordash", name: "DoorDash" },
};

export function statusSampleConnectionId(row: SourceStatusRow): string {
  return `conn_demo_status_${row}`;
}

function statusSample(row: SourceStatusRow): RefConnectorSummary {
  const { connectorId, name } = STATUS_SAMPLE_SOURCES[row];
  const base = summary({
    connection_id: statusSampleConnectionId(row),
    connector_id: connectorId,
    display_name: name,
    owner_state: HEALTHY_OWNER_STATE,
    rendered_verdict: HEALTHY_VERDICT,
  });
  const result: Pick<RefConnectorSummary, "connector_id" | "connection_id" | "display_name"> & Partial<RefConnectorSummary> = {
    connection_id: statusSampleConnectionId(row),
    connector_instance_id: statusSampleConnectionId(row),
    connector_id: connectorId,
    connector_display_name: name,
    display_name: name,
  };
  switch (row) {
    case 1: Object.assign(result, { source_visibility: "archived", status: "paused" }); break;
    case 2: Object.assign(result, { source_visibility: "setup_failed", status: "revoked", revoked_at: DEMO_SUCCESS }); break;
    case 3: Object.assign(result, { status: "revoked", revoked_at: DEMO_SUCCESS }); break;
    case 4: Object.assign(result, { connector_implementation: { connector_id: connectorId, state: "not_installed" } }); break;
    case 5: Object.assign(result, { terminal_setup_disposition: "unverified_missing_counts" }); break;
    case 6: Object.assign(result, { terminal_setup_disposition: "unverified_zero" }); break;
    case 7: Object.assign(result, { terminal_setup_disposition: "verified_empty" }); break;
    case 8: Object.assign(result, {
      owner_state: { ...HEALTHY_OWNER_STATE, owner_of_state: "owner", resolver: "needs_owner" },
      rendered_verdict: verdict("Can't collect", [requiredAction("Review this data source")]),
    }); break;
    case 9: Object.assign(result, { owner_state: { ...HEALTHY_OWNER_STATE, owner_of_state: "owner", resolver: "setup_in_progress" } }); break;
    case 10: Object.assign(result, { status: "paused" }); break;
    case 11: Object.assign(result, {
      last_run: { ...base.last_run!, finished_at: null, started_at: DEMO_SUCCESS, status: "started" },
      owner_state: { ...HEALTHY_OWNER_STATE, resolver: "collecting" },
    }); break;
    case 12: Object.assign(result, {
      schedule: { ...GMAIL.schedule!, scheduler_backoff: { backoff_applied: true, consecutive_failures: 2, next_run_at: null, reason_class: "retry", recommended_health_state: "cooling_off" } },
      owner_state: { ...HEALTHY_OWNER_STATE, resolver: "system_degraded" },
      rendered_verdict: verdict("Missing data"),
    }); break;
    case 13: Object.assign(result, { owner_state: { ...HEALTHY_OWNER_STATE, resolver: "blocked_maintainer" } }); break;
    case 14: Object.assign(result, { owner_state: { ...HEALTHY_OWNER_STATE, resolver: "system_degraded" }, rendered_verdict: verdict("Missing optional data") }); break;
    case 15: Object.assign(result, { owner_state: { ...HEALTHY_OWNER_STATE, resolver: "system_degraded" }, rendered_verdict: verdict("Some records stuck") }); break;
    case 16: Object.assign(result, { owner_state: { ...HEALTHY_OWNER_STATE, resolver: "system_degraded" }, rendered_verdict: verdict("Missing data") }); break;
    case 17: Object.assign(result, { owner_state: { ...HEALTHY_OWNER_STATE, owner_of_state: "owner", resolver: "refresh_due" } }); break;
    case 18: Object.assign(result, { owner_state: { ...HEALTHY_OWNER_STATE, resolver: "healthy" }, rendered_verdict: verdict("Import complete") }); break;
    case 19: Object.assign(result, { connection_health: health("healthy", { lateness: { state: "on_time" } }) }); break;
    case 20: Object.assign(result, {
      owner_state: { ...HEALTHY_OWNER_STATE, posture: "frozen-since-last-run" },
      rendered_verdict: verdict("Collected, not independently checked"),
    }); break;
    case 21: Object.assign(result, {
      owner_state: { ...HEALTHY_OWNER_STATE, resolver: "not_measured" },
      last_successful_run: base.last_successful_run,
    }); break;
    case 22: Object.assign(result, {
      owner_state: { ...HEALTHY_OWNER_STATE, resolver: "not_measured" },
      source_kind: "manual",
      last_successful_run: null,
      connection_health: health("healthy", { last_success_at: null }),
    }); break;
    case 23: Object.assign(result, { owner_state: undefined, rendered_verdict: HEALTHY_VERDICT }); break;
    case 24: Object.assign(result, {
      owner_state: undefined,
      rendered_verdict: null,
      status: undefined,
      source_visibility: undefined,
      connection_health: health("idle", { last_success_at: null }),
      last_successful_run: null,
    }); break;
  }
  return summary(result);
}

/** Title-case the connector key into a type label, e.g. "gmail" → "Gmail". */
function typeLabel(connectorId: string): string {
  return connectorId
    .split(TYPE_LABEL_SEP_RE)
    .map((part) => {
      const first = part.charAt(0);
      return first ? first.toUpperCase() + part.slice(1) : part;
    })
    .join(" ");
}

function summary(
  partial: Pick<RefConnectorSummary, "connector_id" | "connection_id" | "display_name"> & Partial<RefConnectorSummary>
): RefConnectorSummary {
  return {
    connection_health: health("healthy"),
    owner_state: HEALTHY_OWNER_STATE,
    // The TYPE label (distinct from the owner's per-instance display_name), so
    // the demo exercises the real "type · account" list line shape.
    connector_display_name: typeLabel(partial.connector_id),
    connector_instance_id: partial.connection_id,
    freshness: {},
    last_run: {
      event_count: 42,
      failure_reason: null,
      finished_at: "2026-06-12T08:01:00Z",
      first_at: "2026-04-01T00:00:00Z",
      last_at: "2026-06-12T08:01:00Z",
      run_id: "run_demo_0001",
      started_at: "2026-06-12T08:00:00Z",
      status: "succeeded",
    },
    last_successful_run: {
      event_count: 42,
      failure_reason: null,
      finished_at: "2026-06-12T08:01:00Z",
      first_at: "2026-04-01T00:00:00Z",
      last_at: "2026-06-12T08:01:00Z",
      run_id: "run_demo_0001",
      started_at: "2026-06-12T08:00:00Z",
      status: "succeeded",
    },
    manifest_version: "1.0.0",
    next_action: null,
    rendered_verdict: HEALTHY_VERDICT,
    schedule: null,
    stream_count: 2,
    streams: ["messages", "threads"],
    total_records: 1234,
    ...partial,
  };
}

const GMAIL = summary({
  connection_health: health("healthy"),
  connection_id: "conn_gmail_personal_01",
  connector_id: "gmail",
  display_name: "Gmail (personal)",
  schedule: {
    active_run_id: null,
    automation_mode: "unattended",
    automation_summary: "Runs automatically every day.",
    connector_id: "gmail",
    created_at: "2026-04-01T00:00:00Z",
    effective_mode: "automatic",
    enabled: true,
    human_attention_needed: false,
    ineligibility_reason: null,
    interval_seconds: 86_400,
    jitter_seconds: 600,
    last_error_code: null,
    last_finished_at: "2026-06-12T08:01:00Z",
    last_started_at: "2026-06-12T08:00:00Z",
    last_successful_at: "2026-06-12T08:01:00Z",
    minimum_interval_warning: null,
    next_due_at: "2026-06-13T08:00:00Z",
    notification_posture: "none",
    object: "schedule",
    policy_warning: null,
    recommended_policy: null,
    scheduler_backoff: null,
    trigger_kind: "scheduled",
    updated_at: "2026-06-12T08:01:00Z",
  },
  stream_count: 4,
  streams: ["messages", "threads", "labels", "attachments"],
  total_records: 48_201,
});

const CHATGPT = summary({
  owner_state: { ...HEALTHY_OWNER_STATE, owner_of_state: "owner", resolver: "needs_owner" },
  rendered_verdict: verdict("Can't collect", [requiredAction("Review this data source")]),
  connection_health: health("needs_attention", {
    next_action: {
      action_target: "open_detail",
      attention_id: "att_demo_01",
      expires_at: null,
      notification_state: "sent",
      owner_action: "act_elsewhere",
      reason_code: "owner_refresh_due",
      response_contract: "none",
      source: "structured",
    },
    reason_code: "owner_refresh_due",
  }),
  connection_id: "conn_chatgpt_01",
  connector_id: "chatgpt",
  display_name: "ChatGPT",
  stream_count: 2,
  streams: ["conversations", "current_activity"],
  total_records: 5108,
});

const CHASE = summary({
  owner_state: { ...HEALTHY_OWNER_STATE, owner_of_state: "owner", resolver: "needs_owner" },
  rendered_verdict: verdict("Can't collect", [requiredAction("Update saved sign-in details")]),
  connection_health: health("blocked", { reason_code: "reauthorize_required" }),
  connection_id: "conn_chase_01",
  connector_id: "chase",
  display_name: "Chase",
  stream_count: 2,
  streams: ["statements", "current_activity"],
  total_records: 902,
});

const SPOTIFY_REVOKED = summary({
  connection_health: health("idle"),
  connection_id: "conn_spotify_01",
  connector_id: "spotify",
  display_name: "Spotify",
  revoked_at: "2026-06-01T00:00:00Z",
  status: "revoked",
  stream_count: 2,
  streams: ["plays", "playlists"],
  total_records: 12_044,
});

const AMAZON = summary({
  owner_state: { ...HEALTHY_OWNER_STATE, resolver: "system_degraded" },
  rendered_verdict: verdict("Missing optional data"),
  connection_health: health("degraded", { reason_code: "partial_coverage" }),
  connection_id: "conn_amazon_01",
  connector_id: "amazon",
  display_name: "Amazon",
  stream_count: 3,
  streams: ["orders", "returns", "addresses"],
  total_records: 311,
});

export function buildSourcesDemoSummaries(scenario: SourcesDemoScenario): RefConnectorSummary[] {
  if (scenario === "healthy") {
    return [GMAIL, summary({ connection_id: "conn_github_01", connector_id: "github", display_name: "GitHub" }), statusSample(18), statusSample(19)];
  }
  if (scenario === "attention") {
    return [CHATGPT, CHASE, AMAZON, ...([2, 4, 5, 6, 8, 9, 17] as const).map(statusSample)];
  }
  // The three scenarios seed every status the list can display.
  return [
    GMAIL,
    SPOTIFY_REVOKED,
    ...([1, 3, 7, 10, 11, 12, 13, 14, 15, 16, 20, 21, 22, 23, 24] as const).map(statusSample),
  ];
}
