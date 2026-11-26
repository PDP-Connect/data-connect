// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { ConnectorMark } from "../../components/connector-mark.tsx";
import { PageHeader } from "@pdpp/operator-ui/components/primitives";
import Link from "next/link";
import { AppendHistory, type HistoryPageChunk } from "../../history/append-history.tsx";
import { SyncHistoryDays } from "../daily-syncs-view.tsx";
import type { HistorySource } from "../../history/source-names.ts";
import type { SyncDay, SyncEntry } from "../../lib/ref-client.ts";
import { clockLabel, sentenceDayLabel, historyHref } from "../../history/day-cut.ts";
import { copiedRecords, resolveSyncCause } from "../../history/sync-cause.ts";
import { buttonVariants } from "@/components/ui/button";
export function SyncDayRows({name,day,offset,rows,demo}:{name:string;day:string;offset:number;rows:SyncEntry[];demo?:string}) {
  const labels = { finished: "Finished", failed: "Failed", stopped: "Stopped", interrupted: "Interrupted", could_not_start: "Could not start", syncing: "Syncing now" };
  return <ul className="divide-y divide-border">{rows.map(row => <li className="py-4" key={row.history_id}>{row.id ? <Link href={historyHref(`/syncs/${encodeURIComponent(row.id)}`,{}, { day, connection_id: row.connection_id, ...(demo ? { demo: row.outcome === "failed" ? "auth-failed" : "finished" } : {}) })}><span className="mr-4 text-muted-foreground">{clockLabel(row.at,offset)}</span>{labels[row.outcome]} · {copiedRecords(row.records)}</Link> : <p>{clockLabel(row.at,offset)} · {labels[row.outcome]} · {copiedRecords(row.records)}</p>}{row.outcome === "failed" ? <p className="text-destructive">{resolveSyncCause(row.evidence ?? {reason:row.cause},name).sentence}</p> : null}{row.outcome === "could_not_start" ? <p className="mt-2 text-muted-foreground">DataConnect could not start this sync. It tries again at the next check.</p> : null}{row.outcome === "failed" ? <Link className={buttonVariants()} href={`/sources/${encodeURIComponent(row.connection_id)}`}>{resolveSyncCause(row.evidence ?? {reason:row.cause},name).action}</Link> : null}{row.trigger === "manual" ? <p className="text-[13px] text-muted-foreground">You started it</p> : null}</li>)}</ul>;
}

export function SyncDayView({name,day,offset,rows,demo,nextCursor,loadMore,sourceRows,sources=[]}: {name:string;day:string;offset:number;rows:SyncEntry[];demo?:string;moreHref?:string;nextCursor?:string|null;loadMore?:(cursor:string)=>Promise<HistoryPageChunk>;sourceRows?:SyncDay[];sources?:HistorySource[]}) {
  return <><PageHeader breadcrumbs={[{href:"/syncs",label:"Sync history"}]} title={<span className="inline-flex items-center gap-3">{rows[0] ? <ConnectorMark connectorId={rows[0].connector_id} name={name} /> : null}<span>{name}, {sentenceDayLabel(day,offset)}</span></span>} />{sourceRows ? <SyncHistoryDays rows={sourceRows} sources={sources} offset={offset} expand /> : <AppendHistory initial={{content:<SyncDayRows name={name} day={day} offset={offset} rows={rows} demo={demo} />,next:nextCursor ?? null}} load={loadMore} label="Show more" />}{rows[0] ? <p className="my-6"><Link className="text-primary underline-offset-4 hover:underline" href={`/sources/${encodeURIComponent(rows[0].connection_id)}`}>See {name}</Link></p> : null}</>;
}
