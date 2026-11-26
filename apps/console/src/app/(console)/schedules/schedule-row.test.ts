// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as React from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { mock, test } from "node:test";
import type { RefConnectorSummary } from "../lib/ref-client.ts";
import { formatIntervalWords } from "./schedule-cadence-words.ts";

const deleteCalls: unknown[][] = [];
mock.module(new URL("./actions.ts", import.meta.url).href, {
  namedExports: {
    deleteScheduleAction: async (...args: unknown[]) => {
      deleteCalls.push(args);
      return { ok: true };
    },
    pauseScheduleAction: async () => ({ ok: true }),
    resumeScheduleAction: async () => ({ ok: true }),
    upsertScheduleAction: async () => ({ ok: true }),
  },
});
mock.module("next/navigation", {
  namedExports: {
    usePathname: () => "/schedules",
    useRouter: () => ({ refresh() {} }),
    useSearchParams: () => new URLSearchParams(),
  },
});

(globalThis as typeof globalThis & { React?: typeof React }).React = React;

const ROW_FILE = new URL("schedule-row.tsx", import.meta.url);

const CONNECTION_TARGET = /summary\.connection_id \?\? summary\.connector_instance_id \?\? null/;
const UPSERT_RECEIVES_CONNECTION =
  /upsertScheduleAction\(summary\.connector_id,[\s\S]*connectionId: summary\.connection_id \?\? summary\.connector_instance_id \?\? null/;
const PAUSE_RECEIVES_CONNECTION =
  /pauseScheduleAction\([\s\S]*?summary\.connector_id,[\s\S]*?summary\.connection_id \?\? summary\.connector_instance_id \?\? null[\s\S]*?\)/;
const RESUME_RECEIVES_CONNECTION =
  /resumeScheduleAction\([\s\S]*?summary\.connector_id,[\s\S]*?summary\.connection_id \?\? summary\.connector_instance_id \?\? null[\s\S]*?\)/;
const DELETE_RECEIVES_CONNECTION =
  /deleteScheduleAction\([\s\S]*?summary\.connector_id,[\s\S]*?summary\.connection_id \?\? summary\.connector_instance_id \?\? null[\s\S]*?\)/;
const ONLY_WHEN_YOU_ASK_RE = /Only when you ask/;
const FINAL_SCHEDULE_ROW_BORDER_RE = /className="border-border\/70 border-b py-3 last:border-b-0"/;

test("schedule-row mutates the concrete connection when one is present", async () => {
  const src = await readFile(ROW_FILE, "utf8");
  assert.match(src, CONNECTION_TARGET);
  assert.match(src, UPSERT_RECEIVES_CONNECTION);
  assert.match(src, PAUSE_RECEIVES_CONNECTION);
  assert.match(src, RESUME_RECEIVES_CONNECTION);
  assert.match(src, DELETE_RECEIVES_CONNECTION);
});

test("schedule cadence is shown in plain words", () => {
  // DIRECTION.md, Values: times use words, not compact unit labels.
  assert.equal(formatIntervalWords(21_600), "Every 6 hours");
  assert.equal(formatIntervalWords(86_400), "Every day");
  assert.equal(formatIntervalWords(1_800), "Every 30 minutes");
});

test("schedule editor warnings use plain data source and sync wording", async () => {
  const src = await readFile(ROW_FILE, "utf8");
  const warningStart = src.indexOf("function frictionWarning");
  const warning = src.slice(warningStart, src.indexOf("function ScheduleEditor", warningStart));
  // PAGE-RULES.md #4: keep system words out of visible copy.
  assert.match(warning, /This data source/);
  assert.doesNotMatch(warning, /\b(?:connector|runs?)\b/i);
});

test("schedule deletion asks before calling the existing delete action", async () => {
  const src = await readFile(ROW_FILE, "utf8");
  // DIRECTION.md, What must stay true #5: destructive actions have a confirmation step.
  assert.match(src, /onClick=\{\(\) => setConfirmingDelete\(true\)\}[^>]*>Delete<\/IcButton>/);
  assert.match(src, /role="alertdialog"/);
  assert.match(src, /Delete the schedule for \{displayName\}\? Automatic syncs will stop; your records will stay\./);
  assert.match(src, /onClick=\{handleDelete\}[^>]*>Delete schedule<\/IcButton>/);
});

test("Cancel on the delete confirmation sends nothing; only Delete schedule calls the delete action", async () => {
  // RAISE-RULES 5: a destructive action asks first, and backing out changes nothing.
  const { ScheduleRow } = await import("./schedule-row.tsx");
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost/schedules" });
  Object.assign(globalThis, {
    document: dom.window.document,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    // next/link schedules prefetch through `self.requestIdleCallback`.
    self: dom.window,
    window: dom.window,
  });
  const container = dom.window.document.getElementById("root");
  assert.ok(container);
  const root = createRoot(container);
  const button = (label: string) => {
    const found = [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
    assert.ok(found, `button "${label}" must be present`);
    return found;
  };
  deleteCalls.length = 0;
  try {
    await act(async () => root.render(createElement(ScheduleRow, { runsHref: "/syncs", summary: makeSummary({ schedule: makeSchedule() }) })));
    await act(async () => button("Delete").click());
    assert.match(container.textContent ?? "", /Delete the schedule for Example source\?/);
    await act(async () => button("Cancel").click());
    assert.equal(deleteCalls.length, 0, "Cancel must not call the delete action");
    assert.doesNotMatch(container.textContent ?? "", /Delete the schedule for/);

    await act(async () => button("Delete").click());
    await act(async () => button("Delete schedule").click());
    assert.deepEqual(deleteCalls, [["sample", "source-test-id"]]);
  } finally {
    await act(async () => root.unmount());
  }
});

test("schedule rows use the shared source status and identify the same data source", async () => {
  const src = await readFile(ROW_FILE, "utf8");
  // DIRECTION.md, One status, from one place: never write a page-local classifier.
  assert.match(src, /sourceStatusWords\(summary, \{ now: new Date\(\) \}\)/);
  assert.match(src, /data-source-id=\{summary\.connection_id\} data-status-row=\{sourceStatus\.row\}/);
  assert.match(src, /<SourceStatusText status=\{sourceStatus\} \/>/);
});

test("schedule editor and action errors remain visible when row details are closed", async () => {
  const src = await readFile(ROW_FILE, "utf8");
  // PAGE-RULES.md #1: moving technical facts into Details must keep controls usable.
  const editorIndex = src.indexOf("{editState === \"editing\" && (");
  const detailsIndex = src.indexOf("<details className=\"text-[13px] text-muted-foreground\">");
  const toastIndex = src.indexOf("{toast && (");
  assert.ok(editorIndex >= 0 && editorIndex < detailsIndex);
  assert.ok(toastIndex >= 0 && toastIndex < detailsIndex);
  assert.match(src, /Next sync <IcTimestamp mode="relative" value=\{schedule\.next_due_at\} \/>/);
});

test("schedule row empty and populated states use plain visible words", async () => {
  const { ScheduleRow } = await import("./schedule-row.tsx");
  const emptyMarkup = renderToStaticMarkup(createElement(ScheduleRow, { runsHref: "/syncs", summary: makeSummary() }));
  const emptyDocument = new JSDOM(emptyMarkup).window.document;
  for (const details of emptyDocument.querySelectorAll("details")) details.remove();
  const emptyText = emptyDocument.body.textContent ?? "";
  assert.match(emptyText, /Example source/);
  assert.match(emptyText, /Manual/);
  // history-repair brief P3: Manual already means "Only when you ask" on this row.
  assert.doesNotMatch(emptyText, ONLY_WHEN_YOU_ASK_RE);
  assert.doesNotMatch(emptyText, BANNED_VISIBLE_WORDS);

  const scheduled = makeSummary({ schedule: makeSchedule() });
  const rowMarkup = renderToStaticMarkup(createElement(ScheduleRow, { runsHref: "/syncs", summary: scheduled }));
  const rowDocument = new JSDOM(rowMarkup).window.document;
  for (const details of rowDocument.querySelectorAll("details")) details.remove();
  const rowText = rowDocument.body.textContent ?? "";
  assert.match(rowText, /Every 6 hours/);
  assert.match(rowText, /Next sync/);
  assert.match(rowText, /Pause/);
  assert.match(rowText, /Edit/);
  assert.doesNotMatch(rowText, BANNED_VISIBLE_WORDS);
});

test("schedule rows use the manifest name when the saved connection name is its key", async () => {
  const { ScheduleRow } = await import("./schedule-row.tsx");
  const markup = renderToStaticMarkup(
    createElement(ScheduleRow, {
      runsHref: "/syncs",
      summary: makeSummary({ connector_display_name: "Sample", display_name: "SAMPLE" }),
    })
  );
  const text = new JSDOM(markup).window.document.body.textContent ?? "";

  assert.match(text, /Sample/);
  assert.doesNotMatch(text, /SAMPLE/);
});

test("the final Schedules row leaves one hairline before page Details", async () => {
  const src = await readFile(ROW_FILE, "utf8");
  // history-repair brief P3: the final row border must not double with the page Details border.
  assert.match(src, FINAL_SCHEDULE_ROW_BORDER_RE);
});

const BANNED_VISIBLE_WORDS = /\b(verdict|coverage|fleet|projection|grant|bearer|manifest|runs?|stream|connector|instance|reference server)\b/i;

function makeSummary(overrides: Partial<RefConnectorSummary> = {}): RefConnectorSummary {
  return {
    connection_health: {
      axes: { attention: "none", coverage: "complete", freshness: "fresh", outbox: "idle" },
      badges: { stale: false, syncing: false },
      last_success_at: null,
      lateness: { state: "on_time" },
      next_action: null,
      next_attempt_at: null,
      reason_code: null,
      state: "healthy",
      unknown_reasons: [],
    },
    connection_id: "source-test-id",
    connector_id: "sample",
    display_name: "Example source",
    freshness: {},
    last_run: null,
    last_successful_run: null,
    manifest_version: null,
    next_action: null,
    rendered_verdict: null,
    schedule: null,
    source_kind: "manual",
    status: "active",
    streams: [],
    total_records: 0,
    ...overrides,
  } as RefConnectorSummary;
}

function makeSchedule(): NonNullable<RefConnectorSummary["schedule"]> {
  return {
    active_run_id: null,
    automation_mode: "unattended",
    automation_summary: "Automatic",
    connector_id: "sample",
    created_at: "2026-11-24T10:00:00.000Z",
    effective_mode: "automatic",
    enabled: true,
    human_attention_needed: false,
    ineligibility_reason: null,
    interval_seconds: 21_600,
    jitter_seconds: 0,
    last_error_code: null,
    last_finished_at: null,
    last_started_at: null,
    last_successful_at: null,
    minimum_interval_warning: null,
    next_due_at: "2026-11-24T18:00:00.000Z",
    notification_posture: "none",
    object: "schedule",
    recommended_policy: null,
    scheduler_backoff: null,
    trigger_kind: "scheduled",
    updated_at: "2026-11-24T10:00:00.000Z",
  };
}

for (const state of ["mixed", "paused", "none"]) {
  test(`plain schedule practice ${state} has one schedule sentence and no diagnostics`, async () => {
    const { buildSchedulePractice } = await import("./schedule-presentation.ts");
    const { ScheduleRow } = await import("./schedule-row.tsx");
    const rows = buildSchedulePractice(state)!;
    const markup = rows.map((summary) => renderToStaticMarkup(createElement(ScheduleRow, { summary, runsHref: "/syncs", presentation: "plain", practice: true }))).join("");
    const document = new JSDOM(markup).window.document;
    assert.equal(document.querySelectorAll("details").length, 0);
    assert.doesNotMatch(document.body.textContent ?? "", /Synced|Manual|Jitter|heartbeat|connector|PDPP|Last success/);
    if (state === "paused") assert.equal(document.querySelectorAll("li").length, 32);
  });
}
