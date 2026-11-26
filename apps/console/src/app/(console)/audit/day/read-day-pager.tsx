"use client";
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import {useState} from "react";
import {IcButton} from "@pdpp/brand-react";
import type {AppReadEntry} from "../../lib/ref-client.ts";
import type {HistorySource} from "../../history/source-names.ts";
import {ReadDayRows} from "./read-day-rows.tsx";
export interface ReadPage {rows:AppReadEntry[];next:string|null}
/** Keep the raw page join until grouping, so identical boundary reads become one line. */
export function ReadDayPager({rows,discovery,sources,offset,nextCursor,loadMore}:{rows:AppReadEntry[];discovery:AppReadEntry[];sources:HistorySource[];offset:number;nextCursor?:string|null;loadMore?:(cursor:string)=>Promise<ReadPage>}) {
  const [extra,setExtra]=useState<AppReadEntry[]>([]);
  const [next,setNext]=useState(nextCursor ?? null);
  const [busy,setBusy]=useState(false);const [error,setError]=useState(false);
  async function append() {
    if(!(next && loadMore ) || busy) { return; }
    setBusy(true);setError(false);
    try {const page=await loadMore(next);setExtra(previous=>[...previous,...page.rows]);setNext(page.next);} catch {setError(true);} finally {setBusy(false);}
  }
  return <><ReadDayRows rows={[...rows,...extra]} sources={sources} offset={offset} />
    {discovery.length ? <><ReadDayRows rows={discovery} sources={sources} offset={offset} /><p className="text-[13px] text-muted-foreground">Asking what it may read is not reading your data.</p></> : null}
    {error ? <p>This could not be loaded. Try again.</p> : null}
    {next && loadMore ? <IcButton disabled={busy} onClick={append} type="button">{busy?"Loading…":"Show more"}</IcButton> : null}
  </>;
}
