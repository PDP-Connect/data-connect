// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import type { SyncDay } from "../lib/ref-client.ts";
import type { HistorySource } from "../history/source-names.ts";
export type CurrentSyncDay = SyncDay & {currentState?: string; currentProblem?: boolean};
/** The current passport supplements today's/newest rows, never rewrites an earlier day. */
export function withCurrentSourceState(rows: SyncDay[], sources: HistorySource[]): CurrentSyncDay[] {
  const newest=rows.map(row=>row.day).sort().at(-1);
  return rows.map(row=>{
    const source=sources.find(candidate=>candidate.id===row.connection_id);
    return row.day===newest && source?.currentProblem ? {...row,currentState:source.currentState,currentProblem:true} : row;
  });
}
