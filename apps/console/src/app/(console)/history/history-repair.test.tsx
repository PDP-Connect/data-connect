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
  assert.deepEqual(cause,{sentence:"Northwind asked for a new sign-in.",action:"Sign in again",known:true,needsPerson:true});
  assert.equal(resolveSyncCause({reason:"unknown",error:"machine_failure_code=123"},"Northwind").known,false);
});
test("same failed-sync evidence gives every current surface the history cause and action",()=>{
  const source=buildSourcesDemoSummaries("mixed")[0]!;
  for(const [reason,sentence,label] of [
    ["session_expired","Northwind asked for a new sign-in.","Sign in again"],
    ["auth_failed","Northwind didn't accept the sign-in.","Sign in again"],
    ["assistance_timed_out","The sign-in wasn't finished.","Try again"],
    ["ingest_endpoint_saturated","DataConnect could not save the copies because its storage was busy.",null],
    ["surface_start_failed","DataConnect could not start its browser.",null],
    ["rate_limited","Northwind asked DataConnect to slow down.",null],
    ["auth_blocked","Northwind didn't let DataConnect sign in.","Sign in again"],
    ["static_secret_credential_unavailable","DataConnect could not find the saved sign-in details for Northwind.","Sign in again"],
    ["headed_browser_unavailable","DataConnect could not start its browser.",null],
    ["ingest_http_error","DataConnect could not save the copies because its storage refused them.",null],
    ["connector_protocol_violation","DataConnect could not use the copy from Northwind.",null],
    ["ECONNREFUSED","DataConnect could not reach everything it needed to sync Northwind.",null],
    ["launch_failed","DataConnect could not start this sync.",null],
    ["controller_restarted","DataConnect restarted before the sync finished.",null],
    ["run_timed_out","DataConnect stopped the sync because it took too long.",null],
    ["connector_exit_without_done","The sync stopped before it reported a result.",null],
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
    if(label === "Sign in again") { assert.equal(homeModel.needs[0]?.actionLabel,label); }
    for(const status of [list,home]) {assert.equal(status.words,sentence);assert.equal(status.action?.label ?? null,label);}
    assert.equal(words.words,sentence);assert.equal(words.action?.label ?? null,label);
  }
});
test("day counts describe copied records, including singular and zero",()=>{
  const fixture=syncPractice("mixed",0);if(fixture.history.mode!=="days") { throw Error("mode"); }
  const base=fixture.history.data[0]!;
  assert.match(syncDaySentence({...base,records:1},"Northwind"),/copied 1 record(?:$| ·)/);
  assert.match(syncDaySentence({...base,records:0},"Northwind"),/Nothing to copy/);
  assert.doesNotMatch(syncDaySentence({...base,records:58_000},"Northwind"),/new/);
});

test("earlier healthy sources collapse and missing kinds remain visible",async()=>{
  const React=await import("react");(globalThis as typeof globalThis & {React:typeof React}).React=React;
  const {renderToStaticMarkup}=await import("react-dom/server");
  const {SyncHistoryDays}=await import("../syncs/daily-syncs-view.tsx");
  const model=syncPractice("mixed",0);if(model.history.mode!=="days") { throw Error("mode"); }
  const rows=model.history.data.map(row=>({...row,day:"2026-08-13"}));
  rows[0]={...rows[0]!,missing:[{stream:"messages",retryable:false}]};
  const html=renderToStaticMarkup(<SyncHistoryDays rows={rows} sources={model.sources} offset={0} />);
  assert.match(html,/data sources checked/);assert.match(html,/didn&#x27;t come/);
  assert.match(html,/Failed 3 times:/);
});

test("a day link keeps the data source when the history is for one data source",async()=>{
  const React=await import("react");(globalThis as typeof globalThis & {React:typeof React}).React=React;
  const {renderToStaticMarkup}=await import("react-dom/server");
  const {SyncHistoryDays}=await import("../syncs/daily-syncs-view.tsx");
  const model=syncPractice("mixed",0);if(model.history.mode!=="days") { throw Error("mode"); }
  const one=model.history.data[0]!;
  const rows=model.history.data.filter(row=>row.connection_id===one.connection_id).map(row=>({...row,day:"2026-08-13",failed:0,stopped:0,interrupted:0,could_not_start:0,missing:undefined}));
  const html=renderToStaticMarkup(<SyncHistoryDays rows={rows} sources={model.sources} offset={0} />);
  const hrefs=[...html.matchAll(/href="(\/syncs\/day[^"]*)"/g)].map(match=>match[1]);
  assert.ok(hrefs.length>0);
  for(const href of hrefs) { assert.match(href!,new RegExp(`connection_id=${encodeURIComponent(one.connection_id)}`)); }
});

test("consecutive discovery lines roll into one, with record reads first",async()=>{
  const {groupReadLines}=await import("../audit/day/read-day-rows.tsx");
  const {readPractice}=await import("./practice.ts");const history=readPractice("kinds");if(history.mode!=="reads") { throw Error("mode"); }
  const schema=history.data.find(row=>row.shape==="schema")!;
  const rolled=groupReadLines(Array.from({length:35},(_,index)=>({...schema,id:`discovery-${index}`})));
  assert.equal(rolled.length,1);assert.equal(rolled[0]?.occurrences,35);
});


test("practice summary and day use the same copied counts and outcome totals",async()=>{
  const {syncDayPractice}=await import("./practice.ts");
  for(const state of ["mixed","recopied","expired-sign-in","missing-kind"]) {
    const summary=syncPractice(state,0);if(summary.history.mode!=="days") { throw Error("mode"); }
    for(const row of summary.history.data) {
      const day=syncDayPractice("history-day",0,Date.now(),row.connection_id,state);if(day.mode!=="syncs") { throw Error("mode"); }
      assert.equal(day.data.length,row.ran);assert.equal(day.data.reduce((n,sync)=>n+sync.records,0),row.records);
      assert.equal(day.data.filter(sync=>sync.outcome==="failed").length,row.failed);
    }
  }
});
test("practice app reads agree with activity and denied apps have no reads that day",async()=>{
  const {appPractice,readPractice}=await import("./practice.ts");
  for(const state of ["mixed","seven-fifty"]) {
    const summary=appPractice(state,0);const day=readPractice(state==="mixed"?"history-reads":"seven-fifty");
    if(summary.mode!=="days"||day.mode!=="reads") { throw Error("mode"); }
    const row=summary.data.find(row=>row.client_id==="practice-app-0")!;
    const reads=day.data.filter(read=>!["schema","stream_list"].includes(read.shape ?? ""));
    assert.equal(reads.length,row.reads);
    for(const source of row.sources) { assert.equal(reads.filter(read=>read.connection_id===source.connection_id).length,source.reads); }
    for(const denied of summary.changes.filter(row=>row.change==="not_allowed")) { assert.equal(summary.data.some(row=>row.client_id===denied.client_id && row.day===denied.day),false); }
  }
});
test("practice has 110 dates, 59 reading apps and a real console sign-in that is excluded",async()=>{
  const {appPractice}=await import("./practice.ts");const {practiceAppHistory,practiceHistoryApps}=await import("./history-apps.ts");
  const sync=syncPractice("hundred-ten",0);assert.equal(new Set(sync.history.data.map(row=>"day" in row?row.day:"")).size,110);
  assert.equal(practiceHistoryApps("fifty-nine").filter(app=>app.state==="reading").length,59);
  const raw=appPractice("console-sign-ins",0);const shown=practiceAppHistory("console-sign-ins",0).history;
  if(raw.mode!=="days"||shown.mode!=="days") { throw Error("mode"); }
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

test("large practice record totals and automatic triggers agree with the day",async()=>{
 const {readPractice,appPractice}=await import("./practice.ts");
 const day=readPractice("seven-fifty");const summary=appPractice("seven-fifty",0);
 if(day.mode!=="reads" || summary.mode!=="days") { throw Error("fixture"); }
 const reads=day.data.filter(row=>row.shape==="record_list");
 assert.equal(reads.reduce((sum,row)=>sum+(row.records ?? 0),0),summary.data[0]!.sources[0]!.records);
 const {oneSyncPractice}=await import("../syncs/[runId]/one-sync-model.ts");
 assert.equal(oneSyncPractice("could-not-start").trigger,"scheduled");
});

test("a past sync cause never promises another check or prescribes a fix now",()=>{
 for(const reason of ["rate_limited","surface_start_failed","ingest_endpoint_saturated","ingest_http_error","connector_protocol_violation","ECONNREFUSED","launch_failed","controller_restarted","run_timed_out","connector_exit_without_done"]) {
  const cause=resolveSyncCause({reason},"Northwind");
  assert.ok(!cause.sentence.includes("tries again at the next check"));
  assert.ok(!cause.sentence.includes("This needs a fix"));
  assert.ok(!cause.sentence.includes("connector for"));
 }
});

test("a mixed known and unknown missing kind never lists records as another kind",()=>{
 const fixture=syncPractice("mixed",0);assert.equal(fixture.history.mode,"days");if(fixture.history.mode!=="days") {return;}
 const [stored]=fixture.history.data;assert.ok(stored);
 const sentence=syncDaySentence({...stored,missing:[{stream:"messages",retryable:false},{stream:null,retryable:false}]},"Northwind",["Messages","records"]);
 assert.ok(!sentence.includes("Messages, records"));
});
