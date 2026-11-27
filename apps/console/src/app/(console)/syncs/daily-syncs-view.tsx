import { CalendarDateInput } from "../history/calendar-date-input.tsx";
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { PageHeader, Section } from "@pdpp/operator-ui/components/primitives";
import Link from "next/link";
import { buttonVariants } from "@pdpp/brand-react";
import { copiedRecords, resolveSyncCause } from "../lib/sync-cause.ts";
import { AppendHistory, type HistoryPageChunk } from "../history/append-history.tsx";
import { HistoryFilters } from "../history/history-filters.tsx";
import { personDay } from "../history/day-cut.ts";
import type { CurrentSyncDay } from "./current-source-state.ts";
import type { SyncDay } from "../lib/ref-client.ts";
import { ConnectorMark } from "../components/connector-mark.tsx";
import { dayLabel, startedAgo, historyHref, historyTime, visibleDays } from "../history/day-cut.ts";
import { historyKindName, sourceName, type HistorySource } from "../history/source-names.ts";
export function syncCause(cause: string | null, name: string): string | null {
  const result = resolveSyncCause({reason:cause},name);
  return result.known ? result.sentence : null;
}
export function syncDaySentence(row: CurrentSyncDay, name: string, missingNames: string[] = []): string {
  const currentPart = row.currentState ? ` · ${row.currentState}` : "";
  const knownMissing=[...new Set(missingNames.filter(candidate=>candidate!=="records"))];
  const missing = row.missing?.length ? ` · ${knownMissing.length ? knownMissing.join(", ") : "Some records"} didn't come` : "";
  if (!row.ran) { return `Not checked · could not start ${row.could_not_start.toLocaleString("en-US")} time${row.could_not_start===1?"":"s"}${currentPart}`; }
  if (row.last_outcome === "failed") {
    const resolved = resolveSyncCause(row.evidence ?? {reason:row.cause},name);
    const cause = resolved.sentence;
    // "Now" must not repeat the cause, nor send a step that is the person's to the maintainers.
    // When "Now" starts with the same words as the cause, the line says them once.
    const now = row.currentState?.replace(/^Now: /,"").replace(/\. See .* for the next step\.$/,".") ?? "";
    const causeWords = cause.replace(/\.$/, "");
    const nowWords = now.replace(/\.$/, "");
    const repeats = nowWords === causeWords || nowWords.startsWith(`${causeWords}.`);
    const failure = repeats ? nowWords : causeWords;
    const currentAfterFailure = row.currentState && (repeats || (resolved.needsPerson && now.startsWith("Waiting on a fix from the DataConnect maintainers"))) ? "" : currentPart;
    return `Failed${row.failed > 1 ? ` ${row.failed.toLocaleString("en-US")} times` : ""}: ${failure}${row.could_not_start ? ` · ${row.could_not_start.toLocaleString("en-US")} could not start` : ""}${missing}${currentAfterFailure}`;
  }
  // The unnamed-cause answer is reached only when the last run did not fail, so beside a
  // sync that worked it would say something that is not true. Named states still show.
  const current = /^ · Now: Something stopped /.test(currentPart) ? "" : currentPart;
  const checked = row.ran === 1 ? row.manual === 1 ? "You started it" : "Checked once" : `Checked ${row.ran.toLocaleString("en-US")} times`;
  const incomplete = row.failed+row.stopped+row.interrupted;
  return `${checked} · ${copiedRecords(row.records)}${incomplete ? ` · ${incomplete.toLocaleString("en-US")} did not finish` : ""}${row.could_not_start ? ` · ${row.could_not_start.toLocaleString("en-US")} could not start` : ""}${missing}${current}`;
}
/** The current step button belongs under the newest sync of a source, and only when that sync failed. */
export function currentActionShown(row: CurrentSyncDay): boolean {
  return row.last_outcome === "failed" && row.currentState !== undefined;
}
/** A past failure stays a problem even when the source is healthy now; a current problem adds to it. */
export function syncDayProblem(row: CurrentSyncDay): boolean {
  return row.currentProblem === true || row.failed + row.stopped + row.interrupted > 0 || Boolean(row.missing?.length) || row.could_not_start > 0;
}
/** The history row opens the data source's page and does not do the step itself, so the button says that. */
export function historyActionLabel(label: string, name: string): string {
  return `Open ${name} to ${label.charAt(0).toLowerCase()}${label.slice(1)}`;
}
export function SyncHistoryDays({rows,sources,offset,demo,onlyProblems=false,expand=false}: {rows:CurrentSyncDay[];sources:HistorySource[];offset:number;demo?:string;onlyProblems?:boolean;expand?:boolean}) {
  const name=(row:SyncDay)=>sourceName(sources,row.connection_id,row.connector_id);
  const sourceIds=new Set(rows.map(row=>row.connection_id));
  const onlySource=sourceIds.size===1 ? [...sourceIds][0] : undefined;
  return <>{visibleDays(rows,10_000).map(day=>{
    const all=rows.filter(row=>row.day===day);
    const older=!expand && day!==personDay(Date.now(),offset);
    const fine=older ? all.filter(row=>!syncDayProblem(row)) : [];
    const shown=older ? all.filter(syncDayProblem) : all;
    return <Section key={day} title={fine.length && !onlyProblems ? undefined : dayLabel(day,offset)}>
      {fine.length && !onlyProblems ? <Link className="block py-4 text-primary hover:underline" href={historyHref("/syncs/day",{}, {day,connection_id:onlySource,...(demo?{demo:"all-sources",fixture:demo}:{})})}>{dayLabel(day,offset)} · {fine.length.toLocaleString("en-US")} data source{fine.length===1?"":"s"} checked</Link> : null}
      <ul className="divide-y divide-border">{shown.map(row=><li key={row.connection_id} className="py-4">
        <Link className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-4" href={historyHref("/syncs/day",{}, {connection_id:row.connection_id,day,...(demo?{demo:"history-day",fixture:demo}:{})})}>
          <div className="flex min-w-0 items-start gap-3 sm:items-center"><ConnectorMark connectorId={row.connector_id} name={name(row)} /><div className="min-w-0"><p>{name(row)}</p><span className="block text-[13px] text-muted-foreground sm:hidden">{historyTime(row.last_at,offset)}</span><p className={row.last_outcome==="failed"?"text-[13px] text-destructive":"text-[13px] text-muted-foreground"}>{syncDaySentence(row,sources.find(source=>source.id===row.connection_id)?.serviceName ?? name(row),row.missing?.map(item=>historyKindName(sources,row.connection_id,item.stream)))}</p></div></div>
          <span className="hidden shrink-0 text-[13px] text-muted-foreground sm:inline">{historyTime(row.last_at,offset)}</span>
        </Link>
        {row.currentState ? <ul className="text-[13px] text-muted-foreground">{Object.entries(sources.find(source=>source.id===row.connection_id)?.currentKinds ?? {}).map(([kind,value])=><li key={kind}>{historyKindName(sources,row.connection_id,kind)} · {value.line}</li>)}</ul> : null}
        {currentActionShown(row) && sources.find(source=>source.id===row.connection_id)?.currentAnswer?.action ? <div className="mt-3"><Link className={buttonVariants()} href={`/sources/${encodeURIComponent(row.connection_id)}`}>{historyActionLabel(sources.find(source=>source.id===row.connection_id)?.currentAnswer?.action?.label ?? "",name(row))}</Link></div> : null}
      </li>)}</ul>
    </Section>;
  })}</>;
}
export function DailySyncsView({ rows, sources, current = [], offset, days = 7, params = {}, demo, firstDay, beforeDay, loadMore }: {
  rows: SyncDay[]; sources: HistorySource[]; current?: { id: string; name: string; needs: boolean; at: string }[];
  firstDay?: string | null; beforeDay?: string | null; loadMore?: (cursor:string)=>Promise<HistoryPageChunk>;
  offset: number; days?: number; params?: Record<string,string | undefined>; demo?: string;
}) {
  const shown = visibleDays(rows,days);
  return <>
    <PageHeader title="Sync history" description="What DataConnect did to keep your copies up to date." />
    {sources.length ? <HistoryFilters path="/syncs">
      {demo ? <input name="demo" type="hidden" value={demo} /> : null}
      <select aria-label="Data source" className="min-h-11 w-full max-w-full rounded-md sm:w-auto border border-border bg-background px-3" defaultValue={params.connection_id ?? ""} name="connection_id"><option value="">All data sources</option>{sources.map(source => <option key={source.id} value={source.id}>{source.name}</option>)}</select>
      <label className="flex min-h-11 items-center gap-2"><input defaultChecked={params.only_problems === "true"} name="only_problems" type="checkbox" value="true" />Only problems</label><label className="flex w-full flex-col gap-1 sm:w-auto" htmlFor="sync-history-date">Date<CalendarDateInput id="sync-history-date" className="min-h-11 w-full max-w-full rounded-md border border-border bg-background px-3" aria-label="Go to a date" name="date" defaultValue={params.date} /></label>
    </HistoryFilters> : null}
    {current.length ? <Section title="Now"><ul className="divide-y divide-border">{current.map(row => <li className="flex flex-wrap items-center justify-between gap-3 py-4" key={row.id}><Link href={`/syncs/${encodeURIComponent(row.id)}${demo ? `?demo=${row.needs ? "needs-you" : "syncing"}` : ""}`}>{row.name} · {row.needs ? "Needs you to finish signing in" : `Syncing now · started ${startedAgo(row.at)}`}</Link>{row.needs ? <Link className={buttonVariants()} href={`/syncs/${encodeURIComponent(row.id)}/stream`}>Continue</Link> : null}</li>)}</ul></Section> : null}
    <AppendHistory key={JSON.stringify(params)} initial={{content:<SyncHistoryDays rows={rows.filter(row=>shown.includes(row.day))} sources={sources} offset={offset} demo={demo} onlyProblems={params.only_problems==="true"} />,next:beforeDay ?? null,firstDay:shown.length ? firstDay : null}} load={loadMore} label="Earlier" />
    {(shown.length || current.length ) ? null : params.connection_id || params.only_problems || demo === "no-match" ? <><p>Nothing matches.</p><Link href="/syncs">Show everything</Link></> : <><p>Nothing has synced yet.</p><p className="text-muted-foreground">When you add a data source, each sync shows here.</p><Link className={buttonVariants()} href="/sources/add">Add a data source</Link></>}

  </>;
}
