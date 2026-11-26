// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { PageHeader, Section } from "@pdpp/operator-ui/components/primitives";
import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { AppendHistory, type HistoryPageChunk } from "../history/append-history.tsx";
import { HistoryFilters } from "../history/history-filters.tsx";
import type { AccessChange } from "../lib/ref-client.ts";
import type { AppAccess } from "../grants/app-access.ts";
import { appSourceName } from "../grants/app-access.ts";
import { dayLabel, historyHref, historyTime, visibleDays } from "../history/day-cut.ts";
import { sourceName, type HistorySource } from "../history/source-names.ts";
import type { NamedAppDay } from "../history/history-apps.ts";
export function appDayHref(row: NamedAppDay, demo?: string, connection?: string): string {
  return historyHref("/audit/day",{}, { app: row.app.hrefId, day: row.day, ...(connection ? {connection_id:connection} : {}), ...(demo ? { demo: demo==="seven-fifty"?"seven-fifty":"history-reads" } : {}) });
}
export function ReadDayLines({ row, sources, linked=false, demo }: { row: NamedAppDay; sources: HistorySource[]; linked?:boolean;demo?:string }) {
  const ranked = row.sources.map(source => ({ reads: source.reads, href:appDayHref(row,demo,source.connection_id ?? source.source_id), text: `${sourceName(sources,source.connection_id ?? source.source_id,source.source_id)} · ${source.reads} time${source.reads===1?"":"s"}${source.records === null ? "" : ` · ${source.records.toLocaleString("en-US")} record${source.records===1?"":"s"}`}` }));
  if (row.across_sources) ranked.push({ reads: row.across_sources, href:appDayHref(row,demo), text: `Searched across your data sources · ${row.across_sources} times` });
  const lines = ranked.sort((a,b)=>b.reads-a.reads).map(line=>line);
  return <div className="mt-1 text-[13px] text-muted-foreground">{lines.slice(0,4).map(line => <p key={line.text}>{linked ? <Link className="text-primary hover:underline" href={line.href}>{line.text}</Link> : line.text}</p>)}{lines.length > 4 ? <p>and {lines.length-4} more</p> : null}</div>;
}
function changeSentence(change: AccessChange, app: AppAccess, sources: HistorySource[]): string {
  const rawSources = change.sources ?? (change.source_id ? [{source_id:change.source_id,connection_id:change.connection_id,source_kind:change.source_kind}] : []);
  const names = [...new Set(rawSources.map(raw => {
    const matched = app.sourceAccess.find(source => source.source.id === raw.source_id || source.source.connection_id === raw.connection_id || source.source.connector_id === raw.source_id);
    const name = sourceName(sources,raw.connection_id ?? raw.source_id,matched?.source.connector_id ?? raw.source_id);
    return name === "Data source" && matched ? appSourceName(matched.source) ?? name : name;
  }).filter(name=>name !== "Data source"))];
  const knownSource = names.length ? `${names.slice(0,3).join(", ")}${names.length > 3 ? ` and ${names.length-3} more` : ""}` : null;
  if (change.change === "not_allowed") return `You didn't allow ${app.name}.`;
  if (change.change === "removed") return knownSource ? `You stopped ${app.name} reading ${knownSource}.` : `You removed ${app.name}'s access.`;
  return `You allowed ${app.name} to read ${knownSource ?? "your data"}.`;
}
export function ActivityDays({rows,changes,apps,sources,offset,params={},demo,days=10000}: {rows:NamedAppDay[];changes:AccessChange[];apps:AppAccess[];sources:HistorySource[];offset:number;params?:Record<string,string|undefined>;demo?:string;days?:number}) {
  const byClient = new Map(apps.flatMap(app => app.clientIds.map(id => [id,app] as const)));
  const repeats = new Map<string,AccessChange & {count:number}>();
  for(const change of changes) {
    const app=byClient.get(change.client_id);if(!app)continue;
    const key=JSON.stringify([change.day,app.hrefId,changeSentence(change,app,sources)]);
    const prior=repeats.get(key);if(prior)prior.count++;else repeats.set(key,{...change,count:1});
  }
  const items = [
    ...rows.filter(row => params.only_access !== "true" && row.reads).map(row => ({ day: row.day, at: row.last_at ?? "", key: `read-${row.app.hrefId}`, row })),
    ...rows.filter(row => row.permission_refusals).map(row => ({ day: row.day, at: row.last_refusal_at ?? row.last_at ?? "", key: `refused-${row.app.hrefId}`, refusal: row })),
    ...[...repeats.values()].map(change => ({ day: change.day, at: change.at, key: change.id, change })),
  ].sort((a,b) => b.at.localeCompare(a.at));
  const shown = visibleDays(items,days);
  return <>
    {shown.map(day => <Section key={day} title={dayLabel(day,offset)}><ul className="divide-y divide-border">{items.filter(item=>item.day===day).map(item => <li className="py-4" key={item.key}>{"row" in item && item.row ? <div><Link className="flex justify-between gap-4" href={appDayHref(item.row,demo,params.connection_id)}><div><p>{item.row.app.name} read your data {item.row.reads} time{item.row.reads===1?"":"s"}</p>{apps.some(app=>app.name === item.row.app.name && app !== item.row.app) ? <p className="text-[13px] text-muted-foreground">{item.row.app.place}</p> : null}</div><span className="shrink-0 text-[13px] text-muted-foreground">{historyTime(item.row.last_at,offset)}</span></Link><ReadDayLines row={item.row} sources={sources} linked demo={demo} /></div> : "refusal" in item && item.refusal ? <Link className="flex justify-between gap-4" href={appDayHref(item.refusal,demo,params.connection_id)}><p><span className="mr-2" aria-hidden="true">◇</span>{item.refusal.app.name} was refused · {item.refusal.permission_refusals} time{item.refusal.permission_refusals===1?"":"s"}: it asked for something it may not read.</p><span className="shrink-0 text-[13px] text-muted-foreground">{historyTime(item.at,offset)}</span></Link> : "change" in item && item.change ? <Link className="flex justify-between gap-4" href={`/grants/${encodeURIComponent((byClient.get(item.change.client_id) as AppAccess).hrefId)}`}><p><span className="mr-2" aria-hidden="true">◇</span>{changeSentence(item.change,byClient.get(item.change.client_id) as AppAccess,sources)}{item.change.count>1 ? ` · ${item.change.count} times` : ""}</p><span className="shrink-0 text-[13px] text-muted-foreground">{historyTime(item.at,offset)}</span></Link> : null}</li>)}</ul></Section>)}
  </>;
}
export function ActivityView({ rows, changes, apps, sources, offset, days = 7, params = {}, demo, firstDay, beforeDay, loadMore }: {
  firstDay?:string|null;beforeDay?:string|null;loadMore?:(cursor:string)=>Promise<HistoryPageChunk>;
  rows: NamedAppDay[]; changes: AccessChange[]; apps: AppAccess[]; sources: HistorySource[]; offset: number; days?: number; params?: Record<string,string | undefined>; demo?: string;
}) {
  const hasItems=rows.some(row=>(params.only_access!=="true" && row.reads>0) || row.permission_refusals>0) || changes.some(change=>apps.some(app=>app.clientIds.includes(change.client_id)));
  return <>
    <PageHeader title="Activity" description="What apps read, and when." />
    <p className="mb-6 text-[13px] text-muted-foreground">DataConnect keeps what an app read, not what it asked.</p>
    {hasItems ? <HistoryFilters path="/audit">{demo ? <input type="hidden" name="demo" value={demo} /> : null}<select aria-label="App" className="min-h-11 max-w-full rounded-md border border-border bg-background px-3" name="app" defaultValue={params.app ?? ""}><option value="">All apps</option>{apps.filter(app=>app.state==="reading" || rows.some(row=>row.app===app && row.reads>0)).map(app => <option key={app.hrefId} value={app.hrefId}>{app.name}{apps.some(other=>other !== app && other.name === app.name) ? ` (${app.place})` : ""}</option>)}</select><select aria-label="Data source" className="min-h-11 max-w-full rounded-md border border-border bg-background px-3" name="connection_id" defaultValue={params.connection_id ?? ""}><option value="">All data sources</option>{sources.map(source => <option key={source.id} value={source.id}>{source.name}</option>)}</select><label className="flex min-h-11 items-center gap-2"><input name="only_access" type="checkbox" value="true" defaultChecked={params.only_access === "true"} />Only changes to access</label></HistoryFilters> : null}
    <AppendHistory key={JSON.stringify(params)} initial={{content:<ActivityDays rows={rows} changes={changes} apps={apps} sources={sources} offset={offset} params={params} demo={demo} days={days} />,next:beforeDay ?? null,firstDay}} load={loadMore} label="Earlier" />
    {!hasItems ? params.app || params.connection_id || params.only_access ? <><p>Nothing matches.</p><Link href="/audit">Show everything</Link></> : <><p>No app has read your data yet.</p><p className="text-muted-foreground">When an app reads, it shows here.</p>{!apps.length ? <Link className={buttonVariants()} href="/connect-ai">Connect an app</Link> : null}</> : null}

  </>;
}
