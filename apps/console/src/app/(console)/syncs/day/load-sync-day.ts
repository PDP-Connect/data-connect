// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { listSyncHistory } from "../../lib/ref-client.ts";
import { readPersonOffset } from "../../history/server-day.ts";
import { personDay, historyHref } from "../../history/day-cut.ts";
import { historyPracticeSources, practiceEnabled, syncDayPractice } from "../../history/practice.ts";
import { loadHistorySources, sourceName } from "../../history/load-sources.ts";
export async function loadSyncDay(params: Record<string,string | undefined>) {
  const offset = await readPersonOffset(); const practice = practiceEnabled(params.demo);
  const day = params.day ?? (practice ? personDay(Date.now(),offset) : "");
  if (!day || (!params.connection_id && !practice)) return null;
  const [history,sources] = await Promise.all([
    practice ? syncDayPractice(params.demo as string,offset) : listSyncHistory({ first: day, last: day, day, offset, connection_id: params.connection_id as string, limit: params.more === "1" ? 100 : 50, ...(params.cursor ? { cursor: params.cursor } : {}) }),
    practice ? historyPracticeSources() : loadHistorySources(),
  ]);
  if (history.mode !== "syncs") return null;
  const rows = practice ? history.data.slice(0,params.more === "1" ? 100 : 50) : history.data;
  const more = history.has_more || rows.length < history.data.length;
  return { name:sourceName(sources,params.connection_id ?? "practice-source-0",history.data[0]?.connector_id),day,offset,rows,demo:params.demo,moreHref:more ? historyHref("/syncs/day",params,history.next_cursor ? {cursor:history.next_cursor} : {more:"1"}) : undefined };
}
