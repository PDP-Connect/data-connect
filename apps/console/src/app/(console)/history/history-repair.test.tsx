// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { resolveSyncCause } from "../lib/sync-cause.ts";
import { sourceStatusWords, sourceStateSentence } from "../lib/source-status-words.ts";
import { buildSourcesDemoSummaries } from "../sources/sources-demo-data.ts";
import { syncDaySentence } from "../syncs/daily-syncs-view.tsx";
import { toSourceInstanceView } from "../sources/sources-view-model.ts";
import { buildHomeViewModel } from "../components/views/standing-view-model.ts";
import { syncPractice } from "./practice.ts";
test("expired sign-in nested beneath generic run failure keeps its known action",()=>{
  const cause=resolveSyncCause({reason:"connector_reported_failed",connector_error:{code:"service_session_inactive",cause_chain:[{message:"The authenticated session is no longer active."}]}},"Northwind");
  assert.deepEqual(cause,{sentence:"Northwind asked for a new sign-in.",action:"Sign in again",known:true});
  assert.equal(resolveSyncCause({reason:"unknown",error:"machine_failure_code=123"},"Northwind").known,false);
});
test("same failed-sync evidence gives every current surface the history cause and action",()=>{
  const source=buildSourcesDemoSummaries("mixed")[0]!;
  for(const [reason,sentence,label] of [
    ["session_expired","Northwind asked for a new sign-in.","Sign in again"],
    ["auth_failed","Northwind didn't accept the sign-in.","Sign in again"],
    ["assistance_timed_out","The sign-in wasn't finished.","Try again"],
    ["ingest_endpoint_saturated","DataConnect could not save the copies because its storage was busy. DataConnect tries again at the next check.",null],
    ["surface_start_failed","DataConnect could not start its browser. DataConnect tries again at the next check.",null],
    ["rate_limited","Northwind asked DataConnect to slow down. DataConnect tries again at the next check.",null],
    ["auth_blocked","Northwind didn't let DataConnect sign in.","Sign in again"],
    ["static_secret_credential_unavailable","DataConnect could not find the saved sign-in details for Northwind.","Sign in again"],
    ["headed_browser_unavailable","DataConnect could not start its browser. DataConnect tries again at the next check.",null],
    ["ingest_http_error","DataConnect could not save the copies because its storage refused them. This needs a fix from the people who maintain DataConnect.",null],
    ["connector_protocol_violation","The connector for Northwind sent something DataConnect could not accept. This needs a fix from the people who maintain DataConnect.",null],
    ["ECONNREFUSED","DataConnect could not reach everything it needs to sync Northwind. DataConnect tries again at the next check.",null],
    ["launch_failed","DataConnect could not start the connector for Northwind. DataConnect tries again at the next check.",null],
    ["controller_restarted","DataConnect restarted before the sync finished. DataConnect tries again at the next check.",null],
    ["run_timed_out","DataConnect stopped the sync because it took too long. DataConnect tries again at the next check.",null],
    ["connector_exit_without_done","The connector for Northwind stopped before reporting its result. DataConnect tries again at the next check.",null],
    ["stream_collection_failed","DataConnect could not copy some records from Northwind.","Try again"],
    ["venmo_login_incomplete_after_submit","The sign-in wasn't finished.","Try again"],
    ["unknown","Something stopped Northwind from syncing.","Try again"],
  ] as const) {
    const shared={...source,display_name:"Northwind",connector_display_name:"Northwind",last_run:{...source.last_run!,status:"failed",failure_reason:reason},owner_state:{...source.owner_state!,resolver:"system_degraded" as const}};
    const history=resolveSyncCause({reason},"Northwind");
    assert.equal(history.sentence,sentence);assert.equal(history.action,label);
    assert.equal(sourceStateSentence(shared,{now:new Date(),name:"Northwind"}).text,sentence);
    const words=sourceStatusWords(shared,{now:new Date()});
    const list=toSourceInstanceView(shared).statusWords;
    const homeModel=buildHomeViewModel({approvals:[],approvalsFailed:false,approvalsHaveMore:false,grants:[],grantsFailed:false,grantsHaveMore:false,ownerClients:[],ownerClientsFailed:false,ownerClientsHaveMore:false,sourcePage:{kind:"ok",hasMore:false,sources:[shared]},summary:null,summaryFailed:false,traces:[],tracesFailed:false,tracesHaveMore:false,now:new Date(),reloadHref:"/",hrefs:{addSource:"/sources/add",connect:"/connect",deployment:"/deployment",deploymentTokens:"/deployment/tokens",grant:(id)=>`/grants/${id}`,grants:"/grants",source:(id)=>`/sources/${id}`,sources:"/sources"}});
    const home=(homeModel.dataSources[0] ?? homeModel.needs[0])!.status!;
    if(label === "Sign in again") assert.equal(homeModel.needs[0]?.actionLabel,label);
    for(const status of [list,home]) {assert.equal(status.words,sentence);assert.equal(status.action?.label ?? null,label);}
    assert.equal(words.words,sentence);assert.equal(words.action?.label ?? null,label);
  }
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

test("current owner steps and maintenance blocks take precedence over failed-sync evidence",()=>{
  const source=buildSourcesDemoSummaries("mixed")[0]!;
  for(const resolver of ["needs_owner","setup_in_progress","owner_paused","blocked_maintainer"] as const){
    const shared={...source,last_run:{...source.last_run!,status:"failed",failure_reason:"session_expired"},owner_state:{...source.owner_state!,resolver}};
    assert.notEqual(sourceStatusWords(shared,{now:new Date()}).words,"Northwind asked for a new sign-in.");
    assert.notEqual(sourceStateSentence(shared,{now:new Date(),name:"Northwind"}).text,"Northwind asked for a new sign-in.");
  }
});
