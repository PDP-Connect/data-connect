// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { PageHeader } from "@pdpp/operator-ui/components/primitives";
import Link from "next/link";
import type { AppReadEntry } from "../../lib/ref-client.ts";
import type { AppAccess } from "../../grants/app-access.ts";
import { clockLabel, sentenceDayLabel } from "../../history/day-cut.ts";
import { sourceName, type HistorySource } from "../../history/source-names.ts";
import { readSentence, refusalReason } from "./read-sentence.ts";
export function ReadDayView({ app, day, offset, rows, sources, moreHref }: { app: AppAccess; day: string; offset: number; rows: AppReadEntry[]; sources: HistorySource[]; moreHref?: string }) {
  return <><Link href="/audit">Activity</Link><PageHeader title={`${app.name}, ${sentenceDayLabel(day,offset)}`} /><ul className="divide-y divide-border">{rows.map(row => <li className="py-4" key={row.id}><p><span className="mr-4 text-[13px] text-muted-foreground">{clockLabel(row.at,offset)}</span>{readSentence(row,row.source_id ? sourceName(sources,row.connection_id ?? row.source_id,row.source_id) : null)}{row.refused ? " · refused" : ""}</p>{row.refused && refusalReason(row.reason) ? <p className="text-[13px] text-muted-foreground">{refusalReason(row.reason)}</p> : null}</li>)}</ul>{moreHref ? <Link href={moreHref}>Show more</Link> : null}{app.grantIds.length ? <p className="my-6"><Link href={`/grants/${encodeURIComponent(app.hrefId)}`}>See {app.name}</Link></p> : null}<Link className="text-[13px] text-muted-foreground" href={`/audit/technical?client_id=${encodeURIComponent(app.clientIds[0] ?? "")}`}>Technical details</Link></>;
}
