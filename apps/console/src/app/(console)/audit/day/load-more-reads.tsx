// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
"use server";
import {loadReadDay} from "./load-read-day.ts";
export async function loadMoreReads(params:Record<string,string|undefined>,cursor:string) {
  const model=await loadReadDay({...params,cursor});if(!model) { throw Error("This day could not be loaded"); }
  return {rows:model.rows,next:model.nextCursor};
}
