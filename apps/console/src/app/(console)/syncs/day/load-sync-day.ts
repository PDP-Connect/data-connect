// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { listSyncHistory } from "../../lib/ref-client.ts";
import { readPersonOffset } from "../../history/server-day.ts";
import { personDay, historyHref } from "../../history/day-cut.ts";
import { syncPractice, practiceNow, historyPracticeSources, practiceEnabled, syncDayPractice } from "../../history/practice.ts";
import { loadHistorySources, sourceName } from "../../history/load-sources.ts";
export async function loadSyncDay(params: Record<string,string | undefined>) {
  const offset = await readPersonOffset(); const practice = practiceEnabled(params.demo);
  const day = params.day ?? (practice ? personDay(Date.now(),offset) : "");
  if (!day) return null;
  if (!params.connection_id && (!practice || params.demo==="all-sources")) {
    const [history,sources]=await Promise.all([practice ? syncPractice(params.fixture ?? "mixed",offset,practiceNow(day,offset)).history : listSyncHistory({first:day,last:day,offset}),practice ? historyPracticeSources() : loadHistorySources()]);
    return {name:"Data sources",day,offset,rows:[],sourceRows:history.mode==="days"?history.data:[],sources};
  }
  const [history,sources] = await Promise.all([
    practice ? syncDayPractice(params.demo as string,offset,practiceNow(day,offset),params.connection_id,params.fixture) : listSyncHistory({ first: day, last: day, day, offset, connection_id: params.connection_id as string, limit: params.more === "1" ? 100 : 50, ...(params.cursor ? { cursor: params.cursor } : {}) }),
    practice ? historyPracticeSources() : loadHistorySources(),
  ]);
  if (history.mode !== "syncs") return null;
  const start=practice ? Number(params.cursor ?? 0) : 0;
  const rows = practice ? history.data.slice(start,start+50) : history.data;
  const more = history.has_more || start+rows.length < history.data.length;
  return { name:sourceName(sources,params.connection_id ?? "practice-source-0",history.data[0]?.connector_id),day,offset,rows,sources,demo:params.demo,fixture:params.fixture,nextCursor:more ? history.next_cursor ?? String(start+rows.length) : null,moreHref:more ? historyHref("/syncs/day",params,history.next_cursor ? {cursor:history.next_cursor} : {more:"1"}) : undefined };
}
