// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
"use client";
import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
export interface HistoryPageChunk { content: ReactNode; next: string | null; firstDay?: string | null }
export function historyStartLabel(day: string): string {
  return `History starts ${new Date(`${day}T12:00:00Z`).toLocaleDateString("en-GB",{day:"numeric",month:"short",year:"numeric",timeZone:"UTC"})}.`;
}
export function AppendHistory({ initial, load, label }: { initial: HistoryPageChunk; load?: (cursor: string)=>Promise<HistoryPageChunk>; label: "Earlier" | "Show more" }) {
  const [pages,setPages]=useState([{...initial,key:"initial"}]);
  const [busy,setBusy]=useState(false);const [error,setError]=useState(false);
  const last=pages[pages.length-1];
  async function append() {
    if (!last?.next || !load || busy) return;
    setBusy(true);setError(false);
    try { const page=await load(last.next); setPages(previous=>[...previous,{...page,key:last.next as string}]); }
    catch { setError(true); } finally { setBusy(false); }
  }
  return <>{pages.map(page=><div key={page.key}>{page.content}</div>)}{error ? <p>This could not be loaded. Try again.</p> : null}{last?.next && load ? <Button disabled={busy} onClick={append} type="button" variant="outline">{busy ? "Loading…" : label}</Button> : !last?.next && last?.firstDay ? <p className="my-6 text-muted-foreground">{historyStartLabel(last.firstDay)}</p> : null}</>;
}
