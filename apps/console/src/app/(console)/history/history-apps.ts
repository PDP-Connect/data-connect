// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import type { AppReadDay } from "../lib/ref-client.ts";
import { groupGrantAccessByApp, type AppAccess } from "../grants/app-access.ts";
import { buildAppPractice } from "../grants/app-practice.ts";
import { appPractice } from "./practice.ts";
export function practiceHistoryApps(state: string): AppAccess[] {
  if (state === "empty") return [];
  const base = buildAppPractice("mixed").registrations[0];
  if (!base) return [];
  return groupGrantAccessByApp(Array.from({ length: state === "thirty" ? 30 : 2 }, (_,index) => ({ ...structuredClone(base), client_id: `practice-app-${index}`, client_name: index === 0 ? "ChatGPT" : index === 1 ? "Claude" : `Northwind Notes ${index}`, return_host: index === 0 ? "chatgpt.com" : index === 1 ? "claude.ai" : "notes.northwind.example", sources: base.sources.map(source => ({ ...structuredClone(source), grant_ids: [`practice-access-${index}`], active_grant_ids: [`practice-access-${index}`] })) })));
}
export interface NamedAppDay extends AppReadDay { app: AppAccess }
export function groupAppHistory(rows: AppReadDay[], apps: AppAccess[]): NamedAppDay[] {
  const groups = new Map<string,NamedAppDay>();
  const byClient = new Map(apps.flatMap(app => app.clientIds.map(id => [id, app] as const)));
  for (const row of rows) {
    const app = byClient.get(row.client_id);
    if (!app) continue;
    const key = `${row.day}\0${app.hrefId}`;
    let day = groups.get(key);
    if (!day) { day = { ...row, reads: 0, across_sources: 0, permission_refusals: 0, sources: [], app }; groups.set(key,day); }
    if (row.last_refusal_at && row.last_refusal_at > (day.last_refusal_at ?? "")) day.last_refusal_at = row.last_refusal_at;
    day.reads += row.reads; day.across_sources += row.across_sources; day.permission_refusals += row.permission_refusals;
    if ((row.last_at ?? "") > (day.last_at ?? "")) day.last_at = row.last_at;
    for (const source of row.sources) {
      const existing = day.sources.find(item => item.source_id === source.source_id && item.connection_id === source.connection_id && item.source_kind === source.source_kind);
      if (!existing) day.sources.push({...source});
      else { existing.reads += source.reads; existing.records = existing.records === null && source.records === null ? null : (existing.records ?? 0)+(source.records ?? 0); }
    }
  }
  for (const row of groups.values()) row.sources.sort((a,b) => b.reads-a.reads);
  return [...groups.values()].sort((a,b) => b.day.localeCompare(a.day) || (b.last_at ?? "").localeCompare(a.last_at ?? ""));
}
export function practiceAppHistory(state: string, offset: number) {
  const history = appPractice(state,offset);
  const apps = practiceHistoryApps(state);
  if (history.mode === "days" && state === "thirty") history.changes = [];
  return { history, apps };
}
