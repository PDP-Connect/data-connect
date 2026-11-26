// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { SyncsView } from "../syncs/syncs-view.tsx";
import { DEMO_SYNCS_MODEL } from "../syncs/syncs-demo.ts";
import { DailySyncsView } from "../syncs/daily-syncs-view.tsx";
import { SyncDayView } from "../syncs/day/sync-day-view.tsx";
import { ACTIVITY_STATES, READ_STATES, readPractice, historyPracticeSources, SYNC_DETAIL_STATES, SYNC_STATES, SYNC_DAY_STATES, syncPractice, syncDayPractice } from "./practice.ts";
import { oneSyncPractice } from "../syncs/[runId]/one-sync-model.ts";
import { ActivityView } from "../audit/activity-view.tsx";
import { ReadDayView } from "../audit/day/read-day-view.tsx";
import { groupAppHistory, practiceAppHistory, practiceHistoryApps } from "./history-apps.ts";
import { personDay } from "./day-cut.ts";
mock.module(new URL("../syncs/[runId]/actions.ts",import.meta.url).href, { exports: { cancelRunAction: async () => ({ok:true}), submitRunInteractionAction: async () => ({error:null,status:"success"}) } });
mock.module("next/navigation", { exports: { useRouter: () => ({ refresh() {}, replace() {} }) } });
(globalThis as typeof globalThis & { React: typeof React }).React = React;
const banned = /\b(run|trace|grant|stream|checkpoint|gap|rejected|surface|skipped|abandoned|succeeded|collected|Peek|events|Duration|Details|active|Waiting|PDPP|install|package|connector|manifest|digest|registered|operator|instance|dashboard|modality|credential|seal|coverage|fetched|retryable|outbox|heartbeat|backoff|configuration|revision|client|scope|OAuth|bearer|token|registration|consent|revoke|revoked|issued)\b|\d{2}:\d{2}:\d{2}|\b[a-z]+_[a-z]+_/i;
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
  if (state === "mixed") { assert.match(document.body.textContent ?? "",/Checked 24 times · Nothing to copy/); assert.match(document.body.textContent ?? "",/3 could not start/); }
  if (state === "forty") assert.equal(document.querySelectorAll('a[href^="/syncs/day"]').length,40);
});
for (const state of SYNC_DAY_STATES) test(`one data source day practice ${state} renders real sync rows`, () => {
  const history = syncDayPractice(state,120); if (history.mode !== "syncs") return;
  assertPlain(<SyncDayView name="Amazon" day={personDay(Date.now(),120)} offset={120} rows={history.data.slice(0,50)} moreHref={history.data.length > 50 ? "?more=1" : undefined} />);
});

for (const state of SYNC_DETAIL_STATES) test(`one sync practice ${state} uses plain words and honest missing facts`, async () => {
  const { OneSyncView } = await import("../syncs/[runId]/one-sync-view.tsx");
  assertPlain(<OneSyncView model={oneSyncPractice(state)} offset={120} practice />);
});

for (const state of ACTIVITY_STATES) test(`activity practice ${state} names apps and counts only data reads`, () => {
  const {history,apps} = practiceAppHistory(state,120); if (history.mode !== "days") return;
  const doc = assertPlain(<ActivityView rows={groupAppHistory(history.data,apps)} changes={history.changes} apps={apps} sources={historyPracticeSources()} offset={120} params={state === "changes" ? {only_access:"true"} : {}} demo={state} />);
  if (state === "mixed") { assert.match(doc.body.textContent ?? "",/ChatGPT read your data 120 times/); assert.match(doc.body.textContent ?? "",/Searched across your data sources · 80 times/); }
});
for (const state of READ_STATES) test(`app reading day ${state} describes each stored kind in words`, () => {
  const history = readPractice(state); if (history.mode !== "reads") return;
  const app = practiceHistoryApps("mixed")[0]!;
  assertPlain(<ReadDayView app={app} day={personDay(Date.now(),120)} offset={120} rows={history.data.slice(0,50)} sources={historyPracticeSources()} moreHref={history.data.length > 50 ? "?more=1" : undefined} />);
});

test("an app's recent reading uses the same day rows and stops at five", async () => {
  const { RecentReading } = await import("../grants/[grantId]/recent-reading.tsx");
  const {history,apps} = practiceAppHistory("mixed",120); if (history.mode !== "days") throw Error("wrong mode");
  const rows = groupAppHistory(history.data,apps).filter(row=>row.app.clientIds.includes("practice-app-0"));
  const eight = Array.from({length:8},(_,index)=>({...rows[0]!,day:personDay(Date.now()-index*86400000,120)}));
  const document = assertPlain(<RecentReading rows={eight} sources={historyPracticeSources()} offset={120} />);
  assert.match(document.body.textContent ?? "",/What it has read lately/);
  assert.equal(document.querySelectorAll('a[href^="/audit/day"]').length,5);
});
test("practice sync rows stay inside their stated day just after midnight",()=>{
  const offset=120;const now=Date.parse("2026-11-25T22:02:00.000Z");
  const model=syncPractice("forty",offset,now);
  if(model.history.mode!=="days")throw Error("wrong mode");
  for(const row of model.history.data)assert.equal(personDay(row.last_at!,offset),row.day);
});

test("the former exact counters and source facts remain on the technical overview",()=>{
  const document=new JSDOM(renderToStaticMarkup(<SyncsView title="Data sources technical overview" model={DEMO_SYNCS_MODEL} seeded />)).window.document;
  assert.match(document.body.textContent ?? "",/Data sources technical overview/);
  assert.match(document.body.textContent ?? "",/streams on schedule/);
  assert.match(document.body.textContent ?? "",/Streams by source/);
});
