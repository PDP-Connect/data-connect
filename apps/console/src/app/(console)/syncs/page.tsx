// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import Link from "next/link";
import { redirect } from "next/navigation";
import { PageHeader } from "@pdpp/operator-ui/components/primitives";
import { RecordroomShellWithPalette } from "../components/recordroom-shell-with-palette.tsx";
import { DayCut } from "../history/day-cut-client.tsx";
import { historyDayCount } from "../history/day-cut.ts";
import { LivePoller } from "../components/live-poller.tsx";
import { DailySyncsView } from "./daily-syncs-view.tsx";
import { loadSyncHistory } from "./load-sync-history.ts";
export const dynamic = "force-dynamic";
export default async function RunsPage({ searchParams }: { searchParams: Promise<Record<string,string | undefined>> }) {
  const params = { ...await searchParams };
  if (params.demo === "problems") params.only_problems ??= "true";
  if (params.demo === "source") params.connection_id ??= "practice-source-0";
  if (params.peek) redirect(`/syncs/${encodeURIComponent(params.peek)}`);
  let model: Awaited<ReturnType<typeof loadSyncHistory>>;
  try { model = await loadSyncHistory(params); }
  catch { return <RecordroomShellWithPalette><PageHeader title="Sync history" /><p>This could not be loaded. <Link href="/syncs">Try again</Link>.</p></RecordroomShellWithPalette>; }
  return <RecordroomShellWithPalette><DayCut /><LivePoller enabled={model.now.length > 0} /><DailySyncsView rows={model.history.mode === "days" ? model.history.data : []} sources={model.sources} current={model.now} offset={model.offset} days={historyDayCount(params.days)} params={params} demo={params.demo} /></RecordroomShellWithPalette>;
}
