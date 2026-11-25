// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import type { RefConnectionHealthSnapshot, RefConnectorSummary, RefRenderedVerdict, RefRequiredAction } from "./ref-client.ts";
import { sourceStateSentence, sourceStatusWords, type SourceStatusRow } from "./source-status-words.ts";

const NOW = new Date("2026-11-24T12:00:00.000Z");
const SUCCESS = "2026-11-24T10:00:00.000Z";

function health(overrides: Partial<RefConnectionHealthSnapshot> = {}): RefConnectionHealthSnapshot {
  return {
    axes: { attention: "none", coverage: "complete", freshness: "fresh", outbox: "idle" },
    badges: { stale: false, syncing: false },
    last_success_at: SUCCESS,
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
    cta: "Review this source",
    kind: "reauth",
    satisfied_when: { kind: "credential_present_and_unrejected" },
    surface: { kind: "browser_session" },
    terminal: false,
    urgency: "now",
    ...overrides,
  };
}

function verdict(label: RefRenderedVerdict["pill"]["label"] = "Healthy", actions: RefRequiredAction[] = []): RefRenderedVerdict {
  return {
    annotations: [],
    channel: "calm",
    detail: {},
    forward_statement: "The source is ready.",
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

function source(overrides: Partial<RefConnectorSummary> = {}): RefConnectorSummary {
  return {
    connection_health: health(),
    connection_id: "source-test-id",
    connector_id: "sample",
    display_name: "Example source",
    freshness: {},
    last_run: null,
    last_successful_run: null,
    manifest_version: null,
    next_action: null,
    rendered_verdict: verdict(),
    schedule: null,
    streams: [],
    total_records: 0,
    ...overrides,
  };
}

const healthyState = { evidence_as_of: SUCCESS, owner_of_state: "system" as const, posture: "observed" as const, resolver: "healthy" as const };

function assertRow(row: SourceStatusRow, words: string, tone: "plain" | "attention" | "accent" | "faint", expectedAction: ReturnType<typeof sourceStatusWords>["action"] = null) {
  const needsYou = [2, 4, 5, 6, 8, 9].includes(row);
  assert.deepEqual(sourceStatusWords(fixture(row), { now: NOW }), { row, words, tone, action: expectedAction, needsYou });
}

function fixture(row: SourceStatusRow): RefConnectorSummary {
  const base = source({ owner_state: healthyState });
  switch (row) {
    case 1: return source({ ...base, source_visibility: "archived", status: "paused" });
    case 2: return source({ ...base, revoked_at: "2026-11-20T12:00:00Z", source_visibility: "setup_failed" });
    case 3: return source({ ...base, connector_implementation: { connector_id: "sample", state: "not_installed" }, status: "revoked" });
    case 4: return source({ ...base, connector_implementation: { connector_id: "sample", state: "not_installed" }, terminal_setup_disposition: "verified_empty" });
    case 5: return source({ ...base, owner_state: { ...healthyState, resolver: "needs_owner" }, terminal_setup_disposition: "unverified_missing_counts" });
    case 6: return source({ ...base, terminal_setup_disposition: "unverified_zero" });
    case 7: return source({ ...base, terminal_setup_disposition: "verified_empty" });
    case 8: return source({ ...base, owner_state: { ...healthyState, owner_of_state: "owner", resolver: "needs_owner" }, rendered_verdict: verdict("Can't collect", [requiredAction()]) });
    case 9: return source({ ...base, owner_state: { ...healthyState, owner_of_state: "owner", resolver: "setup_in_progress" } });
    case 10: return source({ ...base, owner_state: { ...healthyState, owner_of_state: "owner", resolver: "owner_paused" }, status: "paused" });
    case 11: return source({ ...base, last_run: { event_count: 0, failure_reason: null, finished_at: null, first_at: SUCCESS, last_at: SUCCESS, run_id: "run-test", started_at: SUCCESS, status: "started" }, owner_state: { ...healthyState, resolver: "collecting" } });
    case 12: return source({ ...base, schedule: { active_run_id: null, automation_mode: "unattended", automation_summary: "Automatic", connector_id: "sample", created_at: SUCCESS, effective_mode: "automatic", enabled: true, human_attention_needed: false, ineligibility_reason: null, interval_seconds: 3600, jitter_seconds: 0, last_error_code: null, last_finished_at: null, last_started_at: null, last_successful_at: SUCCESS, minimum_interval_warning: null, next_due_at: null, notification_posture: "none", object: "schedule", recommended_policy: null, scheduler_backoff: { backoff_applied: true, consecutive_failures: 2, next_run_at: null, reason_class: "retry", recommended_health_state: "cooling_off" }, trigger_kind: "scheduled", updated_at: SUCCESS }, owner_state: { ...healthyState, resolver: "system_degraded" }, rendered_verdict: verdict("Missing data") });
    case 13: return source({ ...base, owner_state: { ...healthyState, resolver: "blocked_maintainer" } });
    case 14: return source({ ...base, owner_state: { ...healthyState, resolver: "system_degraded" }, rendered_verdict: verdict("Missing optional data") });
    case 15: return source({ ...base, owner_state: { ...healthyState, resolver: "system_degraded" }, rendered_verdict: verdict("Some records stuck") });
    case 16: return source({ ...base, owner_state: { ...healthyState, resolver: "system_degraded" }, rendered_verdict: verdict("Missing data") });
    case 17: return source({ ...base, owner_state: { ...healthyState, owner_of_state: "owner", resolver: "refresh_due" } });
    case 18: return source({ ...base, owner_state: { ...healthyState, resolver: "healthy" }, rendered_verdict: verdict("Import complete") });
    case 19: return source({ ...base, owner_state: healthyState, rendered_verdict: verdict("Healthy"), connection_health: health({ lateness: { state: "on_time" } }) });
    case 20: return source({ ...base, owner_state: { ...healthyState, posture: "frozen-since-last-run" }, rendered_verdict: verdict("Collected, not independently checked") });
    case 21: return source({ ...base, owner_state: { ...healthyState, resolver: "not_measured" }, last_successful_run: { event_count: 0, failure_reason: null, finished_at: SUCCESS, first_at: SUCCESS, last_at: SUCCESS, run_id: "run-success", started_at: SUCCESS, status: "succeeded" } });
    case 22: return source({ ...base, owner_state: { ...healthyState, resolver: "not_measured" }, last_successful_run: null, source_kind: "manual", connection_health: health({ last_success_at: null }) });
    case 23: return source({ ...base, owner_state: undefined, rendered_verdict: verdict("Healthy") });
    case 24: return source({ ...base, owner_state: undefined, rendered_verdict: null, connection_health: health({ last_success_at: null }), status: undefined, source_visibility: undefined });
  }
}

test("row 1 words an archived source", () => assertRow(1, "Archived", "faint"));
test("row 2 words a setup that never completed", () => assertRow(2, "Setup never completed", "attention", { kind: "continue_setup", label: "Continue setup", filled: true }));
test("row 3 words a revoked source", () => assertRow(3, "Disconnected", "faint", { kind: "set_up_again", label: "Set up again", filled: false }));
test("row 4 words a source whose collector is not installed", () => assertRow(4, "Needs its collector installed", "attention", { kind: "install", label: "Install", filled: true }));
test("row 5 words a first sync with missing counts", () => assertRow(5, "First sync needs a look", "attention", { kind: "review_setup", label: "Review setup", filled: true }));
test("row 6 words an unverified empty first sync", () => assertRow(6, "First sync found no records", "attention", { kind: "retry_first_sync", label: "Retry first sync", filled: true }));
test("row 7 words a verified empty first sync", () => assertRow(7, "No records found", "plain", { kind: "review_result", label: "Review result", filled: false }));
test("row 8 words a required owner action", () => assertRow(8, "Needs you to sign in again", "attention", { kind: "server_cta", label: "Review this source", filled: true }));
test("row 9 words setup in progress", () => assertRow(9, "Setup in progress", "attention", { kind: "continue_setup", label: "Continue setup", filled: true }));
test("row 10 words a paused source", () => assertRow(10, "Paused", "faint", { kind: "resume", label: "Resume", filled: false }));
test("row 11 words an active sync", () => assertRow(11, "Syncing now", "accent"));
test("row 12 words an automatic retry", () => assertRow(12, "Trying again on its own · last synced 2 hours ago", "plain"));
test("row 13 words a wait for a maintainer fix", () => assertRow(13, "Waiting on a fix from the DataConnect maintainers", "plain"));
test("row 14 words missing optional data", () => assertRow(14, "Some optional data is missing · last synced 2 hours ago", "plain"));
test("row 15 words stuck records", () => assertRow(15, "Some records are stuck · last synced 2 hours ago", "plain"));
test("row 16 words another degraded result", () => assertRow(16, "Trouble syncing · last synced 2 hours ago", "plain"));
test("row 17 words a refresh due", () => assertRow(17, "A refresh is due · last synced 2 hours ago", "plain", { kind: "sync_now", label: "Sync now", filled: false }));
test("row 18 words a completed import", () => assertRow(18, "Imported 2 hours ago", "plain"));
test("row 19 says up to date when healthy, green, observed and on time", () => assertRow(19, "Up to date · synced 2 hours ago", "plain"));
test("row 20 words a healthy source without a proven on-time schedule", () => assertRow(20, "Synced 2 hours ago", "plain"));
test("row 21 words a source with a past successful sync and no measured state", () => assertRow(21, "Synced 2 hours ago", "plain"));
test("row 22 words a manual import with no completed import", () => assertRow(22, "Nothing imported yet", "plain"));
test("row 23 uses the pill when the owner state is missing", () => assertRow(23, "Synced 2 hours ago", "plain"));
test("row 24 is used when lifecycle and pill evidence are absent", () => assertRow(24, "Status not available", "faint"));

test("row 8 chooses words from each owner action surface and preserves its CTA", () => {
  const cases = [
    ["browser_session", "Needs you to sign in again"],
    ["stored_credential", "Needs its saved sign-in details updated"],
    ["provider_interaction", "Waiting for you to finish a step"],
    ["local_device", "Needs attention on your device"],
    ["runtime_retry", "Needs you"],
  ] as const;
  for (const [surface, expected] of cases) {
    const cta = `Keep CTA from ${surface}`;
    const result = sourceStatusWords(source({
      owner_state: { ...healthyState, owner_of_state: "owner", resolver: "needs_owner" },
      rendered_verdict: verdict("Can't collect", [requiredAction({ cta, surface: { kind: surface } })]),
    }), { now: NOW });
    assert.equal(result.words, expected);
    assert.deepEqual(result.action, { kind: "server_cta", label: cta, filled: true });
  }
});

test("row 19 requires all four facts, and each missing or false fact gives another row", () => {
  const upToDate = fixture(19);
  assert.equal(sourceStatusWords(upToDate, { now: NOW }).row, 19);
  // the server's state is not healthy
  assert.notEqual(sourceStatusWords(source({ ...upToDate, owner_state: { ...healthyState, resolver: "refresh_due" } }), { now: NOW }).row, 19);
  // the pill is not "Healthy"
  assert.equal(sourceStatusWords(source({ ...upToDate, rendered_verdict: verdict("Collected, not independently checked") }), { now: NOW }).row, 20);
  // the posture is not observed
  assert.equal(sourceStatusWords(source({ ...upToDate, owner_state: { ...healthyState, posture: "frozen-since-last-run" } }), { now: NOW }).row, 20);
  // the schedule is late, overdue, unknown, or the server did not say
  for (const state of ["late", "overdue", "unknown"] as const) {
    assert.equal(sourceStatusWords(source({ ...upToDate, connection_health: health({ lateness: { state } }) }), { now: NOW }).row, 20);
  }
  assert.equal(sourceStatusWords(source({ ...upToDate, connection_health: health({ lateness: null }) }), { now: NOW }).row, 20);
  assert.equal(sourceStatusWords(source({ ...upToDate, connection_health: health() }), { now: NOW }).row, 20);
});

test("needsYou is true exactly on the rows where the person must act", () => {
  for (let row = 1; row <= 24; row += 1) {
    const result = sourceStatusWords(fixture(row as SourceStatusRow), { now: NOW });
    assert.equal(result.needsYou, [2, 4, 5, 6, 8, 9].includes(row), `row ${row}`);
    if (result.action) assert.equal(result.action.filled, result.needsYou, `row ${row}`);
  }
});

test("a local-device source offers neither sync now nor resume", () => {
  const devicePaused = sourceStatusWords(source({ ...fixture(10), source_kind: "local_device" }), { now: NOW });
  const deviceRefresh = sourceStatusWords(source({ ...fixture(17), source_kind: "local_device" }), { now: NOW });
  const deviceUnmeasured = sourceStatusWords(source({ ...fixture(22), owner_state: { ...healthyState, resolver: "not_measured" }, source_kind: "local_device" }), { now: NOW });
  assert.equal(devicePaused.action?.kind, "view_device");
  assert.equal(deviceRefresh.action?.kind, "view_device");
  assert.equal(deviceUnmeasured.action?.kind, "view_device");
});

test("a paused historical archive offers credential repair instead of resume", () => {
  const result = sourceStatusWords(source({ ...fixture(10), source_binding_kind: "historical_archive" }), { now: NOW });
  assert.equal(result.action?.kind, "repair_credential");
});

test("rows 17 and 22 offer sync only when this server can start it", () => {
  assert.equal(sourceStatusWords(source({ ...fixture(17), source_kind: "manual" }), { now: NOW }).action, null);
  assert.equal(sourceStatusWords(source({ ...fixture(22), source_kind: "connector" }), { now: NOW }).action?.kind, "sync_now");
  assert.equal(sourceStatusWords(source({ ...fixture(22), source_kind: "manual" }), { now: NOW }).action, null);
});

test("first matching row wins for overlapping evidence", () => {
  const pairs: Array<[RefConnectorSummary, SourceStatusRow]> = [
    [source({ source_visibility: "archived", status: "paused", owner_state: { ...healthyState, resolver: "owner_paused" } }), 1],
    [source({ source_visibility: "setup_failed", status: "revoked", revoked_at: SUCCESS }), 2],
    [source({ status: "revoked", connector_implementation: { connector_id: "sample", state: "not_installed" } }), 3],
    [source({ connector_implementation: { connector_id: "sample", state: "not_installed" }, terminal_setup_disposition: "verified_empty" }), 4],
    [source({ terminal_setup_disposition: "unverified_missing_counts", owner_state: { ...healthyState, resolver: "needs_owner" } }), 5],
    [source({ status: "paused", source_binding_kind: "historical_archive", schedule: fixture(12).schedule, owner_state: { ...healthyState, resolver: "owner_paused" } }), 10],
    [source({ last_run: fixture(11).last_run, schedule: fixture(12).schedule, owner_state: { ...healthyState, resolver: "collecting" } }), 11],
    [source({ schedule: fixture(12).schedule, owner_state: { ...healthyState, resolver: "system_degraded" }, rendered_verdict: verdict("Missing data") }), 12],
  ];
  for (const [candidate, expected] of pairs) assert.equal(sourceStatusWords(candidate, { now: NOW }).row, expected);
});

test("relative time and old dates have the required human forms and omit missing time", () => {
  assert.equal(sourceStatusWords(source({ connection_health: health({ last_success_at: "2026-11-24T10:00:00Z" }), owner_state: { ...healthyState, resolver: "system_degraded" }, rendered_verdict: verdict("Missing data") }), { now: NOW }).words, "Trouble syncing · last synced 2 hours ago");
  assert.equal(sourceStatusWords(source({ connection_health: health({ last_success_at: "2026-11-23T12:00:00Z" }), owner_state: { ...healthyState, resolver: "system_degraded" }, rendered_verdict: verdict("Missing data") }), { now: NOW }).words, "Trouble syncing · last synced yesterday");
  assert.equal(sourceStatusWords(source({ connection_health: health({ last_success_at: "2026-11-12T12:00:00Z" }), owner_state: { ...healthyState, resolver: "system_degraded" }, rendered_verdict: verdict("Missing data") }), { now: NOW }).words, "Trouble syncing · last synced 12 Nov");
  assert.equal(sourceStatusWords(source({ connection_health: health({ last_success_at: null }), owner_state: { ...healthyState, resolver: "system_degraded" }, rendered_verdict: verdict("Missing data") }), { now: NOW }).words, "Trouble syncing");
});

test("source page sentences use the same row and named slots for page-owned facts", () => {
  const sentence = (candidate: RefConnectorSummary) => sourceStateSentence(candidate, { now: NOW, name: "Example source" });
  assert.deepEqual(sentence(fixture(3)), { text: "Disconnected.", slot: "what_is_kept_and_what_set_up_again_does" });
  assert.deepEqual(sentence(fixture(5)), { text: "First sync needs a look.", slot: "what_you_can_do" });
  assert.deepEqual(sentence(fixture(8)), { text: "Example source needs you to sign in again. Last successful sync 2 hours ago.", slot: null });
  assert.deepEqual(sentence(fixture(13)), { text: "This is waiting on a fix from the people who maintain DataConnect. There is nothing for you to do.", slot: null });
  assert.deepEqual(sentence(fixture(14)), { text: "Some optional data is missing. Last synced 2 hours ago.", slot: null });
  assert.deepEqual(sentence(fixture(22)), { text: "Nothing imported yet.", slot: null });
});

test("coming times are relative, and a late schedule is said plainly", () => {
  const sentence = (candidate: RefConnectorSummary) => sourceStateSentence(candidate, { now: NOW, name: "Example source" }).text;
  const scheduleOf = fixture(12).schedule;
  assert.ok(scheduleOf);
  const inFourHours = new Date(NOW.getTime() + 4 * 60 * 60 * 1000).toISOString();
  assert.equal(sentence(source({ ...fixture(19), schedule: { ...scheduleOf, scheduler_backoff: null, next_due_at: inFourHours } })), "Up to date. Synced 2 hours ago; next in 4 hours.");
  assert.equal(sentence(fixture(19)), "Up to date. Synced 2 hours ago.");
  assert.equal(sentence(source({ ...fixture(19), connection_health: health({ lateness: { state: "late" } }) })), "Synced 2 hours ago. The next sync is late.");
  const inTwentyMinutes = new Date(NOW.getTime() + 20 * 60 * 1000).toISOString();
  assert.equal(
    sentence(source({ ...fixture(12), schedule: { ...scheduleOf, scheduler_backoff: { ...scheduleOf.scheduler_backoff!, next_run_at: inTwentyMinutes } } })),
    "The last sync did not finish. DataConnect will try again on its own in 20 minutes."
  );
  assert.equal(sentence(fixture(12)), "The last sync did not finish. DataConnect will try again on its own.");
});

test("all returned screen strings omit raw dates, ids, and internal vocabulary", () => {
  const forbidden = /\b(verdict|coverage|fleet|projection|grant|bearer|manifest|connector|run)\b|\b(?:cin|source|conn|run)_[A-Za-z0-9_-]+\b|\b\d{4}-\d{2}-\d{2}(?:T\S+)?/i;
  for (let row = 1; row <= 24; row += 1) {
    const candidate = fixture(row as SourceStatusRow);
    const strings = [
      sourceStatusWords(candidate, { now: NOW }).words,
      sourceStatusWords(candidate, { now: NOW }).action?.label ?? "",
      sourceStatusWords(candidate, { now: NOW }).action?.kind ?? "",
      sourceStateSentence(candidate, { now: NOW, name: "Example source" }).text,
    ];
    for (const value of strings) assert.equal(forbidden.test(value), false, `row ${row}: ${value}`);
  }
});
