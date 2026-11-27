// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import type { RefConnectionHealthSnapshot, RefConnectorSummary, RefRenderedVerdict, RefRequiredAction } from "./ref-client.ts";
import { isUpToDateRow, sourceStateSentence, sourceStatusWords, type SourceStatusRow } from "./source-status-words.ts";

const NOW = new Date("2026-11-24T12:00:00.000Z");
const SUCCESS = "2026-11-24T10:00:00.000Z";

test("a retired setup shell is never connected even with unavailable counts and leftover kinds", () => {
  const value = source({ source_visibility: "setup_failed", status: "revoked", total_records_state: "unobserved", total_records: 0, streams: ["messages"], last_successful_run: null, connection_health: health({ last_success_at: null }) });
  assert.equal(sourceStateSentence(value, { now: NOW, name: "Northwind" }).text, "Example source was never connected.");
  assert.equal(sourceStatusWords(value, { now: NOW }).action?.label, "Set up again");
});

test("a device with zero waiting records has no send-failure state", () => {
  const value = source({ source_kind: "local_device", local_device_progress: { records_pending: 0 } as RefConnectorSummary["local_device_progress"], owner_state: { resolver: "needs_owner" } as RefConnectorSummary["owner_state"], rendered_verdict: verdict("Some records stuck", [requiredAction({ surface: { kind: "local_device" } })]) });
  assert.doesNotMatch(sourceStateSentence(value, { now: NOW, name: "Northwind", unsentRecords: 0 }).text, /could not send|stuck/);
  assert.equal(sourceStatusWords(value, { now: NOW }).action, null);
});

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
    pill: { label, tone: label === "Collected, not independently checked" ? "grey" : label === "Healthy" || label === "Import complete" ? "green" : "amber" },
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
    connector_display_name: "Example source",
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

test("only the completed-import and up-to-date rows count as up to date", () => {
  assert.equal(isUpToDateRow(18), true);
  assert.equal(isUpToDateRow(19), true);
  assert.equal(isUpToDateRow(17), false);
  assert.equal(isUpToDateRow(20), false);
});

function assertRow(row: SourceStatusRow, words: string, tone: "plain" | "attention" | "accent" | "faint", expectedAction: ReturnType<typeof sourceStatusWords>["action"] = null) {
  // DIRECTION.md, "One status table": row 2 is not a needs-you row.
  const needsYou = expectedAction !== null;
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
    case 20: return source({ ...base, owner_state: { ...healthyState, posture: "frozen-since-last-run" }, rendered_verdict: verdict("Healthy") });
    case 21: return source({ ...base, owner_state: { ...healthyState, resolver: "not_measured" }, rendered_verdict: verdict("Collected, not independently checked"), last_successful_run: { event_count: 0, failure_reason: null, finished_at: SUCCESS, first_at: SUCCESS, last_at: SUCCESS, run_id: "run-success", started_at: SUCCESS, status: "succeeded" } });
    case 22: return source({ ...base, owner_state: { ...healthyState, resolver: "not_measured" }, last_successful_run: null, source_kind: "manual", connection_health: health({ last_success_at: null }) });
    case 23: return source({ ...base, owner_state: undefined, rendered_verdict: verdict("Healthy") });
    case 24: return source({ ...base, owner_state: undefined, rendered_verdict: null, connection_health: health({ last_success_at: null }), status: undefined, source_visibility: undefined });
  }
}

