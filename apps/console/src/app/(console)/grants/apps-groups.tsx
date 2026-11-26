"use client";
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { IcButton, IcInput, buttonVariants } from "@pdpp/brand-react";
import { Section } from "@pdpp/operator-ui/components/primitives";
import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import type { AppAccess } from "./app-access.ts";
import { AppAccessList } from "./app-access-list.tsx";
import { removeAppAction } from "./remove-app-action.ts";
import { unusedApps, removeUnusedApps } from "./unused-apps.ts";
export function AppsGroups({apps, demo, waiting}: {apps: AppAccess[]; demo?: string; waiting?: {name: string; place: string; node: React.ReactNode}[]}) {
 const router=useRouter();
 const [query,setQuery]=useState(""); const [showAll,setShowAll]=useState(false); const [confirm,setConfirm]=useState(false); const [busy,setBusy]=useState(false); const [failed,setFailed]=useState<string[]>([]); const [removed,setRemoved]=useState<string[]>([]);
 const reading=apps.filter(app=>app.state==='reading'&&!removed.includes(app.hrefId));
 const unused=unusedApps(reading);
 const recent=reading.filter(app=>!unused.includes(app));
 const matches=(app:AppAccess)=>`${app.name} ${app.place}`.toLowerCase().includes(query.trim().toLowerCase());
 const stopped=apps.filter(app=>app.state==='stopped'||removed.includes(app.hrefId)).sort((a,b)=>(b.stoppedAt||'').localeCompare(a.stoppedAt||''));
 async function remove() {
   setBusy(true);setFailed([]);
   try {
    const result=await removeUnusedApps(unused,demo?async()=>({ok:true,message:null}):removeAppAction);
    setFailed(result.failedNames); if(result.ok){setConfirm(false);setRemoved(previous=>[...previous,...unused.map(app=>app.hrefId)]);} if(!demo)router.refresh();
   } catch {setFailed(unused.map(app=>app.name));}
   finally{setBusy(false);}
 }
 return <>
  {apps.length>10?<IcInput aria-label="Find an app" placeholder="Find an app" value={query} onChange={event=>setQuery(event.target.value)} />:null}
  {waiting?.length ? <Section id="pending-approvals" title="Waiting for you"><ul>{waiting.filter(row=>`${row.name} ${row.place}`.toLowerCase().includes(query.trim().toLowerCase())).map((row,index)=><li key={index}>{row.node}</li>)}</ul></Section> : null}
  {!reading.length?<Section title="No app can read your data yet."><Link className={buttonVariants()} href="/connect">Connect an app</Link></Section>:<Section title={`Can read your data${reading.length>5?` · ${reading.length}`:''}`}>
    {recent.length?<AppAccessList apps={recent} demo={demo} query={query}/>:null}
    {unused.length?<div className="mt-6 space-y-3"><h3 className="pdpp-title">Not used in the last 30 days · {unused.length}</h3>
     <p>Don't recognise an app, or no longer use it? Remove its access. It keeps anything it already read.</p>
     <IcButton variant="destructive" onClick={()=>setConfirm(true)}>Remove access for all {unused.length}</IcButton>
     {confirm?<div role="alertdialog" aria-label="Remove unused apps" className="space-y-3 rounded-md border border-border p-3"><p>Remove access for {unused.length} apps you have not used in the last 30 days? They keep anything they already read.</p><IcButton variant="destructive" disabled={busy} onClick={()=>void remove()}>Remove access for {unused.length} apps</IcButton><IcButton variant="ghost" disabled={busy} onClick={()=>setConfirm(false)}>Cancel</IcButton></div>:null}
     {failed.length?<div role="alert" className="text-destructive"><p>Access could not be removed for {failed.join(', ')}.</p><IcButton variant="ghost" disabled={busy} onClick={()=>void remove()}>Try again</IcButton></div>:null}
     <AppAccessList apps={showAll?unused.filter(matches):unused.filter(matches).slice(0,5)} demo={demo}/>
     {!showAll&&unused.filter(matches).length>5?<IcButton variant="ghost" onClick={()=>setShowAll(true)}>Show all {unused.filter(matches).length}</IcButton>:null}
    </div>:null}
  </Section>}
  {stopped.length?<Section title="No longer have access"><AppAccessList apps={stopped} query={query} stopped demo={demo}/></Section>:null}
 </>;
}
