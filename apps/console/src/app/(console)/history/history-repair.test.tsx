// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { resolveSyncCause } from "./sync-cause.ts";
import { sourceStatusWords, sourceStateSentence } from "../lib/source-status-words.ts";
import { buildSourcesDemoSummaries } from "../sources/sources-demo-data.ts";
import { syncDaySentence } from "../syncs/daily-syncs-view.tsx";
import { syncPractice } from "./practice.ts";
test("expired sign-in nested beneath generic run failure keeps its known action",()=>{
  const cause=resolveSyncCause({reason:"connector_reported_failed",connector_error:{code:"service_session_inactive",cause_chain:[{message:"The authenticated session is no longer active."}]}},"Northwind");
  assert.deepEqual(cause,{sentence:"Northwind asked for a new sign-in.",action:"Sign in again",known:true});
  assert.equal(resolveSyncCause({reason:"unknown",error:"machine_failure_code=123"},"Northwind").known,false);
});
test("same stored evidence comparison records the source-page differences awaiting owner decision",()=>{
  const source=buildSourcesDemoSummaries("mixed")[0]!;
  const now=new Date();
  const evidence={reason:"session_expired",connector_error:{code:"session_expired"}};
  const shared={...source,last_run:{...source.last_run!,status:"failed",failure_reason:evidence.reason},owner_state:{...source.owner_state!,resolver:"system_degraded" as const}};
  const words=sourceStatusWords(shared,{now});
  const sourceSentence=sourceStateSentence(shared,{now,name:"Northwind"});
  const history=resolveSyncCause(evidence,"Northwind");
  // Source page is under independent review; the orchestrator forbids changing its sentences.
  assert.equal(sourceSentence.text,"Something stopped Northwind from syncing.");
  assert.equal(history.sentence,"Northwind asked for a new sign-in.");
  assert.equal(words.action?.label,"Try again");
  assert.equal(history.action,"Sign in again");
});
test("day counts describe copied records, including singular and zero",()=>{
  const fixture=syncPractice("mixed",0);if(fixture.history.mode!=="days")throw Error("mode");
  const base=fixture.history.data[0]!;
  assert.match(syncDaySentence({...base,records:1},"Northwind"),/copied 1 record(?:$| ·)/);
  assert.match(syncDaySentence({...base,records:0},"Northwind"),/Nothing to copy/);
  assert.doesNotMatch(syncDaySentence({...base,records:58000},"Northwind"),/new/);
});

test("earlier healthy sources collapse and missing kinds remain visible",async()=>{
  const React=await import("react");(globalThis as typeof globalThis & {React:typeof React}).React=React;
  const {renderToStaticMarkup}=await import("react-dom/server");
  const {SyncHistoryDays}=await import("../syncs/daily-syncs-view.tsx");
  const model=syncPractice("mixed",0);if(model.history.mode!=="days")throw Error("mode");
  const rows=model.history.data.map(row=>({...row,day:"2026-08-13"}));
  rows[0]={...rows[0]!,missing:[{stream:"messages",retryable:false}]};
  const html=renderToStaticMarkup(<SyncHistoryDays rows={rows} sources={model.sources} offset={0} />);
  assert.match(html,/data sources checked/);assert.match(html,/didn&#x27;t come/);
  assert.match(html,/Failed 3 times:/);
});

test("consecutive discovery lines roll into one, with record reads first",async()=>{
  const {groupReadLines}=await import("../audit/day/read-day-view.tsx");
  const {readPractice}=await import("./practice.ts");const history=readPractice("kinds");if(history.mode!=="reads")throw Error("mode");
  const schema=history.data.find(row=>row.shape==="schema")!;
  const rolled=groupReadLines(Array.from({length:35},(_,index)=>({...schema,id:`discovery-${index}`})));
  assert.equal(rolled.length,1);assert.equal(rolled[0]?.occurrences,35);
});


test("practice summary and day use the same copied counts and outcome totals",async()=>{
  const {syncDayPractice}=await import("./practice.ts");
  for(const state of ["mixed","recopied","expired-sign-in","missing-kind"]) {
    const summary=syncPractice(state,0);if(summary.history.mode!=="days")throw Error("mode");
    for(const row of summary.history.data) {
      const day=syncDayPractice("history-day",0,Date.now(),row.connection_id,state);if(day.mode!=="syncs")throw Error("mode");
      assert.equal(day.data.length,row.ran);assert.equal(day.data.reduce((n,sync)=>n+sync.records,0),row.records);
      assert.equal(day.data.filter(sync=>sync.outcome==="failed").length,row.failed);
    }
  }
});
test("practice app reads agree with activity and denied apps have no reads that day",async()=>{
  const {appPractice,readPractice}=await import("./practice.ts");
  for(const state of ["mixed","seven-fifty"]) {
    const summary=appPractice(state,0);const day=readPractice(state==="mixed"?"history-reads":"seven-fifty");
    if(summary.mode!=="days"||day.mode!=="reads")throw Error("mode");
    const row=summary.data.find(row=>row.client_id==="practice-app-0")!;
    const reads=day.data.filter(read=>!["schema","stream_list"].includes(read.shape ?? ""));
    assert.equal(reads.length,row.reads);
    for(const source of row.sources)assert.equal(reads.filter(read=>read.connection_id===source.connection_id).length,source.reads);
    for(const denied of summary.changes.filter(row=>row.change==="not_allowed"))assert.equal(summary.data.some(row=>row.client_id===denied.client_id && row.day===denied.day),false);
  }
});
test("practice has 110 dates, 59 reading apps and a real console sign-in that is excluded",async()=>{
  const {appPractice}=await import("./practice.ts");const {practiceAppHistory,practiceHistoryApps}=await import("./history-apps.ts");
  const sync=syncPractice("hundred-ten",0);assert.equal(new Set(sync.history.data.map(row=>"day" in row?row.day:"")).size,110);
  assert.equal(practiceHistoryApps("fifty-nine").filter(app=>app.state==="reading").length,59);
  const raw=appPractice("console-sign-ins",0);const shown=practiceAppHistory("console-sign-ins",0).history;
  if(raw.mode!=="days"||shown.mode!=="days")throw Error("mode");
  assert.equal(raw.changes.length,shown.changes.length+1);
});
