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
  assert.notEqual(sourceSentence.text,history.sentence);
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
