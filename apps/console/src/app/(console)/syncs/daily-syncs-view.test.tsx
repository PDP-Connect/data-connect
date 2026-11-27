// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { sourceAnswer } from "../lib/source-status-words.ts";
import { syncPractice } from "../history/practice.ts";
import { buildSourcesDemoSummaries } from "../sources/sources-demo-data.ts";
import { SyncHistoryDays, syncDayProblem } from "./daily-syncs-view.tsx";

Object.assign(globalThis, { React });

function fixture() {
  const model = syncPractice("mixed", 0);
  if (model.history.mode !== "days") throw new Error("mode");
  const base = model.history.data[0]!;
  return { base, model };
}

test("healthy now does not hide yesterday's failed check", () => {
  const { base, model } = fixture();
  const older = { ...base, currentProblem: false, day: "2026-08-13", failed: 1, last_outcome: "failed" as const, missing: undefined };
  assert.equal(syncDayProblem(older), true, "a past failure is a problem even when the source is healthy now");
  const html = renderToStaticMarkup(createElement(SyncHistoryDays, { offset: 0, onlyProblems: true, rows: [older], sources: model.sources }));
  assert.match(html, /Failed/, "Only problems still lists the older failed day");
  const clean = { ...older, failed: 0, stopped: 0, interrupted: 0, could_not_start: 0, last_outcome: "finished" as const };
  assert.equal(syncDayProblem(clean), false);
});

test("a current problem adds to the past, and a past one is not erased by a healthy source", () => {
  const { base } = fixture();
  const quiet = { ...base, could_not_start: 0, failed: 0, interrupted: 0, missing: undefined, stopped: 0 };
  assert.equal(syncDayProblem({ ...quiet, currentProblem: true }), true);
  assert.equal(syncDayProblem({ ...quiet, currentProblem: false }), false);
});

test("history repair label matches its destination", () => {
  const { base, model } = fixture();
  const source = buildSourcesDemoSummaries("mixed")[0]!;
  const answer = sourceAnswer({ ...source, last_run: { ...source.last_run!, failure_reason: "session_expired", status: "failed" }, owner_state: { ...source.owner_state!, resolver: "system_degraded" } }, { now: new Date() });
  assert.equal(answer.action?.label, "Sign in again");
  const row = { ...base, currentState: "Now: Venmo asked for a new sign-in.", failed: 1, last_outcome: "failed" as const };
  const sources = model.sources.map((entry) => (entry.id === row.connection_id ? { ...entry, currentAnswer: answer } : entry));
  const html = renderToStaticMarkup(createElement(SyncHistoryDays, { expand: true, offset: 0, rows: [row], sources }));
  // The link opens the data source's page, so it says so; it does not promise the step itself.
  assert.doesNotMatch(html, />Sign in again</);
  assert.match(html, /Open source to sign in again</);
});

test("large counts in the fold use separators", () => {
  const { base, model } = fixture();
  const rows = Array.from({ length: 1204 }, (_, index) => ({ ...base, connection_id: `conn-${index}`, day: "2026-08-13", failed: 0, interrupted: 0, last_outcome: "finished" as const, missing: undefined, stopped: 0, could_not_start: 0, currentProblem: false }));
  const html = renderToStaticMarkup(createElement(SyncHistoryDays, { offset: 0, rows, sources: model.sources }));
  assert.match(html, /1,204 data sources checked/);
});

// Round 8 (F45): the empty state's text and its button have a gap, as other pages' empty states do.
test("the empty history keeps a gap between its text and its button", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("./daily-syncs-view.tsx", import.meta.url), "utf8");
  assert.match(source, /<div className="grid justify-items-start gap-4"><p>Nothing has synced yet\.<\/p>[\s\S]*?Add a data source<\/Link><\/div>/);
});
