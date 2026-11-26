// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { notFound } from "next/navigation";
import { RecordroomShellWithPalette } from "../../components/recordroom-shell-with-palette.tsx";
import { loadActivity } from "../load-activity.ts";
import { listAppHistory } from "../../lib/ref-client.ts";
import { DayCut } from "../../history/day-cut-client.tsx";
import { readPersonOffset } from "../../history/server-day.ts";
import { historyHref, personDay } from "../../history/day-cut.ts";
import { historyPracticeSources, practiceEnabled, readPractice } from "../../history/practice.ts";
import { practiceHistoryApps } from "../../history/history-apps.ts";
import { ReadDayView } from "./read-day-view.tsx";
export const dynamic = "force-dynamic";
export default async function ReadDayPage({ searchParams }: { searchParams: Promise<Record<string,string | undefined>> }) {
  const params = await searchParams; const practice = practiceEnabled(params.demo); const offset = await readPersonOffset();
  const { apps,sources } = practice ? { apps: practiceHistoryApps("mixed"),sources: historyPracticeSources() } : await loadActivity({});
  const app = practice ? apps[0] : apps.find(app => app.hrefId === params.app);
  const day = params.day ?? (practice ? personDay(Date.now(),offset) : "");
  if (!app || !day) notFound();
  const history = practice ? readPractice(params.demo as string) : await listAppHistory({ first: day, last: day, day, offset, client_ids: app.clientIds, limit: params.more === "1" ? 100 : 50, ...(params.cursor ? { cursor: params.cursor } : {}) });
  if (history.mode !== "reads") notFound();
  const rows = practice ? history.data.slice(0,params.more === "1" ? 100 : 50) : history.data;
  const more = history.has_more || rows.length < history.data.length;
  return <RecordroomShellWithPalette><DayCut /><ReadDayView app={app} day={day} offset={offset} rows={rows} sources={sources} moreHref={more ? historyHref("/audit/day",params,history.next_cursor ? { cursor: history.next_cursor } : { more: "1" }) : undefined} /></RecordroomShellWithPalette>;
}
