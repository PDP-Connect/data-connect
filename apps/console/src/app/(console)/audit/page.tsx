// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import Link from "next/link";
import { PageHeader } from "@pdpp/operator-ui/components/primitives";
import { RecordroomShellWithPalette } from "../components/recordroom-shell-with-palette.tsx";
import { DayCut } from "../history/day-cut-client.tsx";
import { historyDayCount } from "../history/day-cut.ts";
import { groupAppHistory } from "../history/history-apps.ts";
import { ActivityView } from "./activity-view.tsx";
import { loadEarlierActivity } from "./load-earlier-activity.tsx";
import { loadActivity } from "./load-activity.ts";
export const dynamic = "force-dynamic";
export default async function TracesPage({ searchParams }: { searchParams: Promise<Record<string,string | undefined>> }) {
  const params = { ...await searchParams };
  if (params.demo === "changes") params.only_access ??= "true";
  if (params.demo === "app") params.app ??= "practice-access-0";
  let model: Awaited<ReturnType<typeof loadActivity>>;
  try { model = await loadActivity(params); }
  catch { return <RecordroomShellWithPalette><PageHeader title="Activity" /><p>This could not be loaded. <Link href="/audit">Try again</Link>.</p></RecordroomShellWithPalette>; }
  return <RecordroomShellWithPalette><DayCut /><ActivityView rows={model.history.mode === "days" ? groupAppHistory(model.history.data,model.apps) : []} changes={model.history.mode === "days" ? model.history.changes : []} apps={model.apps} sources={model.sources} offset={model.offset} days={historyDayCount(params.days)} firstDay={model.history.first_day} beforeDay={model.history.before_day} loadMore={loadEarlierActivity.bind(null,params)} params={params} demo={params.demo} /></RecordroomShellWithPalette>;
}