test("row 1 words an archived source", () => assertRow(1, "Archived", "faint"));
// DIRECTION.md, "One status table": row 2 is faint with an outlined action.
test("row 2 words a setup that never completed", () => assertRow(2, "Example source was never connected.", "faint", { kind: "continue_setup", label: "Set up again", filled: true }));
test("row 3 words a revoked source", () => assertRow(3, "Disconnected", "faint", { kind: "set_up_again", label: "Set up again", filled: false }));
test("row 4 words a source whose collector is not installed", () => assertRow(4, "The program for this service is not installed. Install it again to keep syncing.", "attention", { kind: "install", label: "Install again", filled: true }));
test("row 5 uses the server action or starts a sync when no server action exists", () => {
  const status = sourceStatusWords(fixture(5), { now: NOW });
  // DIRECTION.md, one status table row 5: the needs-you status has one next action.
  assert.deepEqual(status.action, { kind: "sync_now", label: "Retry first sync", filled: true });

  const serverAction = sourceStatusWords(source({
    ...fixture(5),
    rendered_verdict: verdict("Can't collect", [requiredAction({ cta: "Review setup" })]),
  }), { now: NOW });
  assert.deepEqual(serverAction.action, { kind: "review_setup", label: "Review setup", filled: true });

  const unavailableServerAction = sourceStatusWords(source({
    ...fixture(5),
    rendered_verdict: verdict("Can't collect", [requiredAction({ satisfied_when: { kind: "none" } })]),
  }), { now: NOW });
  assert.deepEqual(unavailableServerAction.action, { kind: "sync_now", label: "Retry first sync", filled: true });

  const pausedDevice = sourceStatusWords(source({
    ...fixture(5),
    source_kind: "local_device",
    status: "paused",
  }), { now: NOW });
  assert.deepEqual(pausedDevice.action, { kind: "view_device", label: "View this device", filled: true });
});
// Round 2 sources brief P3: first-sync retries use one action label.
test("first-sync retry actions use one label for both unverified first-sync rows", () => {
  const rowFive = sourceStatusWords(fixture(5), { now: NOW }).action;
  const rowSix = sourceStatusWords(fixture(6), { now: NOW }).action;
  assert.equal(rowFive?.label, "Retry first sync");
  assert.equal(rowSix?.label, "Retry first sync");
});
test("row 6 words an unverified empty first sync", () => assertRow(6, "First sync found no records", "attention", { kind: "retry_first_sync", label: "Retry first sync", filled: true }));
test("row 7 words a verified empty first sync", () => assertRow(7, "No records found", "plain", { kind: "review_result", label: "Review result", filled: false }));
test("row 8 words a required owner action", () => assertRow(8, "Needs you to sign in again", "attention", { kind: "server_cta", label: "Review this source", filled: true }));
test("a lifecycle-paused source stays out of needs-you when an owner action is stored", () => {
  const result = sourceStatusWords(source({
    status: "paused",
    owner_state: { ...healthyState, owner_of_state: "owner", resolver: "needs_owner" },
    rendered_verdict: verdict("Can't collect", [requiredAction({ kind: "reauth", surface: { kind: "browser_session" } })]),
  }), { now: NOW });
  assert.deepEqual(result, { row: 10, words: "Paused", tone: "faint", action: { kind: "resume", label: "Resume", filled: false }, needsYou: true });
});
test("an automatic schedule paused by its owner uses the server action, not lifecycle resume", () => {
  const schedule = fixture(12).schedule;
  assert.ok(schedule);
  const ownerPaused = source({
    status: "active",
    schedule: { ...schedule, enabled: false, scheduler_backoff: null },
    owner_state: { ...healthyState, owner_of_state: "owner", resolver: "owner_paused" },
    source_binding_kind: "historical_archive",
    rendered_verdict: verdict("Healthy", [requiredAction({ kind: "reattach_schedule", cta: "Resume schedule", surface: { kind: "schedule" } })]),
  });
  assert.deepEqual(sourceStatusWords(ownerPaused, { now: NOW }), {
    row: 10,
    words: "Automatic sync is off · last synced 2 hours ago",
    tone: "faint",
    action: { kind: "server_cta", label: "Resume schedule", filled: false },
    needsYou: true,
  });
  assert.equal(sourceStateSentence(ownerPaused, { now: NOW, name: "Example source" }).text, "Automatic sync is off. Last synced 2 hours ago.");

  const noSuccess = source({
    ...ownerPaused,
    connection_health: health({ last_success_at: null }),
    last_successful_run: null,
    rendered_verdict: verdict("Healthy"),
  });
  assert.deepEqual(sourceStatusWords(noSuccess, { now: NOW }).action, null);
  assert.equal(sourceStateSentence(noSuccess, { now: NOW, name: "Example source" }).text, "Automatic sync is off.");
});
test("row 9 words setup in progress", () => assertRow(9, "Setup in progress", "attention", { kind: "continue_setup", label: "Continue setup", filled: true }));
test("row 10 words a paused source", () => assertRow(10, "Paused", "faint", { kind: "resume", label: "Resume", filled: false }));
test("a paused archive sentence mentions sign-in only when repair is available", () => {
  // Round 2 sources brief P2: claim that sign-in is kept only when one exists.
  const archive = source({ ...fixture(10), source_binding_kind: "historical_archive" });
  assert.match(
    sourceStateSentence(archive, { now: NOW, name: "Example source", signInRepairAvailable: false }).text,
    /^Paused\. Your records are kept\./,
  );
  assert.match(
    sourceStateSentence(archive, { now: NOW, name: "Example source", signInRepairAvailable: true }).text,
    /^Paused\. Your records and sign-in are kept\./,
  );
});
test("row 11 words an active sync", () => assertRow(11, "Syncing now", "accent"));
test("a pending rendered status does not outrank the maintainer row when owner state exists", () => {
  const lastRun = fixture(11).last_run;
  assert.ok(lastRun);
  const result = sourceStatusWords(source({
    last_run: { ...lastRun, status: "pending" },
    owner_state: { ...healthyState, resolver: "blocked_maintainer" },
  }), { now: NOW });
  assert.equal(result.row, 13);
});
test("row 12 words an automatic retry", () => assertRow(12, "Trying again on its own · last synced 2 hours ago", "plain"));
test("row 13 words a wait for a maintainer fix", () => assertRow(13, "Waiting on a fix from the DataConnect maintainers", "plain"));
test("row 14 words missing optional data", () => assertRow(14, "Some optional data is missing · last synced 2 hours ago", "plain"));
test("row 15 words stuck records", () => assertRow(15, "Some records are stuck · last synced 2 hours ago", "plain"));
test("row 16 words another degraded result", () => assertRow(16, "Something stopped Example source from syncing.", "plain", { kind: "sync_now", label: "Try again", filled: true }));
test("row 17 words a refresh due", () => assertRow(17, "A refresh is due · last synced 2 hours ago", "plain", { kind: "sync_now", label: "Sync now", filled: false }));
test("row 18 words a completed import", () => assertRow(18, "Imported 2 hours ago", "plain"));
test("row 19 says up to date when healthy, green, observed and on time", () => assertRow(19, "Up to date · synced 2 hours ago", "plain"));
test("row 20 words a healthy source without a proven on-time schedule", () => assertRow(20, "Synced 2 hours ago", "plain"));
test("row 21 words a source with a past successful sync and no measured state", () => assertRow(21, "Synced 2 hours ago", "plain"));
test("the unchecked pill belongs to row 21, not the row 20 fixture", () => {
  assert.equal(fixture(20).rendered_verdict?.pill.label, "Healthy");
  assert.equal(fixture(21).rendered_verdict?.pill.label, "Collected, not independently checked");
  // DIRECTION.md row 21: use plain words instead of the banned word "gaps".
  assert.equal(sourceStateSentence(fixture(21), { now: NOW, name: "Example source" }).text, "Synced 2 hours ago. DataConnect has not compared this with Example source yet.");
});

