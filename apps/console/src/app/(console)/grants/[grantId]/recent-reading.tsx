// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { AppAccess } from "../app-access.ts";
import { Section } from "@pdpp/operator-ui/components/primitives";
import Link from "next/link";
import { appDayHref, ReadDayLines } from "../../audit/activity-view.tsx";
import { dayLabel } from "../../history/day-cut.ts";
import type { NamedAppDay } from "../../history/history-apps.ts";
import type { HistorySource } from "../../history/source-names.ts";
export function RecentReading({
  rows,
  sources,
  offset,
  demo,
  app,
}: {
  rows: NamedAppDay[];
  sources: HistorySource[];
  offset: number;
  demo?: string;
  app?: Pick<AppAccess,"state"|"lastRead">;
}) {
  if (!rows.length) {
    let empty="No recent reading to show.";
    if(app && !app.lastRead) {empty=app.state === "stopped" ? "No reading is recorded from when it had access." : "It has not read anything yet.";}
    return <Section title="What it has read lately"><p>{empty}</p></Section>;
  }
  return (
    <Section title="What it has read lately">
      <ul className="divide-y divide-border">
        {rows.slice(0, 5).map((row) => (
          <li className="py-3" key={row.day}>
            <Link href={appDayHref(row, demo)}>
              <p>
                {dayLabel(row.day, offset)}{" "}
                · read your data {row.reads === 1 ? "once" : `${row.reads.toLocaleString("en-US")} times`}
              </p>
              <ReadDayLines row={row} sources={sources} />
            </Link>
          </li>
        ))}
      </ul>
      <Link
        className="text-primary"
        href={`/audit?app=${encodeURIComponent(rows[0]?.app.hrefId ?? "")}${demo ? "&demo=app" : ""}`}
      >
        All activity
      </Link>
    </Section>
  );
}
