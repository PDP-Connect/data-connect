// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { DailySyncsView } from "../syncs/daily-syncs-view.tsx";
import { SyncDayView } from "../syncs/day/sync-day-view.tsx";
import { SYNC_STATES, SYNC_DAY_STATES, syncPractice, syncDayPractice } from "./practice.ts";
import { personDay } from "./day-cut.ts";
(globalThis as typeof globalThis & { React: typeof React }).React = React;
const banned = /\b(run|trace|grant|stream|checkpoint|gap|rejected|surface|skipped|abandoned|succeeded|collected|Peek|events|Duration|PDPP|install|package|connector|manifest|digest|registered|operator|instance|dashboard|modality|credential|seal|coverage|fetched|retryable|outbox|heartbeat|backoff|configuration|revision|client|scope|OAuth|bearer|token|registration|consent|revoke|revoked|issued)\b|\d{2}:\d{2}:\d{2}|\b[a-z]+_[a-z]+_/i;
export function assertPlain(node: React.ReactElement) {
  const document = new JSDOM(renderToStaticMarkup(node)).window.document;
  for (const link of document.querySelectorAll("a")) if (link.textContent === "Technical details") link.remove();
  assert.doesNotMatch(document.body.textContent ?? "",banned);
  return document;
}
for (const state of SYNC_STATES) test(`sync history practice ${state} uses plain words and truthful counts`, () => {
  const model = syncPractice(state,120);
  assert.equal(model.history.mode,"days"); if (model.history.mode !== "days") return;
  const document = assertPlain(<DailySyncsView rows={model.history.data} sources={model.sources} current={model.now} offset={120} demo={state} />);
  if (state === "mixed") { assert.match(document.body.textContent ?? "",/Checked 24 times · nothing new/); assert.match(document.body.textContent ?? "",/3 could not start/); }
  if (state === "forty") assert.equal(document.querySelectorAll('a[href^="/syncs/day"]').length,40);
});
for (const state of SYNC_DAY_STATES) test(`one data source day practice ${state} renders real sync rows`, () => {
  const history = syncDayPractice(state,120); if (history.mode !== "syncs") return;
  assertPlain(<SyncDayView name="Amazon" day={personDay(Date.now(),120)} offset={120} rows={history.data.slice(0,50)} moreHref={history.data.length > 50 ? "?more=1" : undefined} />);
});
