// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import {CONSOLE_OWNER_CLIENT_ID} from "pdpp-reference-implementation/reference-local-defaults";
import type { AppAccessSource, AppHistory, AppReadEntry, AppReadDay, AccessChange, SyncDay, SyncEntry, SyncHistory } from "../lib/ref-client.ts";
import type { HistorySource } from "./load-sources.ts";
import { APP_PRACTICE_SOURCES } from "../lib/app-practice-sources.ts";
import { personDay } from "./day-cut.ts";
export const SYNC_STATES = ["mixed","problems","source","empty","no-match","forty","recopied","expired-sign-in","missing-kind","hundred-ten"];
export const SYNC_DAY_STATES = ["three","sixty"];
export const SYNC_DETAIL_STATES = ["finished","nothing","missing","auth-failed","blocked","unfinished","failed","could-not-start","stopped","interrupted","syncing","needs-you","expired-sign-in","recopied"];
export const ACTIVITY_STATES = ["mixed","app","changes","empty","unread","thirty","fifty-nine","console-sign-ins","seven-fifty"];
export const READ_STATES = ["kinds","refused","eighty","seven-fifty"];
function practiceTime(now: number,index: number,offset: number): string {
  const elapsed = ((now+offset*60_000)%86_400_000+86_400_000)%86_400_000;
  return new Date(now-index*Math.min(60_000,elapsed/100)).toISOString();
}
export const practiceEnabled = (demo?: string) => process.env.NODE_ENV !== "production" && Boolean(demo);
export function historyPracticeSources(count = 6): HistorySource[] {
  const names = [...APP_PRACTICE_SOURCES.map(source => source.name),"Northwind","GitHub"];
  return Array.from({ length: count }, (_,index) => ({ id: `practice-source-${index}`, connector: names[index % names.length]!.toLowerCase(), name: count > 6 ? `${names[index % names.length]} (${Math.floor(index/6)+1})` : names[index]! }));
}
export function syncPractice(state: string, offset: number, now = Date.now()): { history: SyncHistory; sources: HistorySource[]; now: { id: string; name: string; needs: boolean; at: string }[] } {
  const sources = historyPracticeSources(state === "forty" ? 40 : 6);
  const day = personDay(now, offset);
  const data: SyncDay[] = sources.map((source,index) => ({ day, connection_id: source.id, connector_id: source.connector,
    ran: index === 3 ? 1 : 24, finished: index === 1 ? 21 : index === 3 ? 1 : 24, failed: index === 1 ? 3 : 0,
    stopped: 0, interrupted: 0, could_not_start: index === 2 ? 3 : 0, records: index === 0 ? 0 : index === 3 ? 14 : 312,
    last_at: practiceTime(now,index+1,offset), last_outcome: index === 1 ? "failed" : "finished", manual: index === 3 ? 1 : 0, cause: index === 1 ? "auth_failed" : null }));
  if(state==="recopied") { for(const row of data) { row.records=58_000;row.ran=24;row.finished=24;row.failed=0;row.last_outcome="finished";row.cause=null; } }
  if(state==="expired-sign-in") {const row=data[1];if(row){row.ran=21;row.failed=21;row.finished=0;row.cause="connector_reported_failed";row.records=0;row.evidence={reason:row.cause,error:null,connector_error:{code:"session_expired",message:"The authenticated session is no longer active."}};}}
  if(state==="missing-kind") {const row=data[2];if(row) { row.missing=[{stream:"messages",retryable:false}]; }}
  if(state==="hundred-ten") {const today=[...data];data.length=0;for(let index=0;index<110;index++) { for(const row of today) { data.push({...row,day:personDay(now-index*86_400_000,offset),last_at:practiceTime(now-index*86_400_000,1,offset)}); } }}
  const rows = state === "empty" || state === "no-match" ? [] : state === "problems" ? data.filter(row => row.failed) : state === "source" ? data.slice(0,1) : data;
  return { history: { mode: "days", data: rows, has_more: false, next_cursor: null }, sources:state==="empty"?[]:sources,
    now: ["mixed","forty"].includes(state) ? [{ id: "practice-syncing", name: "Northwind", needs: false, at: new Date(now-240_000).toISOString() }, { id: "practice-needs-you", name: "GitHub", needs: true, at: new Date(now-120_000).toISOString() }] : [] };
}
export function syncDayPractice(state: string, offset: number, now = Date.now(), connection="practice-source-0", fixture="mixed"): SyncHistory {
  const summary=syncPractice(fixture,offset,now).history;
  const daily=summary.mode==="days" ? summary.data.find(row=>row.connection_id===connection) : undefined;
  const historyDay=state==="history-day";
  const count=historyDay ? daily?.ran ?? 24 : state==="sixty"?60:3;
  const total=historyDay ? daily?.records ?? 0 : 28;
  const failed=historyDay ? daily?.failed ?? 0 : 1;
  const successful=Math.max(1,count-failed);
  const data:SyncEntry[]=Array.from({length:count},(_,index)=>{
    const outcome=index<failed?"failed":"finished";
    const number=index-failed;
    const records=outcome==="failed"?0:Math.floor(total/successful)+(number<total%successful?1:0);
    return {id:`practice-sync-${index}`,history_id:String(index),connection_id:connection,connector_id:historyPracticeSources().find(row=>row.id===connection)?.connector ?? "northwind",at:practiceTime(now,index,offset),started_at:new Date(Date.parse(practiceTime(now,index,offset))-120_000).toISOString(),completed_at:practiceTime(now,index,offset),outcome,records,trigger:daily?.manual?"manual":"scheduled",cause:outcome==="failed"?daily?.cause ?? "auth_failed":null,evidence:outcome==="failed"?daily?.evidence:undefined,missing:outcome==="finished"?daily?.missing:[]};
  });
  return {mode:"syncs",data,has_more:false,next_cursor:null};
}
export function practiceNow(day: string | undefined,offset:number,now=Date.now()): number {
  return day ? now + Date.parse(day)-Date.parse(personDay(now,offset)) : now;
}
export function appPractice(state: string, offset: number, now = Date.now(), allowed?: readonly AppAccessSource[]): AppHistory {
  const data: AppReadDay[] = [];
  for (let day = 0; day < 3; day++) { for (let app = 0; app < (state === "thirty" ? 30 : state === "fifty-nine" ? 59 : 2); app++) {
    const at = practiceTime(now-day*86_400_000,app,offset);
    data.push({ day: personDay(at,offset), client_id: `practice-app-${app}`, reads: 120, across_sources: 80,
      last_at: at, permission_refusals: day === 0 && app === 1 ? 3 : 0,
      sources: APP_PRACTICE_SOURCES.map((source,index) => ({ last_at:at, source_id: source.connector, source_kind: "connector", connection_id: source.id, reads: 10, records: index === 0 ? null : 230 })) });
  } }
  if (allowed) { for (const row of data) {
    row.sources = allowed.map(source => ({ source_id: source.source.connector_id ?? source.source.id, source_kind: source.source.kind, connection_id: source.source.connection_id, reads: 10, records: 20, last_at: row.last_at }));
    row.reads = row.across_sources + row.sources.reduce((count,source) => count + source.reads,0);
  } }
  const changes: AccessChange[] = ["allowed","not_allowed","removed"].map((change,index) => ({ id: `practice-change-${index}`, trace_id: `practice-trace-${index}`, at: practiceTime(now,index,offset), day: personDay(now,offset), client_id: `practice-app-${index===1?2:0}`, change: change as AccessChange["change"], source_id: index === 1 ? null : "gmail", source_kind: "connector", connection_id: index === 1 ? null : "practice-source-2" }));
  if(state==="seven-fifty") { for(const row of data) {row.reads=225;row.across_sources=0;row.sources=[{source_id:"gmail",source_kind:"connector",connection_id:"practice-source-2",reads:225,records:4500}];} }
  if(state==="console-sign-ins") { changes.push({id:"console-sign-in",trace_id:"console-sign-in",day:personDay(now,offset),at:practiceTime(now,0,offset),client_id:CONSOLE_OWNER_CLIENT_ID,change:"allowed",source_id:null,source_kind:null,connection_id:null}); }
  const empty = state === "empty" || state === "unread";
  return { mode: "days", identities: [], data: empty || state === "changes" ? [] : state === "app" ? data.filter(row => row.client_id === "practice-app-0") : data, changes: empty ? [] : changes, has_more: false, next_cursor: null };
}
export function readPractice(state: string, now = Date.now(), offset = -new Date().getTimezoneOffset()): AppHistory {
  if(state==="history-reads" || state==="seven-fifty") {
    const large=state==="seven-fifty";
    const data:AppReadEntry[]=Array.from({length:large?750:155},(_,index)=>{
      const discovery=index>=(large?225:120);
      const across=!large && index>=40 && !discovery;
      const source=large?2:Math.floor(index/10);
      return {id:`practice-read-${index}`,trace_id:`practice-read-trace-${index}`,at:practiceTime(now,index,offset),client_id:"practice-app-0",shape:discovery?"schema":across?"search":"record_list",source_id:across||discovery?null:historyPracticeSources()[source%6]?.connector ?? "gmail",source_kind:across||discovery?null:"connector",connection_id:across||discovery?null:`practice-source-${source%6}`,record_kind:source===0?"orders":"messages",records:discovery?null:across?12:large?20:source===0?null:23,metric:null,refused:false,reason:null};
    });
    return {mode:"reads",data,has_more:false,next_cursor:null};
  }
  const shapes = ["record_list","record_detail","search","search_hybrid","search_semantic","stream_aggregate","field_window","schema","stream_list"];
  const data: AppReadEntry[] = Array.from({ length: state === "eighty" ? 80 : state === "refused" ? 1 : 45 }, (_,index) => ({ id: `practice-read-${index}`, trace_id: `practice-read-trace-${index}`, at: practiceTime(now,index,offset), client_id: "practice-app-0", shape: shapes[index%9]!, source_id: shapes[index%9]!.startsWith("search") ? null : "gmail", source_kind: "connector", connection_id: shapes[index%9]!.startsWith("search") ? null : "practice-source-2", record_kind: "messages", records: ["schema","stream_list","record_detail","stream_aggregate"].includes(shapes[index%9]!) ? null : 20, metric: "count", refused: state === "refused", reason: state === "refused" ? "grant_revoked" : null }));
  return { mode: "reads", data, has_more: false, next_cursor: null };
}
