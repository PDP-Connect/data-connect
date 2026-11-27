// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
"use server";
import { loadSyncHistory } from "./load-sync-history.ts";
import { SyncHistoryDays } from "./daily-syncs-view.tsx";
export async function loadEarlierSyncDays(params: Record<string,string | undefined>, before: string) {
  const model=await loadSyncHistory({...params,before});
  return {content:<SyncHistoryDays rows={model.history.mode==="days"?model.history.data:[]} sources={model.sources} offset={model.offset} demo={params.demo} onlyProblems={params.only_problems==="true"} />,next:model.history.before_day ?? null,firstDay:model.history.data.length ? model.history.first_day : null};
}
