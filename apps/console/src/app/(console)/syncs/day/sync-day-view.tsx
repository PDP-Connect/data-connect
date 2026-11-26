// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { PageHeader } from "@pdpp/operator-ui/components/primitives";
import Link from "next/link";
import type { SyncEntry } from "../../lib/ref-client.ts";
import { clockLabel, dayLabel, historyHref } from "../../history/day-cut.ts";
import { syncCause } from "../daily-syncs-view.tsx";
export function SyncDayView({ name, day, offset, rows, moreHref, demo }: { name: string; day: string; offset: number; rows: SyncEntry[]; moreHref?: string; demo?: string }) {
  const labels = { finished: "Finished", failed: "Failed", stopped: "Stopped", interrupted: "Interrupted", could_not_start: "Could not start", syncing: "Syncing now" };
  return <><Link href="/syncs">Sync history</Link><PageHeader title={`${name}, ${dayLabel(day,offset).toLowerCase()}`} /><ul className="divide-y divide-border">{rows.map(row => <li className="py-4" key={row.history_id}>{row.id ? <Link href={historyHref(`/syncs/${encodeURIComponent(row.id)}`,{}, { day, connection_id: row.connection_id, ...(demo ? { demo: row.outcome === "failed" ? "auth-failed" : "finished" } : {}) })}><span className="mr-4 text-muted-foreground">{clockLabel(row.at,offset)}</span>{labels[row.outcome]} · {row.records ? `${row.records} new records` : "Nothing new"}</Link> : <p>{clockLabel(row.at,offset)} · {labels[row.outcome]} · {row.records ? `${row.records} new records` : "Nothing new"}</p>}{row.outcome === "failed" && syncCause(row.cause,name) ? <p className="text-destructive">{syncCause(row.cause,name)}</p> : null}{row.trigger === "manual" ? <p className="text-[13px] text-muted-foreground">You started it</p> : null}</li>)}</ul>{moreHref ? <Link href={moreHref}>Show more</Link> : null}</>;
}
