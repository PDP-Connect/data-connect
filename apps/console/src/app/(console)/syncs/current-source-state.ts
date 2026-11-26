// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import type { SyncDay } from "../lib/ref-client.ts";
import type { HistorySource } from "../history/source-names.ts";
export type CurrentSyncDay = SyncDay & {currentState?: string; currentProblem?: boolean};
/** The current passport supplements today's/newest rows, never rewrites an earlier day. */
export function withCurrentSourceState(rows: SyncDay[], sources: HistorySource[]): CurrentSyncDay[] {
  const newest=new Map<string,string>();
  for(const row of rows) if(row.day>(newest.get(row.connection_id)??"")) newest.set(row.connection_id,row.day);
  return rows.map(row=>{
    const source=sources.find(candidate=>candidate.id===row.connection_id);
    return source?.currentAnswer ? {...row,currentProblem:source.currentAnswer.problem,...(row.day===newest.get(row.connection_id)?{currentState:source.currentState}:{})} : row;
  });
}
