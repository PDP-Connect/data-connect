// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { notFound } from "next/navigation";
import { RecordroomShellWithPalette } from "../../components/recordroom-shell-with-palette.tsx";
import { DayCut } from "../../history/day-cut-client.tsx";
import { ReadDayView } from "./read-day-view.tsx";
import { loadReadDay } from "./load-read-day.ts";
export const dynamic = "force-dynamic";
export default async function Page({searchParams}:{searchParams:Promise<Record<string,string | undefined>>}) {
  const model=await loadReadDay(await searchParams);
  if(!model)notFound();
  return <RecordroomShellWithPalette><DayCut /><ReadDayView {...model} /></RecordroomShellWithPalette>;
}
