// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { notFound } from "next/navigation";
import { RecordroomShellWithPalette } from "../../components/recordroom-shell-with-palette.tsx";
import { DayCut } from "../../history/day-cut-client.tsx";
import { flowPreviewState } from "../../connect/flow-preview.ts";
import { practiceEnabled } from "../../history/practice.ts";
import { RunDetailPoller } from "./run-detail-poller.tsx";
import TechnicalPage from "./technical-page.tsx";
import { loadOneSync } from "./load-one-sync.ts";
import { OneSyncView } from "./one-sync-view.tsx";
export const dynamic = "force-dynamic";
export default async function RunDetailPage({ params, searchParams }: { params: Promise<{ runId: string }>; searchParams: Promise<Record<string,string | undefined>> }) {
  const query = await searchParams;
  if (flowPreviewState("details",query)) return <TechnicalPage params={params} searchParams={Promise.resolve(query)} />;
  const { runId } = await params;
  const { model,offset } = await loadOneSync(decodeURIComponent(runId),query);
  if (!model) notFound();
  return <RecordroomShellWithPalette><DayCut /><RunDetailPoller enabled={model.outcome === "syncing" || model.outcome === "needs_you"} /><OneSyncView model={model} offset={offset} practice={practiceEnabled(query.demo)} /></RecordroomShellWithPalette>;
}
