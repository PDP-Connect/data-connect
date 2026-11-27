// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { CONSOLE_OWNER_CLIENT_ID } from "pdpp-reference-implementation/reference-local-defaults";
import { listAppHistory, listAppAccess } from "../lib/ref-client.ts";
import { groupGrantAccessByApp } from "../grants/app-access.ts";
import { readPersonOffset } from "../history/server-day.ts";
import { historyRange } from "../history/day-cut.ts";
import { loadHistorySources } from "../history/load-sources.ts";
import { historyPracticeSources, practiceEnabled } from "../history/practice.ts";
import { practiceAppHistory } from "../history/history-apps.ts";
export async function loadActivity(params: Record<string,string | undefined>) {
  const offset = await readPersonOffset();
  if (practiceEnabled(params.demo)) {
    const {history,apps} = practiceAppHistory(params.demo as string,offset);
    if (history.mode === "days") {
      const selected = apps.find(app=>app.hrefId===params.app);
      if (params.app) { history.data = history.data.filter(row=>selected?.clientIds.includes(row.client_id)); history.changes = history.changes.filter(row=>selected?.clientIds.includes(row.client_id)); }
      if (params.connection_id) {
        history.data = history.data.map(row=>{ const sources = row.sources.filter(source=>source.connection_id===params.connection_id); return {...row,sources,reads:sources.reduce((n,s)=>n+s.reads,0),across_sources:0}; }).filter(row=>row.reads);
        history.changes = history.changes.filter(row=>row.connection_id===params.connection_id);
      }
    }
    return { history, apps, sources: historyPracticeSources(), offset };
  }
  const [registrations,sources,history] = await Promise.all([
    listAppAccess(),loadHistorySources(),
    listAppHistory({ ...historyRange(offset),days:7,...(params.before?{before:params.before}:{}),...(params.date?{last:params.date}:{}), ...(params.connection_id ? { connection_id: params.connection_id } : {}) }),
  ]);
  const known = new Set(registrations.data.map(row=>row.client_id));
  const apps = groupGrantAccessByApp((history.mode === "days" ? [...registrations.data,...history.identities.filter(row=>!known.has(row.client_id))] : registrations.data).filter(row=>row.client_id!==CONSOLE_OWNER_CLIENT_ID));
  if (history.mode === "days" && params.app) {
    const selected=apps.find(app=>app.hrefId===params.app);
    history.data=history.data.filter(row=>selected?.clientIds.includes(row.client_id));
    history.changes=history.changes.filter(row=>selected?.clientIds.includes(row.client_id));
  }
  return { history, apps, sources, offset };
}
