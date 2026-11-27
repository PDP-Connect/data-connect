// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
"use server";
import { loadSyncDay } from "./load-sync-day.ts";
import { SyncDayRows } from "./sync-day-view.tsx";
export async function loadMoreSyncs(params:Record<string,string|undefined>,cursor:string) {
  const model=await loadSyncDay({...params,cursor});
  if(!model)throw Error("This day could not be loaded");
  return {content:<SyncDayRows {...model} />,next:model.nextCursor ?? null};
}
