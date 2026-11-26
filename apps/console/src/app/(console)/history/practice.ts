// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import type { AppHistory, AppReadEntry, AppReadDay, AccessChange, SyncDay, SyncEntry, SyncHistory } from "../lib/ref-client.ts";
import type { HistorySource } from "./load-sources.ts";
import { personDay } from "./day-cut.ts";
export const SYNC_STATES = ["mixed","problems","source","empty","no-match","forty"];
export const SYNC_DAY_STATES = ["three","sixty"];
export const SYNC_DETAIL_STATES = ["finished","nothing","missing","auth-failed","blocked","unfinished","failed","could-not-start","stopped","interrupted","syncing","needs-you"];
export const ACTIVITY_STATES = ["mixed","app","changes","empty","unread","thirty"];
export const READ_STATES = ["kinds","refused","eighty"];
function practiceTime(now: number,index: number,offset: number): string {
  const elapsed = ((now+offset*60_000)%86_400_000+86_400_000)%86_400_000;
  return new Date(now-index*Math.min(60_000,elapsed/100)).toISOString();
}
export const practiceEnabled = (demo?: string) => process.env.NODE_ENV !== "production" && Boolean(demo);
export function historyPracticeSources(count = 6): HistorySource[] {
  const names = ["Amazon","Reddit","Gmail","Spotify","Northwind","GitHub"];
  return Array.from({ length: count }, (_,index) => ({ id: `practice-source-${index}`, connector: names[index % names.length]!.toLowerCase(), name: count > 6 ? `${names[index % names.length]} (${Math.floor(index/6)+1})` : names[index]! }));
}
export function syncPractice(state: string, offset: number, now = Date.now()): { history: SyncHistory; sources: HistorySource[]; now: { id: string; name: string; needs: boolean; at: string }[] } {
  const sources = historyPracticeSources(state === "forty" ? 40 : 6);
  const day = personDay(now, offset);
  const data: SyncDay[] = sources.map((source,index) => ({ day, connection_id: source.id, connector_id: source.connector,
    ran: index === 3 ? 1 : 24, finished: index === 1 ? 21 : index === 3 ? 1 : 24, failed: index === 1 ? 3 : 0,
    stopped: 0, interrupted: 0, could_not_start: index === 2 ? 3 : 0, records: index === 0 ? 0 : index === 3 ? 14 : 312,
    last_at: practiceTime(now,index+1,offset), last_outcome: index === 1 ? "failed" : "finished", manual: index === 3 ? 1 : 0, cause: index === 1 ? "auth_failed" : null }));
  const rows = state === "empty" || state === "no-match" ? [] : state === "problems" ? data.filter(row => row.failed) : state === "source" ? data.slice(0,1) : data;
  return { history: { mode: "days", data: rows, has_more: false, next_cursor: null }, sources,
    now: ["mixed","forty"].includes(state) ? [{ id: "practice-syncing", name: "Northwind", needs: false, at: new Date(now-240_000).toISOString() }, { id: "practice-needs-you", name: "GitHub", needs: true, at: new Date(now-120_000).toISOString() }] : [] };
}
export function syncDayPractice(state: string, offset: number, now = Date.now()): SyncHistory {
  const data: SyncEntry[] = Array.from({ length: state === "sixty" ? 60 : 3 }, (_,index) => ({ id: `practice-sync-${index}`, history_id: String(index), connection_id: "practice-source-0", connector_id: "amazon", at: practiceTime(now,index,offset), started_at: new Date(now-index*60_000-120_000).toISOString(), completed_at: practiceTime(now,index,offset), outcome: index === 1 ? "failed" : "finished", records: index === 1 ? 0 : 14, trigger: index === 2 ? "manual" : "scheduled", cause: index === 1 ? "auth_failed" : null }));
  return { mode: "syncs", data, has_more: false, next_cursor: null };
}
export function appPractice(state: string, offset: number, now = Date.now()): AppHistory {
  const data: AppReadDay[] = [];
  for (let day = 0; day < 3; day++) for (let app = 0; app < (state === "thirty" ? 30 : 2); app++) {
    const at = practiceTime(now-day*86400000,app,offset);
    data.push({ day: personDay(at,offset), client_id: `practice-app-${app}`, reads: 120, across_sources: 80,
      last_at: at, permission_refusals: day === 0 && app === 1 ? 3 : 0,
      sources: Array.from({ length: 4 }, (_,index) => ({ source_id: historyPracticeSources()[index]!.connector, source_kind: "connector", connection_id: `practice-source-${index}`, reads: 10, records: index === 0 ? null : 230 })) });
  }
  const changes: AccessChange[] = ["allowed","not_allowed","removed"].map((change,index) => ({ id: `practice-change-${index}`, trace_id: `practice-trace-${index}`, at: practiceTime(now,index,offset), day: personDay(now,offset), client_id: `practice-app-${index%2}`, change: change as AccessChange["change"], source_id: index === 1 ? null : "gmail", source_kind: "connector", connection_id: index === 1 ? null : "practice-source-2" }));
  const empty = state === "empty" || state === "unread";
  return { mode: "days", identities: [], data: empty || state === "changes" ? [] : state === "app" ? data.filter(row => row.client_id === "practice-app-0") : data, changes: empty ? [] : changes, has_more: false, next_cursor: null };
}
export function readPractice(state: string, now = Date.now(), offset = -new Date().getTimezoneOffset()): AppHistory {
  const shapes = ["record_list","record_detail","search","search_hybrid","search_semantic","stream_aggregate","field_window","schema","stream_list"];
  const data: AppReadEntry[] = Array.from({ length: state === "eighty" ? 80 : state === "refused" ? 1 : 45 }, (_,index) => ({ id: `practice-read-${index}`, trace_id: `practice-read-trace-${index}`, at: practiceTime(now,index,offset), client_id: "practice-app-0", shape: shapes[index%9]!, source_id: shapes[index%9]!.startsWith("search") ? null : "gmail", source_kind: "connector", connection_id: shapes[index%9]!.startsWith("search") ? null : "practice-source-2", record_kind: "messages", records: ["schema","stream_list","record_detail","stream_aggregate"].includes(shapes[index%9]!) ? null : 20, metric: "count", refused: state === "refused", reason: state === "refused" ? "grant_revoked" : null }));
  return { mode: "reads", data, has_more: false, next_cursor: null };
}
