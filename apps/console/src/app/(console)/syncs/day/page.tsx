// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { notFound } from "next/navigation";
import { RecordroomShellWithPalette } from "../../components/recordroom-shell-with-palette.tsx";
import { DayCut } from "../../history/day-cut-client.tsx";
import { SyncDayView } from "./sync-day-view.tsx";
import { loadMoreSyncs } from "./load-more-syncs.tsx";
import { loadSyncDay } from "./load-sync-day.ts";
export const dynamic = "force-dynamic";
export default async function Page({searchParams}:{searchParams:Promise<Record<string,string | undefined>>}) {
  const params=await searchParams;
  const model=await loadSyncDay(params);
  if(!model)notFound();
  return <RecordroomShellWithPalette><DayCut /><SyncDayView {...model} loadMore={loadMoreSyncs.bind(null,params)} /></RecordroomShellWithPalette>;
}
