// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import {mock,test} from "node:test";
import React from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {JSDOM} from "jsdom";
import {AGREEMENT_STATES,agreementPractice} from "../sources/[connector]/agreement-practice.ts";
import {sourceStatusWords,sourceStateSentence} from "../lib/source-status-words.ts";
import {toSourceInstanceView} from "../sources/sources-view-model.ts";
import {buildHomeViewModel} from "../components/views/standing-view-model.ts";
import {SourceRowStatus} from "../sources/source-row-status.tsx";
import {SourceStatusText} from "../components/source-status-text.tsx";
import {SourceStateSentenceText} from "../sources/[connector]/source-state-sentence.tsx";
import {applyCurrentSourceWords} from "./current-source-words.ts";
import {withCurrentSourceState} from "../syncs/current-source-state.ts";
import {historyActionLabel,SyncHistoryDays,syncDayProblem} from "../syncs/daily-syncs-view.tsx";
import {oneSyncPractice} from "../syncs/[runId]/one-sync-model.ts";
import {syncPractice} from "./practice.ts";
import type {HistorySource} from "./source-names.ts";
mock.module(new URL("../syncs/[runId]/actions.ts",import.meta.url).href,{exports:{cancelRunAction:async()=>({ok:true}),submitRunInteractionAction:async()=>({error:null,status:"success"})}});
mock.module("server-only",{namedExports:{}});
mock.module("next/navigation",{exports:{useRouter:()=>({refresh(){/* inert router */},replace(){/* inert router */}})}});
Object.assign(globalThis,{React});
const now=new Date("2026-11-26T12:00:00Z");
const homeInputs={approvals:[],approvalsFailed:false,approvalsHaveMore:false,grants:[],grantsFailed:false,grantsHaveMore:false,ownerClients:[],ownerClientsFailed:false,ownerClientsHaveMore:false,summary:null,summaryFailed:false,traces:[],tracesFailed:false,tracesHaveMore:false,now,reloadHref:"/",hrefs:{addSource:"/sources/add",connect:"/connect",deployment:"/deployment",deploymentTokens:"/deployment/tokens",grant:(id:string)=>`/grants/${id}`,grants:"/grants",source:(id:string)=>`/sources/${id}`,sources:"/sources"}};
function text(node:React.ReactElement){const dom=new JSDOM(renderToStaticMarkup(node));const result=dom.window.document.body.textContent??"";dom.window.close();return result;}
function labels(node:React.ReactElement){const dom=new JSDOM(renderToStaticMarkup(node));const actions=[...dom.window.document.querySelectorAll("a,button")].map(a=>a.textContent).filter(label=>["Try again","Sign in again","Install again","Set up again","Resume","Resume schedule","View this device","See what to do on that computer","Sync now","Continue setup","Review setup","Review result"].includes(label??""));dom.window.close();return actions;}
for(const state of AGREEMENT_STATES) { test(`five places agree: ${state}`,async(t)=>{
 t.mock.timers.enable({apis:["Date"],now});
 const model=agreementPractice(state);assert.ok(model);const {source}=model;const status=sourceStatusWords(source,{now});
 const list=toSourceInstanceView(source);const home=buildHomeViewModel({...homeInputs,sourcePage:{kind:"ok",hasMore:false,sources:[source]}});
 const homeRow=[...home.needs,...home.dataSources].find(candidate=>candidate.id===source.connection_id);
 const historySource:HistorySource={id:source.connection_id,connector:source.connector_id,name:source.display_name,serviceName:source.connector_display_name??undefined};
 applyCurrentSourceWords([source],[historySource]);
 const fixture=syncPractice("mixed",0);assert.equal(fixture.history.mode,"days");if(fixture.history.mode!=="days") { return; }
 const [stored]=fixture.history.data;assert.ok(stored);
 const row={...stored,connection_id:source.connection_id,connector_id:source.connector_id,last_outcome:source.last_run?.status==="failed"?"failed" as const:"finished" as const,evidence:{reason:source.last_run?.failure_reason ?? null,error:null,connector_error:null}};
 const current=withCurrentSourceState([row],[historySource]);
 const [currentRow]=current;assert.ok(currentRow);
 const history=<SyncHistoryDays rows={current} sources={[historySource]} offset={0} expand />;
 const {OneSyncView}=await import("../syncs/[runId]/one-sync-view.tsx");
 const one=Object.assign(oneSyncPractice("failed"),{connection:source.connection_id,name:source.display_name,currentSource:historySource});
 const sync=<OneSyncView model={one} offset={0} practice />;
 const page=text(<SourceStateSentenceText connectionId={source.connection_id} status={status} sentence={sourceStateSentence(source,{now,name:"Northwind"})} />);
 assert.equal(text(<SourceRowStatus instance={list} />).replace(/\s+/g," "),status.words.replace(" · ",""));
 if(homeRow?.status) { assert.equal(text(<SourceStatusText status={homeRow.status} />),status.words); }
 assert.ok(page.length>0);
 assert.ok(text(history).includes(status.words.replace(/\.$/,"")),"history must print the present short words (a failed day that already says the same cause prints it once)");
 assert.ok(text(sync).includes(status.words),"sync page must print the present short words");
 if(state.startsWith("device")) {
  assert.ok(status.words.startsWith("The computer that holds this data (Practice computer) could not send 4,959 records"),status.words);
  assert.equal(status.action?.label,"See what to do on that computer");
  assert.ok(sourceStateSentence(source,{now,name:"Northwind"}).text.startsWith("The computer that holds this data"));
 }
 const expected=status.action?[status.action.label]:[];
 const historyLabels=[...new JSDOM(renderToStaticMarkup(history)).window.document.querySelectorAll("a")].map(link=>link.textContent ?? "").filter(label=>/^Open .+ to /.test(label));
 // The history button opens the data source's page, so it names the step and says it opens the page.
 assert.deepEqual(historyLabels,currentRow.last_outcome==="failed"?expected.map(label=>historyActionLabel(label,historySource.name)):[],"history action must be the current source action, drawn only under a sync that failed");
 assert.deepEqual(labels(sync),expected,"sync page action must be the current source action");
 assert.equal(home.needs.filter(need=>need.kind!=="approval").length,status.action?1:0,"Needs you equals sources with an action, including lifecycle recovery");
 assert.equal(syncDayProblem(currentRow),Boolean((historySource as HistorySource & {currentProblem:boolean}).currentProblem),"Only problems uses the current answer");
}); }
