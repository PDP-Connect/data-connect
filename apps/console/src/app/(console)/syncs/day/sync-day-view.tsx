// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { PageHeader } from "@pdpp/operator-ui/components/primitives";
import Link from "next/link";
import type { SyncEntry } from "../../lib/ref-client.ts";
import { clockLabel, sentenceDayLabel, historyHref } from "../../history/day-cut.ts";
import { resolveSyncCause } from "../../history/sync-cause.ts";
import { buttonVariants } from "@/components/ui/button";
export function SyncDayView({ name, day, offset, rows, moreHref, demo }: { name: string; day: string; offset: number; rows: SyncEntry[]; moreHref?: string; demo?: string }) {
  const labels = { finished: "Finished", failed: "Failed", stopped: "Stopped", interrupted: "Interrupted", could_not_start: "Could not start", syncing: "Syncing now" };
  return <><Link href="/syncs">Sync history</Link><PageHeader title={`${name}, ${sentenceDayLabel(day,offset)}`} /><ul className="divide-y divide-border">{rows.map(row => <li className="py-4" key={row.history_id}>{row.id ? <Link href={historyHref(`/syncs/${encodeURIComponent(row.id)}`,{}, { day, connection_id: row.connection_id, ...(demo ? { demo: row.outcome === "failed" ? "auth-failed" : "finished" } : {}) })}><span className="mr-4 text-muted-foreground">{clockLabel(row.at,offset)}</span>{labels[row.outcome]} · {row.records ? `${row.records} new records` : "Nothing new"}</Link> : <p>{clockLabel(row.at,offset)} · {labels[row.outcome]} · {row.records ? `${row.records} new records` : "Nothing new"}</p>}{row.outcome === "failed" ? <p className="text-destructive">{resolveSyncCause(row.evidence ?? {reason:row.cause},name).sentence}</p> : null}{row.outcome === "failed" ? <Link className={buttonVariants()} href={`/sources/${encodeURIComponent(row.connection_id)}`}>{resolveSyncCause(row.evidence ?? {reason:row.cause},name).action}</Link> : null}{row.trigger === "manual" ? <p className="text-[13px] text-muted-foreground">You started it</p> : null}</li>)}</ul>{moreHref ? <Link href={moreHref}>Show more</Link> : null}</>;
}
