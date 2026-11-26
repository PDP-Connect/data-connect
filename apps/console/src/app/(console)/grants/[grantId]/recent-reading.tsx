// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import Link from "next/link";
import { Section } from "@pdpp/operator-ui/components/primitives";
import type { NamedAppDay } from "../../history/history-apps.ts";
import type { HistorySource } from "../../history/source-names.ts";
import { dayLabel } from "../../history/day-cut.ts";
import { ReadDayLines, appDayHref } from "../../audit/activity-view.tsx";
export function RecentReading({ rows, sources, offset, demo }: { rows: NamedAppDay[]; sources: HistorySource[]; offset: number; demo?: string }) {
  if (!rows.length) return null;
  return <Section title="What it has read lately"><ul className="divide-y divide-border">{rows.slice(0,5).map(row => <li className="py-3" key={row.day}><Link href={appDayHref(row,demo)}><p>{dayLabel(row.day,offset)} · read your data {row.reads} times</p><ReadDayLines row={row} sources={sources} /></Link></li>)}</ul><Link className="text-primary" href={`/audit?app=${encodeURIComponent(rows[0]?.app.hrefId ?? "")}${demo ? "&demo=app" : ""}`}>All activity</Link></Section>;
}
