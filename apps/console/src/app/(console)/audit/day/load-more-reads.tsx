// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
"use server";
import {loadReadDay} from "./load-read-day.ts";
import {ReadDayRows} from "./read-day-view.tsx";
export async function loadMoreReads(params:Record<string,string|undefined>,cursor:string) {
  const model=await loadReadDay({...params,cursor});if(!model)throw Error("This day could not be loaded");
  return {content:<ReadDayRows rows={model.rows} sources={model.sources} offset={model.offset} />,next:model.nextCursor};
}
