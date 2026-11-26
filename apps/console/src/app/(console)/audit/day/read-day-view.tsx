// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { ConnectorMark } from "../../components/connector-mark.tsx";
import { PageHeader } from "@pdpp/operator-ui/components/primitives";
import Link from "next/link";
import type { AppReadEntry } from "../../lib/ref-client.ts";
import type { AppAccess } from "../../grants/app-access.ts";
import { sentenceDayLabel } from "../../history/day-cut.ts";
import type { HistorySource } from "../../history/source-names.ts";
import { ReadDayPager, type ReadPage } from "./read-day-pager.tsx";
// biome-ignore lint/performance/noBarrelFile: Preserve the existing read-line grouping entry point for callers.
export {groupReadLines} from "./read-day-rows.tsx";
export function ReadDayView({app,day,offset,rows,sources,discovery=[],nextCursor,loadMore,pageKey,startsAtBeginning=true}:{startsAtBeginning?:boolean;app:AppAccess;day:string;offset:number;rows:AppReadEntry[];sources:HistorySource[];pageKey?:string;discovery?:AppReadEntry[];moreHref?:string;nextCursor?:string|null;loadMore?:(cursor:string)=>Promise<ReadPage>}) {
  return <><PageHeader breadcrumbs={[{href:"/audit",label:"Activity"}]} title={<span className="inline-flex items-center gap-3"><ConnectorMark connectorId={app.name} name={app.name} /><span>{app.name}, {sentenceDayLabel(day,offset)}</span></span>} />
    <ReadDayPager key={pageKey ?? `${day}:${app.hrefId}`} rows={rows} discovery={discovery} sources={sources} offset={offset} nextCursor={nextCursor} loadMore={loadMore} startsAtBeginning={startsAtBeginning} />
    <p className="my-6"><Link className="text-primary underline-offset-4 hover:underline" href={`/grants/${encodeURIComponent(app.hrefId)}`}>See {app.name}</Link></p>
    <Link className="text-[13px] text-muted-foreground" href={`/audit/technical?client_id=${encodeURIComponent(app.clientIds[0] ?? "")}`}>Technical details</Link>
  </>;
}
