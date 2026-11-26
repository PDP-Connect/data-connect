// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { PageHeader } from "@pdpp/operator-ui/components/primitives";
import Link from "next/link";
import type { AppReadEntry } from "../../lib/ref-client.ts";
import type { AppAccess } from "../../grants/app-access.ts";
import { clockLabel, sentenceDayLabel } from "../../history/day-cut.ts";
import { historyKindName, sourceName, type HistorySource } from "../../history/source-names.ts";
import { AppendHistory, type HistoryPageChunk } from "../../history/append-history.tsx";
import { readSentence, refusalReason } from "./read-sentence.ts";
/** Consecutive reads with the same meaning stay together; records are response totals. */
export function groupReadLines(rows: AppReadEntry[]): AppReadEntry[] {
  const lines:AppReadEntry[]=[];
  for(const row of rows) {
    const previous=lines.at(-1);
    const key=(item:AppReadEntry)=>JSON.stringify([item.shape,item.connection_id,item.source_id,item.record_kind,item.metric,item.refused,item.reason]);
    if(previous && key(previous)===key(row)) {
      previous.occurrences=(previous.occurrences ?? 1)+(row.occurrences ?? 1);
      previous.records=previous.records===null && row.records===null ? null : (previous.records ?? 0)+(row.records ?? 0);
    } else lines.push({...row});
  }
  return lines;
}
export function ReadDayRows({rows,sources,offset=0}:{rows:AppReadEntry[];sources:HistorySource[];offset?:number}) {
  return <ul className="divide-y divide-border">{groupReadLines(rows).map(row=><li className="flex items-start justify-between gap-4 py-4" key={row.id}>
    <div className="min-w-0"><p>{readSentence(row,row.source_id ? sourceName(sources,row.connection_id ?? row.source_id,row.source_id) : null,historyKindName(sources,row.connection_id ?? row.source_id,row.record_kind))}{(row.occurrences ?? 1)>1 ? ` · ${row.occurrences} times` : ""}{row.refused ? " · refused" : ""}</p>{row.refused ? <p className="text-[13px] text-muted-foreground">{refusalReason(row.reason) ?? "The app must correct its request before trying again."}</p> : null}</div>
    <span className="shrink-0 text-[13px] text-muted-foreground">{clockLabel(row.at,offset)}</span>
  </li>)}</ul>;
}
export function ReadDayView({app,day,offset,rows,sources,discovery=[],nextCursor,loadMore,pageKey}:{app:AppAccess;day:string;offset:number;rows:AppReadEntry[];sources:HistorySource[];pageKey?:string;discovery?:AppReadEntry[];moreHref?:string;nextCursor?:string|null;loadMore?:(cursor:string)=>Promise<HistoryPageChunk>}) {
  return <><PageHeader breadcrumbs={[{href:"/audit",label:"Activity"}]} title={`${app.name}, ${sentenceDayLabel(day,offset)}`} />
    <AppendHistory key={pageKey ?? `${day}:${app.hrefId}`} initial={{content:<ReadDayRows rows={rows} sources={sources} offset={offset} />,next:nextCursor ?? null}} load={loadMore} label="Show more" />
    {discovery.length ? <ReadDayRows rows={discovery} sources={sources} offset={offset} /> : null}
    <p className="my-6"><Link className="text-primary underline-offset-4 hover:underline" href={`/grants/${encodeURIComponent(app.hrefId)}`}>See {app.name}</Link></p>
    <Link className="text-[13px] text-muted-foreground" href={`/audit/technical?client_id=${encodeURIComponent(app.clientIds[0] ?? "")}`}>Technical details</Link>
  </>;
}
