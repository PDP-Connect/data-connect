// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { listRuns, listSyncHistory } from "../lib/ref-client.ts";
import { historyRange } from "../history/day-cut.ts";
import { loadHistorySources } from "../history/load-sources.ts";
import { readPersonOffset } from "../history/server-day.ts";
import { practiceEnabled, syncPractice } from "../history/practice.ts";
export async function loadSyncHistory(params: Record<string,string | undefined>) {
  const offset = await readPersonOffset();
  if (practiceEnabled(params.demo)) return { ...syncPractice(params.demo as string,offset), offset };
  const [history,sources,live] = await Promise.all([
    listSyncHistory({ ...historyRange(offset), ...(params.connection_id ? { connection_id: params.connection_id } : {}), only_problems: params.only_problems === "true" }),
    loadHistorySources(), listRuns({ status: "in_progress", limit: 100 }),
  ]);
  const current = live.data.filter(row => !params.connection_id || (row.connector_instance_id ?? row.connection_id ?? row.source?.connection_id) === params.connection_id).map(row => ({ id: row.run_id,
    name: sources.find(source => source.id === (row.connector_instance_id ?? row.connection_id ?? row.source?.connection_id))?.name ?? "Data source",
    needs: row.needs_input, at: row.first_at,
  }));
  return { history, sources, now: current, offset };
}
