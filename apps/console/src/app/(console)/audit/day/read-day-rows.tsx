// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import type {AppReadEntry} from "../../lib/ref-client.ts";
import {clockLabel} from "../../history/day-cut.ts";
import {historyKindName,sourceName,type HistorySource} from "../../history/source-names.ts";
import {readSentence,refusalReason} from "./read-sentence.ts";
/** Consecutive reads with the same meaning stay together; records are response totals. */
export function groupReadLines(rows: AppReadEntry[]): AppReadEntry[] {
  const lines:AppReadEntry[]=[];
  for(const row of rows) {
    const previous=lines.at(-1);
    const key=(item:AppReadEntry)=>JSON.stringify([item.shape?.startsWith("search") ? "search" : item.shape,item.connection_id,item.source_id,item.record_kind,item.metric,item.refused,item.reason]);
    if(previous && key(previous)===key(row)) {
      previous.occurrences=(previous.occurrences ?? 1)+(row.occurrences ?? 1);
      previous.records=previous.records===null && row.records===null ? null : (previous.records ?? 0)+(row.records ?? 0);
    } else { lines.push({...row}); }
  }
  return lines;
}
export function ReadDayRows({rows,sources,offset=0,complete=true}:{rows:AppReadEntry[];sources:HistorySource[];offset?:number;complete?:boolean}) {
  return <ul className="divide-y divide-border">{groupReadLines(rows).map(row=><li className="flex items-start justify-between gap-4 py-4" key={row.id}>
    <div className="min-w-0"><p>{readSentence(complete ? row : {...row,records:null},row.source_id ? sourceName(sources,row.connection_id ?? row.source_id,row.source_id) : null,historyKindName(sources,row.connection_id ?? row.source_id,row.record_kind))}{complete && (row.occurrences ?? 1)>1 ? ` · ${row.occurrences?.toLocaleString("en-US")} times` : ""}{row.refused ? " · refused" : ""}</p>{row.refused ? <p className="text-[13px] text-muted-foreground">{refusalReason(row.reason) ?? "The app must correct its request before trying again."}</p> : null}</div>
    <span className="shrink-0 text-[13px] text-muted-foreground">{clockLabel(row.at,offset)}</span>
  </li>)}</ul>;
}
