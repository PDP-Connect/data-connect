// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { PageHeader, Section } from "@pdpp/operator-ui/components/primitives";
import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { resolveSyncCause } from "../history/sync-cause.ts";
import type { SyncDay } from "../lib/ref-client.ts";
import { ConnectorMark } from "../components/connector-mark.tsx";
import { dayLabel, startedAgo, historyHref, historyTime, visibleDays } from "../history/day-cut.ts";
import { historyKindName, sourceName, type HistorySource } from "../history/source-names.ts";
export function syncCause(cause: string | null, name: string): string | null {
  const result = resolveSyncCause({reason:cause},name);
  return result.known ? result.sentence : null;
}
export function syncDaySentence(row: SyncDay, name: string, missingNames: string[] = []): string {
  const missing = row.missing?.length ? ` · some ${missingNames.length ? missingNames.join(", ").toLowerCase() : "records"} didn't come` : "";
  if (!row.ran) return `Not checked · could not start ${row.could_not_start} times`;
  if (row.last_outcome === "failed") {
    const cause = resolveSyncCause(row.evidence ?? {reason:row.cause},name).sentence;
    return `Failed${cause ? `: ${cause}` : ""}${row.failed > 1 ? ` · ${row.failed} times` : ""}${row.could_not_start ? ` · ${row.could_not_start} could not start` : ""}${missing}`;
  }
  const checked = row.ran === 1 ? row.manual === 1 ? "You started it" : "Checked once" : `Checked ${row.ran} times`;
  const incomplete = row.failed+row.stopped+row.interrupted;
  return `${checked} · ${row.records ? `${row.records.toLocaleString("en-US")} new records` : "nothing new"}${incomplete ? ` · ${incomplete} did not finish` : ""}${row.could_not_start ? ` · ${row.could_not_start} could not start` : ""}${missing}`;
}
export function DailySyncsView({ rows, sources, current = [], offset, days = 7, params = {}, demo }: {
  rows: SyncDay[]; sources: HistorySource[]; current?: { id: string; name: string; needs: boolean; at: string }[];
  offset: number; days?: number; params?: Record<string,string | undefined>; demo?: string;
}) {
  const shown = visibleDays(rows,days);
  const name = (row: SyncDay) => sourceName(sources,row.connection_id,row.connector_id);
  return <>
    <PageHeader title="Sync history" description="What DataConnect did to keep your copies up to date." />
    <form className="mb-6 flex flex-wrap items-center gap-4">
      {demo ? <input name="demo" type="hidden" value={demo} /> : null}
      <select aria-label="Data source" className="min-h-11 rounded-md border border-border bg-background px-3" defaultValue={params.connection_id ?? ""} name="connection_id"><option value="">All data sources</option>{sources.map(source => <option key={source.id} value={source.id}>{source.name}</option>)}</select>
      <label className="flex min-h-11 items-center gap-2"><input defaultChecked={params.only_problems === "true"} name="only_problems" type="checkbox" value="true" />Only problems</label><button className="min-h-11 text-primary" type="submit">Show</button>
    </form>
    {current.length ? <Section title="Now"><ul className="divide-y divide-border">{current.map(row => <li className="flex flex-wrap items-center justify-between gap-3 py-4" key={row.id}><Link href={`/syncs/${encodeURIComponent(row.id)}${demo ? `?demo=${row.needs ? "needs-you" : "syncing"}` : ""}`}>{row.name} · {row.needs ? "Needs you to finish signing in" : `Syncing now · started ${startedAgo(row.at)}`}</Link>{row.needs ? <Link href={`/syncs/${encodeURIComponent(row.id)}/stream`}>Continue</Link> : null}</li>)}</ul></Section> : null}
    {shown.map(day => <Section key={day} title={dayLabel(day,offset)}><ul className="divide-y divide-border">{rows.filter(row => row.day === day).map(row => <li key={row.connection_id}><Link className="flex items-center justify-between gap-4 py-4" href={historyHref("/syncs/day",{}, { connection_id: row.connection_id, day, ...(demo ? { demo: "three" } : {}) })}><div className="flex min-w-0 items-center gap-3"><ConnectorMark connectorId={row.connector_id} name={name(row)} /><div><p>{name(row)}</p><p className={row.last_outcome === "failed" ? "text-[13px] text-destructive" : "text-[13px] text-muted-foreground"}>{syncDaySentence(row,name(row),row.missing?.map(item=>historyKindName(sources,row.connection_id,item.stream)))}</p></div></div><span className="shrink-0 text-[13px] text-muted-foreground">{historyTime(row.last_at,offset)}</span></Link></li>)}</ul></Section>)}
    {!shown.length && !current.length ? params.connection_id || params.only_problems || demo === "no-match" ? <><p>Nothing matches.</p><Link href="/syncs">Show everything</Link></> : <><p>Nothing has synced yet.</p><p className="text-muted-foreground">When you add a data source, each sync shows here.</p><Link href="/sources/add">Add a data source</Link></> : null}
    {visibleDays(rows,10000).length > shown.length ? <Link href={historyHref("/syncs",params,{ days: String(days+7) })}>Earlier</Link> : null}
  </>;
}
