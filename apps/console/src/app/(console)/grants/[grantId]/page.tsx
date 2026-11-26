// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { notFound } from "next/navigation";
import { RecordroomShellWithPalette } from "../../components/recordroom-shell-with-palette.tsx";
import { loadApps } from "../load-apps.ts";
import { DayCut } from "../../history/day-cut-client.tsx";
import { loadRecentReading } from "./load-recent-reading.ts";
import { AppPage } from "./app-page.tsx";
export const dynamic = "force-dynamic";
export default async function AppDetailPage({ params, searchParams }: { params: Promise<{ grantId: string }>; searchParams: Promise<{ demo?: string }> }) {
  const { grantId } = await params;
  const query = await searchParams;
  const demo = process.env.NODE_ENV !== "production" ? query.demo : undefined;
  const { apps } = await loadApps(demo);
  const app = apps.find((item) => item.grantIds.includes(decodeURIComponent(grantId)) || item.hrefId === decodeURIComponent(grantId));
  if (!app) notFound();
  const recent = await loadRecentReading(app,demo);
  return <RecordroomShellWithPalette><DayCut /><AppPage app={app} demo={demo} recent={recent} /></RecordroomShellWithPalette>;
}
