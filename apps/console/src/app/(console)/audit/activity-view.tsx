// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { PageHeader, Section } from "@pdpp/operator-ui/components/primitives";
import Link from "next/link";
import type { AccessChange } from "../lib/ref-client.ts";
import type { AppAccess } from "../grants/app-access.ts";
import { appSourceName } from "../grants/app-access.ts";
import { dayLabel, historyHref, historyTime, visibleDays } from "../history/day-cut.ts";
import { sourceName, type HistorySource } from "../history/source-names.ts";
import type { NamedAppDay } from "../history/history-apps.ts";
export function appDayHref(row: NamedAppDay, demo?: string): string {
  return historyHref("/audit/day",{}, { app: row.app.hrefId, day: row.day, ...(demo ? { demo: "kinds" } : {}) });
}
export function ReadDayLines({ row, sources }: { row: NamedAppDay; sources: HistorySource[] }) {
  const ranked = row.sources.map(source => ({ reads: source.reads, text: `${sourceName(sources,source.connection_id ?? source.source_id,source.source_id)} · ${source.reads} times${source.records === null ? "" : ` · ${source.records.toLocaleString("en-US")} records`}` }));
  if (row.across_sources) ranked.push({ reads: row.across_sources, text: `Searched across your data sources · ${row.across_sources} times` });
  const lines = ranked.sort((a,b)=>b.reads-a.reads).map(line=>line.text);
  return <div className="mt-1 text-[13px] text-muted-foreground">{lines.slice(0,4).map(line => <p key={line}>{line}</p>)}{lines.length > 4 ? <p>and {lines.length-4} more</p> : null}</div>;
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
export function ActivityView({ rows, changes, apps, sources, offset, days = 7, params = {}, demo }: {
  rows: NamedAppDay[]; changes: AccessChange[]; apps: AppAccess[]; sources: HistorySource[]; offset: number; days?: number; params?: Record<string,string | undefined>; demo?: string;
}) {
  const byClient = new Map(apps.flatMap(app => app.clientIds.map(id => [id,app] as const)));
  const items = [
    ...rows.filter(row => params.only_access !== "true" && row.reads).map(row => ({ day: row.day, at: row.last_at ?? "", key: `read-${row.app.hrefId}`, row })),
    ...rows.filter(row => row.permission_refusals).map(row => ({ day: row.day, at: row.last_refusal_at ?? row.last_at ?? "", key: `refused-${row.app.hrefId}`, refusal: row })),
    ...changes.filter(change=>byClient.has(change.client_id)).map(change => ({ day: change.day, at: change.at, key: change.id, change })),
  ].sort((a,b) => b.at.localeCompare(a.at));
  const shown = visibleDays(items,days);
  return <>
    <PageHeader title="Activity" description="What apps read, and when." />
    <p className="mb-6 text-[13px] text-muted-foreground">DataConnect keeps what an app read, not what it asked.</p>
    <form className="mb-6 flex flex-wrap items-center gap-4">{demo ? <input type="hidden" name="demo" value={demo} /> : null}<select aria-label="App" className="min-h-11 rounded-md border border-border bg-background px-3" name="app" defaultValue={params.app ?? ""}><option value="">All apps</option>{apps.map(app => <option key={app.hrefId} value={app.hrefId}>{app.name}{apps.some(other=>other !== app && other.name === app.name) ? ` (${app.place})` : ""}</option>)}</select><select aria-label="Data source" className="min-h-11 rounded-md border border-border bg-background px-3" name="connection_id" defaultValue={params.connection_id ?? ""}><option value="">All data sources</option>{sources.map(source => <option key={source.id} value={source.id}>{source.name}</option>)}</select><label className="flex min-h-11 items-center gap-2"><input name="only_access" type="checkbox" value="true" defaultChecked={params.only_access === "true"} />Only changes to access</label><button className="min-h-11 text-primary" type="submit">Show</button></form>
    {shown.map(day => <Section key={day} title={dayLabel(day,offset)}><ul className="divide-y divide-border">{items.filter(item=>item.day===day).map(item => <li className="py-4" key={item.key}>{"row" in item && item.row ? <Link className="flex justify-between gap-4" href={appDayHref(item.row,demo)}><div><p>{item.row.app.name} read your data {item.row.reads} times</p>{apps.some(app=>app.name === item.row.app.name && app !== item.row.app) ? <p className="text-[13px] text-muted-foreground">{item.row.app.place}</p> : null}<ReadDayLines row={item.row} sources={sources} /></div><span className="shrink-0 text-[13px] text-muted-foreground">{historyTime(item.row.last_at,offset)}</span></Link> : "refusal" in item && item.refusal ? <Link href={appDayHref(item.refusal,demo)}>{item.refusal.app.name} was refused · {item.refusal.permission_refusals} times: it asked for something it may not read.</Link> : "change" in item && item.change ? <Link className="flex justify-between gap-4" href={`/grants/${encodeURIComponent((byClient.get(item.change.client_id) as AppAccess).hrefId)}`}><p><span className="mr-2" aria-hidden="true">◇</span>{changeSentence(item.change,byClient.get(item.change.client_id) as AppAccess,sources)}</p><span className="shrink-0 text-[13px] text-muted-foreground">{historyTime(item.at,offset)}</span></Link> : null}</li>)}</ul></Section>)}
    {!items.length ? params.app || params.connection_id || params.only_access ? <><p>Nothing matches.</p><Link href="/audit">Show everything</Link></> : <><p>No app has read your data yet.</p><p className="text-muted-foreground">When an app reads, it shows here.</p>{!apps.length ? <Link href="/connect-ai">Connect an app</Link> : null}</> : null}
    {visibleDays(items,10000).length > shown.length ? <Link href={historyHref("/audit",params,{ days: String(days+7) })}>Earlier</Link> : null}
  </>;
}
