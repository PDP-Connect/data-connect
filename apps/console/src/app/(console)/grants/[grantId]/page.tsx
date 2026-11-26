// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { notFound } from "next/navigation";
import { RecordroomShellWithPalette } from "../../components/recordroom-shell-with-palette.tsx";
import { loadApps } from "../load-apps.ts";
import { AppPage } from "./app-page.tsx";
export const dynamic = "force-dynamic";
export default async function AppDetailPage({ params, searchParams }: { params: Promise<{ grantId: string }>; searchParams: Promise<{ demo?: string }> }) {
  const { grantId } = await params;
  const { demo } = await searchParams;
  const { apps } = await loadApps(demo);
  const app = apps.find((item) => item.grantIds.includes(decodeURIComponent(grantId)));
  if (!app) notFound();
  return <RecordroomShellWithPalette><AppPage app={app} demo={demo} /></RecordroomShellWithPalette>;
}
