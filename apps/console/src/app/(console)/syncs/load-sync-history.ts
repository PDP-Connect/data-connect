// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { withCurrentSourceState } from "./current-source-state.ts";
import { syncDayProblem } from "./daily-syncs-view.tsx";
import { listRuns, listSyncHistory, type RunSummary } from "../lib/ref-client.ts";
import { visibleDays, historyRange } from "../history/day-cut.ts";
import { loadHistorySources } from "../history/load-sources.ts";
import { readPersonOffset } from "../history/server-day.ts";
import { practiceEnabled, syncPractice } from "../history/practice.ts";
function isLiveRun(run: RunSummary): boolean {
  return !["cancelled", "completed", "deferred", "failed", "rejected", "succeeded"].includes(run.status);
}
export async function loadSyncHistory(params: Record<string,string | undefined>) {
  const offset = await readPersonOffset();
  if (practiceEnabled(params.demo)) {
    const model = syncPractice(params.demo as string,offset);
    if (model.history.mode === "days") { model.history.data = model.history.data.filter(row => (!params.connection_id || row.connection_id === params.connection_id) && (params.only_problems !== "true" || syncDayProblem(row))); }
    if(model.history.mode==="days") {
      const days=visibleDays(model.history.data,10_000);const selected=days.filter(day=>(!params.before || day<params.before) && (!params.date || day<=params.date));const shown=selected.slice(0,7);
      model.history.first_day=days.at(-1) ?? null;model.history.before_day=selected.length>7?shown.at(-1) ?? null:null;
      model.history.data=model.history.data.filter(row=>shown.includes(row.day));
    }
    if (params.connection_id) { model.now = []; }
    return { ...model, offset };
  }
  const [history,sources,live] = await Promise.all([
    listSyncHistory({ ...historyRange(offset), days: 7, ...(params.before ? {before:params.before} : {}), ...(params.date ? {last:params.date} : {}), ...(params.connection_id ? { connection_id: params.connection_id } : {}) }),
    loadHistorySources(true,offset), listRuns({ status: "in_progress", limit: 100 }),
  ]);
  if(history.mode === "days") { history.data=withCurrentSourceState(history.data,sources).filter(row=>params.only_problems!=="true" || syncDayProblem(row)); }
  const current = live.data.filter(isLiveRun).filter(row => !params.connection_id || (row.connector_instance_id ?? row.connection_id ?? row.source?.connection_id) === params.connection_id).map(row => ({ id: row.run_id,
    name: sources.find(source => source.id === (row.connector_instance_id ?? row.connection_id ?? row.source?.connection_id))?.name ?? "Data source",
    needs: row.needs_input, at: row.first_at,
  }));
  return { history, sources, now: current, offset };
}