test("pending detail work uses one shared sentence for rows 19 and 20", () => {
  // DIRECTION.md rows 19–20: pending detail wording belongs to the shared sentence function.
  for (const row of [19, 20] as const) {
    assert.equal(
      sourceStateSentence(fixture(row), { now: NOW, name: "Example source", pendingDetails: true }).text,
      "Synced 2 hours ago. Still checking a few things."
    );
  }
});
test("pending detail work never appends a second state to a stronger sentence", () => {
  // Intake repair: before this round the page added the note on every row; row 16 must not lose it.
  assert.equal(
    sourceStateSentence(fixture(16), { now: NOW, name: "Example source", pendingDetails: true }).text,
    sourceStateSentence(fixture(16), { now: NOW, name: "Example source" }).text
  );
});
test("row 22 words a manual import with no completed import", () => assertRow(22, "Nothing imported yet", "plain"));
test("row 23 uses the pill when the owner state is missing", () => assertRow(23, "Synced 2 hours ago", "plain"));
test("row 24 is used when lifecycle and pill evidence are absent", () => assertRow(24, "Status not available", "faint"));

test("row 8 chooses words from each owner action surface and preserves its CTA", () => {
  const cases = [
    ["browser_session", "Needs you to sign in again"],
    ["stored_credential", "Needs its saved sign-in details updated"],
    ["provider_interaction", "Something stopped Example source from syncing."],
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
    assert.deepEqual(result.action, surface === "local_device" ? null : surface === "provider_interaction" ? { kind: "sync_now", label: "Try again", filled: true } : { kind: "server_cta", label: surface === "stored_credential" ? "Update sign-in details" : cta, filled: true });
  }
});

