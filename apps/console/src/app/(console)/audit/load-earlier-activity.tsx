// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
"use server";
import {loadActivity} from "./load-activity.ts";
import {ActivityDays} from "./activity-view.tsx";
import {groupAppHistory} from "../history/history-apps.ts";
export async function loadEarlierActivity(params:Record<string,string|undefined>,before:string) {
  const model=await loadActivity({...params,before});const history=model.history;
  return {content:<ActivityDays rows={history.mode==="days"?groupAppHistory(history.data,model.apps):[]} changes={history.mode==="days"?history.changes:[]} apps={model.apps} sources={model.sources} offset={model.offset} params={params} demo={params.demo} />,next:history.before_day ?? null,firstDay:history.first_day};
}
