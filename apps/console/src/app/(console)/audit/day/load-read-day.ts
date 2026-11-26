// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { loadActivity } from "../load-activity.ts";
import { listAppHistory } from "../../lib/ref-client.ts";
import { readPersonOffset } from "../../history/server-day.ts";
import { historyHref, personDay } from "../../history/day-cut.ts";
import { historyPracticeSources, practiceEnabled, readPractice } from "../../history/practice.ts";
import { practiceHistoryApps } from "../../history/history-apps.ts";
export async function loadReadDay(params: Record<string,string | undefined>) {
  const practice = practiceEnabled(params.demo); const offset = await readPersonOffset();
  const { apps,sources } = practice ? { apps: practiceHistoryApps("mixed"),sources: historyPracticeSources() } : await loadActivity({date:params.day});
  const app = practice ? apps[0] : apps.find(app => app.hrefId === params.app);
  const day = params.day ?? (practice ? personDay(Date.now(),offset) : "");
  if (!app || !day) return null;
  const history = practice ? readPractice(params.demo as string,Date.now(),offset) : await listAppHistory({ first: day, last: day, day, offset, client_ids: app.clientIds, ...(params.connection_id ? {connection_id:params.connection_id} : {}), limit: params.more === "1" ? 100 : 50, ...(params.cursor ? { cursor: params.cursor } : {}) });
  if (history.mode !== "reads") return null;
  const discoveryShapes=["schema","stream_list","connector_list","stream_metadata"];
  const dataRows=practice ? history.data.filter(row=>!discoveryShapes.includes(row.shape ?? "") || row.refused) : history.data;
  const discovery=history.discovery ?? history.data.filter(row=>discoveryShapes.includes(row.shape ?? "") && !row.refused);
  const start=practice ? Number(params.cursor ?? 0) : 0;
  const rows = practice ? dataRows.slice(start,start+50) : dataRows;
  const more = history.has_more || start+rows.length < dataRows.length;
  return { app,day,offset,rows,sources,discovery,nextCursor:more ? history.next_cursor ?? String(start+rows.length) : null,moreHref:more ? historyHref("/audit/day",params,history.next_cursor ? {cursor:history.next_cursor} : {more:"1"}) : undefined };
}