test("row 19 requires all four facts, and each missing or false fact gives another row", () => {
  const upToDate = fixture(19);
  assert.equal(sourceStatusWords(upToDate, { now: NOW }).row, 19);
  // the server's state is not healthy
  assert.notEqual(sourceStatusWords(source({ ...upToDate, owner_state: { ...healthyState, resolver: "refresh_due" } }), { now: NOW }).row, 19);
  // the pill is not "Healthy"
  assert.equal(sourceStatusWords(source({ ...upToDate, rendered_verdict: verdict("Missing data") }), { now: NOW }).row, 20);
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
    // DIRECTION.md, "One status table": row 2 does not count as needs-you.
    assert.equal(result.needsYou, result.action !== null, `row ${row}`);
    if (result.action?.filled) assert.equal(result.needsYou, true, `row ${row}`);
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

// Round 2 sources brief P2: Home and the list cannot know the detail page's repair capability.
test("a paused historical archive names the resume action and keeps credential repair distinct", () => {
  const archive = source({ ...fixture(10), source_binding_kind: "historical_archive" });
  // The source page uses this action to resume the archived source directly.
  assert.deepEqual(
    sourceStatusWords(archive, { now: NOW, signInRepairAvailable: false }).action,
    { kind: "resume", label: "Resume", filled: false }
  );
  assert.deepEqual(
    sourceStatusWords(archive, { now: NOW, signInRepairAvailable: true }).action,
    { kind: "repair_credential", label: "Resume", filled: false }
  );
  // The home and list do not know whether the source page can resume directly.
  assert.deepEqual(sourceStatusWords(archive, { now: NOW }).action, { kind: "repair_credential", label: "Resume", filled: false });
  // No server sign-in action does not mean no sign-in is needed.
  assert.equal(sourceStatusWords(archive, { now: NOW, signInRepairAvailable: true }).action?.kind, "repair_credential");
});

test("rows 17 and 22 offer sync only when this server can start it", () => {
  assert.equal(sourceStatusWords(source({ ...fixture(17), source_kind: "manual" }), { now: NOW }).action, null);
  assert.equal(sourceStatusWords(source({ ...fixture(22), source_kind: "account" }), { now: NOW }).action?.kind, "sync_now");
  assert.equal(sourceStatusWords(source({ ...fixture(22), source_kind: "browser_collector" }), { now: NOW }).action?.kind, "sync_now");
  assert.equal(sourceStatusWords(source({ ...fixture(22), source_kind: "manual" }), { now: NOW }).action, null);
});

test("first matching row wins for overlapping evidence", () => {
  const scheduleOf = fixture(12).schedule;
  assert.ok(scheduleOf);
  const schedulerBackoff = scheduleOf.scheduler_backoff;
  assert.ok(schedulerBackoff);
  const pairs: Array<[RefConnectorSummary, SourceStatusRow]> = [
    [source({ source_visibility: "archived", status: "paused", owner_state: { ...healthyState, resolver: "owner_paused" } }), 1],
    [source({ source_visibility: "setup_failed", status: "revoked", revoked_at: SUCCESS }), 2],
    [source({ status: "revoked", connector_implementation: { connector_id: "sample", state: "not_installed" } }), 3],
    [source({ connector_implementation: { connector_id: "sample", state: "not_installed" }, terminal_setup_disposition: "verified_empty" }), 4],
    [source({ terminal_setup_disposition: "unverified_missing_counts", owner_state: { ...healthyState, resolver: "needs_owner" } }), 5],
    [source({ status: "paused", owner_state: { ...healthyState, owner_of_state: "owner", resolver: "needs_owner" }, rendered_verdict: verdict("Can't collect", [requiredAction()]) }), 10],
    [source({ status: "paused", source_binding_kind: "historical_archive", schedule: fixture(12).schedule, owner_state: { ...healthyState, resolver: "owner_paused" } }), 10],
    [source({ last_run: fixture(11).last_run, schedule: fixture(12).schedule, owner_state: { ...healthyState, resolver: "collecting" } }), 11],
    [source({ schedule: fixture(12).schedule, owner_state: { ...healthyState, resolver: "system_degraded" }, rendered_verdict: verdict("Missing data") }), 12],
    [source({ ...fixture(12), owner_state: { ...healthyState, resolver: "blocked_maintainer" } }), 13],
    [source({ ...fixture(12), schedule: { ...scheduleOf, scheduler_backoff: { ...schedulerBackoff, recommended_health_state: "blocked" } }, rendered_verdict: verdict("Missing optional data") }), 14],
    [source({ ...fixture(13), schedule: scheduleOf }), 13],
  ];
  for (const [candidate, expected] of pairs) assert.equal(sourceStatusWords(candidate, { now: NOW }).row, expected);
});

test("relative time and old dates have the required human forms and omit missing time", () => {
  assert.equal(sourceStatusWords(source({ connection_health: health({ last_success_at: "2026-11-24T12:05:00Z" }), owner_state: { ...healthyState, resolver: "system_degraded" }, rendered_verdict: verdict("Missing data") }), { now: NOW }).words, "Something stopped Example source from syncing.");
  assert.equal(sourceStatusWords(source({ connection_health: health({ last_success_at: "2026-11-24T10:00:00Z" }), owner_state: { ...healthyState, resolver: "system_degraded" }, rendered_verdict: verdict("Missing data") }), { now: NOW }).words, "Something stopped Example source from syncing.");
  assert.equal(sourceStatusWords(source({ connection_health: health({ last_success_at: "2026-11-23T12:00:00Z" }), owner_state: { ...healthyState, resolver: "system_degraded" }, rendered_verdict: verdict("Missing data") }), { now: NOW }).words, "Something stopped Example source from syncing.");
  assert.equal(sourceStatusWords(source({ connection_health: health({ last_success_at: "2026-11-12T12:00:00Z" }), owner_state: { ...healthyState, resolver: "system_degraded" }, rendered_verdict: verdict("Missing data") }), { now: NOW }).words, "Something stopped Example source from syncing.");
  assert.equal(sourceStatusWords(source({ connection_health: health({ last_success_at: null }), owner_state: { ...healthyState, resolver: "system_degraded" }, rendered_verdict: verdict("Missing data") }), { now: NOW }).words, "Something stopped Example source from syncing.");
});

test("source page sentences use the same row and named slots for page-owned facts", () => {
  const sentence = (candidate: RefConnectorSummary) => sourceStateSentence(candidate, { now: NOW, name: "Example source" });
  assert.deepEqual(sentence(fixture(3)), { text: "Disconnected. Your records stay.", slot: null });
  assert.deepEqual(sentence(fixture(5)), { text: "The first copy of Example source may not be complete.", slot: "what_you_can_do" });
  assert.deepEqual(sentence(fixture(8)), { text: "Example source needs you to sign in again.", slot: null });
  assert.deepEqual(sentence(fixture(13)), { text: "This is waiting on a fix from the people who maintain DataConnect.", slot: null });
  assert.deepEqual(sentence(fixture(14)), { text: "Some optional data is missing. Last synced 2 hours ago.", slot: null });
  assert.deepEqual(sentence(fixture(22)), { text: "Nothing imported yet. Add an export to copy your records.", slot: null });
});

test("started time comes only from an active last run", () => {
  const collecting = { ...healthyState, resolver: "collecting" as const };
  const lastRun = fixture(11).last_run;
  assert.ok(lastRun);
  const notActive = source({
    owner_state: { ...collecting, evidence_as_of: "2026-11-21T12:00:00.000Z" },
    last_run: { ...lastRun, started_at: "2026-11-21T12:00:00.000Z", status: "succeeded" },
  });
  assert.equal(sourceStateSentence(notActive, { now: NOW, name: "Example source" }).text, "Syncing now.");

  for (const status of ["pending", "started", "in_progress", "running"]) {
    const active = source({
      owner_state: { ...collecting, evidence_as_of: "2026-11-21T12:00:00.000Z" },
      last_run: { ...lastRun, started_at: "2026-11-24T11:55:00.000Z", status },
    });
    assert.equal(sourceStateSentence(active, { now: NOW, name: "Example source" }).text, "Syncing now. Started 5 minutes ago.", status);
  }
});

test("coming times are relative, and a late schedule is said plainly", () => {
  const sentence = (candidate: RefConnectorSummary) => sourceStateSentence(candidate, { now: NOW, name: "Example source" }).text;
  const scheduleOf = fixture(12).schedule;
  assert.ok(scheduleOf);
  const schedulerBackoff = scheduleOf.scheduler_backoff;
  assert.ok(schedulerBackoff);
  const inFourHours = new Date(NOW.getTime() + 4 * 60 * 60 * 1000).toISOString();
  assert.equal(sentence(source({ ...fixture(19), schedule: { ...scheduleOf, scheduler_backoff: null, next_due_at: inFourHours } })), "Up to date. Synced 2 hours ago.");
  assert.equal(sentence(fixture(19)), "Up to date. Synced 2 hours ago.");
  assert.equal(sentence(source({ ...fixture(19), connection_health: health({ lateness: { state: "late" } }) })), "Synced 2 hours ago. The next sync is late.");
  const inTwentyMinutes = new Date(NOW.getTime() + 20 * 60 * 1000).toISOString();
  const successfulRun = fixture(21).last_successful_run;
  assert.ok(successfulRun);
  assert.equal(
    sentence(source({ ...fixture(12), schedule: { ...scheduleOf, scheduler_backoff: { ...schedulerBackoff, next_run_at: inTwentyMinutes } } })),
    "The last sync did not finish. DataConnect will try again on its own in 20 minutes."
  );
  assert.equal(
    sentence(source({
      ...fixture(12),
      last_successful_run: successfulRun,
      schedule: { ...scheduleOf, scheduler_backoff: { ...schedulerBackoff, consecutive_failures: 0, reason_class: "source_pressure", next_run_at: inTwentyMinutes } },
    })),
    "Example source asked DataConnect to slow down. It will try again on its own in 20 minutes."
  );
  assert.equal(
    sentence(source({
      ...fixture(12),
      last_successful_run: successfulRun,
      schedule: { ...scheduleOf, scheduler_backoff: { ...schedulerBackoff, consecutive_failures: 0, reason_class: "retry", next_run_at: inTwentyMinutes } },
    })),
    "Example source asked DataConnect to slow down. It will try again on its own in 20 minutes."
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

  const serverCtaSource = source({
    owner_state: { ...healthyState, owner_of_state: "owner", resolver: "needs_owner" },
    rendered_verdict: verdict("Can't collect", [requiredAction({ cta: "Review account" })]),
  });
  const serverCta = sourceStatusWords(serverCtaSource, { now: NOW });
  assert.equal(serverCta.row, 8);
  for (const value of [serverCta.words, serverCta.action?.label ?? "", sourceStateSentence(serverCtaSource, { now: NOW, name: "Example source" }).text]) {
    assert.equal(forbidden.test(value), false, `server CTA: ${value}`);
  }
});

test("only the sole unmeasured-completeness maintainer cause gets the plain synced sentence", () => {
  const unmeasured = requiredAction({ audience: "maintainer", kind: "code_fix", surface: { kind: "maintainer" }, satisfied_when: { kind: "none" }, cta: "Some data from this source isn't being measured yet", urgency: "soon" });
  const base = source({ owner_state: { ...healthyState, resolver: "blocked_maintainer" }, rendered_verdict: verdict("Not measured", [unmeasured]) });
  const words = sourceStatusWords(base, { now: NOW });
  assert.equal(words.words, "Synced 2 hours ago. DataConnect can't yet tell whether it got everything.");
  assert.equal(words.needsYou, words.action !== null);
  assert.equal(words.tone, "plain");
  assert.equal(words.action, null);
  assert.equal(sourceStateSentence(base, { now: NOW, name: "Northwind" }).text, words.words);
  for (const actions of [[{ ...unmeasured, cta: "Fix the copy" }], [{ ...unmeasured, terminal: true }], [unmeasured, requiredAction()]]) {
    assert.match(sourceStateSentence({ ...base, rendered_verdict: verdict("Not measured", actions) }, { now: NOW, name: "Northwind" }).text, /waiting on a fix/);
  }
  assert.match(sourceStateSentence({ ...base, last_run: { run_id: "failed", status: "failed", event_count: 0, failure_reason: "failed", first_at: SUCCESS, last_at: SUCCESS, started_at: SUCCESS, finished_at: SUCCESS } }, { now: NOW, name: "Northwind" }).text, /waiting on a fix/);
  assert.match(sourceStateSentence({ ...base, connection_health: health({ last_success_at: null }) }, { now: NOW, name: "Northwind" }).text, /waiting on a fix/);
});

test("retired setup visibility is authoritative despite leftover measurement evidence", () => {
  const base = source({ source_visibility: "setup_failed", total_records: 0, total_records_state: "known_zero", connection_health: health({ last_success_at: null }) });
  assert.equal(sourceStateSentence(base, { now: NOW, name: "Northwind" }).text, "Example source was never connected.");
  assert.equal(sourceStatusWords(base, { now: NOW }).action?.label, "Set up again");
  for (const change of [{ total_records: 1 }, { total_records_state: "unknown" as const }, { connection_health: health() }]) {
    assert.match(sourceStateSentence({ ...base, ...change }, { now: NOW, name: "Northwind" }).text, /was never connected/);
  }
});

test("a paused device sentence names where to resume", () => {
  const local = source({ status: "paused", source_kind: "local_device", owner_state: { ...healthyState, resolver: "owner_paused" } });
  assert.equal(sourceStateSentence(local, { now: NOW, name: "Northwind", deviceName: "Work computer" }).text, "Paused on Work computer. Resume it there.");
});

test("a run waiting for a security code is not a failure and leads to the place the code is entered", () => {
  const waiting = source({
    owner_state: { ...healthyState, owner_of_state: "owner", resolver: "needs_owner" },
    connection_health: health({ conditions: [{ expires_at: null, id: "AttentionClear:otp_required", message: "Owner action is required before collection can continue.", observed_at: null, origin: "runtime", reason: "otp_required", remediation: null, sensitivity: "owner", severity: "blocked", status: "false", type: "AttentionClear" } as never] }),
    rendered_verdict: verdict("Can't collect", [requiredAction({ cta: "Complete the requested action", kind: "add_info", surface: { kind: "provider_interaction" }, target: { kind: "sync", run_id: "run-test" }, satisfied_when: { kind: "attention_resolved" } })]),
    connector_display_name: "Venmo",
  });
  const result = sourceStatusWords(waiting, { now: NOW });
  assert.equal(result.row, 8);
  assert.equal(result.words, "Venmo is waiting for a security code.");
  assert.deepEqual(result.action, { kind: "server_cta", label: "Enter the code", filled: true });
  assert.equal(sourceStateSentence(waiting, { now: NOW, name: "Venmo" }).text, "Venmo is waiting for a security code.");
});

function failedRun(connector_error: unknown, terminal_reason = "connector_reported_failed") {
  return { event_count: 0, failure_reason: null, finished_at: SUCCESS, first_at: SUCCESS, last_at: SUCCESS, run_id: "run-test", started_at: SUCCESS, status: "failed", terminal_reason, connector_error } as never;
}
const blockedByMaintainer = { ...healthyState, owner_of_state: "maintainer" as const, resolver: "blocked_maintainer" as const };
const automaticSchedule = { active_run_id: null, automation_mode: "unattended", automation_summary: "Automatic", connector_id: "sample", created_at: SUCCESS, effective_mode: "automatic", enabled: true, human_attention_needed: false, ineligibility_reason: null, interval_seconds: 3600, jitter_seconds: 0, minimum_interval_warning: null, next_due_at: null, notification_posture: "none", object: "schedule", scheduler_backoff: null, trigger_kind: "scheduled", updated_at: SUCCESS } as never;
const maintainerAction = requiredAction({ audience: "maintainer", kind: "code_fix", cta: "Coverage gap needs review", surface: { kind: "maintainer" }, satisfied_when: { kind: "none" } });

test("a service that was unavailable is not a wait on the maintainers", () => {
  const unavailable = { code: "upstream_unavailable", message: "Steam answered 503", origin: null, retryable: true };
  const base = { connector_display_name: "Steam", owner_state: blockedByMaintainer, last_run: failedRun(unavailable), rendered_verdict: verdict("Can't collect", [maintainerAction]) };
  const withSchedule = sourceStatusWords(source({ ...base, schedule: automaticSchedule }), { now: NOW });
  assert.equal(withSchedule.words, "Steam was not available. DataConnect will try again at the next check.");
  assert.equal(withSchedule.action, null);
  const manual = sourceStatusWords(source(base), { now: NOW });
  assert.equal(manual.words, "Steam was not available.");
  assert.deepEqual(manual.action, { kind: "sync_now", label: "Try again", filled: true });
});

test("a rejected saved key asks for the key, never for another sync", () => {
  const rejected = { code: "invalid_credentials", message: "Steam rejected the key", origin: null, retryable: false };
  const result = sourceStatusWords(source({ connector_display_name: "Steam", source_binding_kind: "static_secret", owner_state: blockedByMaintainer, last_run: failedRun(rejected), rendered_verdict: verdict("Can't collect", [maintainerAction]) }), { now: NOW });
  assert.equal(result.words, "Steam no longer accepts the saved key.");
  assert.deepEqual(result.action, { kind: "repair_sign_in", label: "Enter the key again", filled: true });
});

test("only a fault in DataConnect's own program keeps the maintainers sentence", () => {
  const result = sourceStatusWords(source({ connector_display_name: "Steam", owner_state: blockedByMaintainer, last_run: failedRun(null, "connector_protocol_violation"), rendered_verdict: verdict("Can't collect", [maintainerAction]) }), { now: NOW });
  assert.equal(result.row, 13);
  assert.equal(result.words, "Waiting on a fix from the DataConnect maintainers");
});

test("a sign-in that expired is the person's step even when the server blames the program", () => {
  const expired = { code: "session_expired", message: "Venmo ended the session", origin: null, retryable: false };
  const result = sourceStatusWords(source({ connector_display_name: "Venmo", owner_state: blockedByMaintainer, last_run: failedRun(expired), rendered_verdict: verdict("Can't collect", [maintainerAction]) }), { now: NOW });
  assert.equal(result.words, "Venmo asked for a new sign-in.");
  assert.equal(result.action?.label, "Sign in again");
});

test("an idle source that only syncs when asked is not broken", () => {
  const idle = source({
    connector_display_name: "Steam",
    owner_state: { ...healthyState, resolver: "system_degraded" },
    rendered_verdict: verdict("Needs refresh"),
    connection_health: health({ last_success_at: "2026-11-14T12:00:00Z" }),
    last_run: { event_count: 0, failure_reason: null, finished_at: "2026-11-14T12:00:00Z", first_at: "2026-11-14T12:00:00Z", last_at: "2026-11-14T12:00:00Z", run_id: "run-test", started_at: "2026-11-14T12:00:00Z", status: "succeeded" } as never,
  });
  const manual = sourceStatusWords({ ...idle, schedule: null }, { now: NOW });
  assert.equal(manual.words, "Last synced 14 Nov. DataConnect checks Steam only when you ask.");
  assert.deepEqual(manual.action, { kind: "sync_now", label: "Sync now", filled: false });
  assert.equal(sourceStateSentence({ ...idle, schedule: null }, { now: NOW, name: "Steam" }).text, manual.words);
  const scheduled = sourceStatusWords({ ...idle, schedule: automaticSchedule }, { now: NOW });
  assert.equal(scheduled.words, "A refresh is due · last synced 14 Nov");
  assert.deepEqual(scheduled.action, { kind: "sync_now", label: "Sync now", filled: false });
});
