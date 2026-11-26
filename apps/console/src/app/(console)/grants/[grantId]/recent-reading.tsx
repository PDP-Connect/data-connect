// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

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
}: {
  rows: NamedAppDay[];
  sources: HistorySource[];
  offset: number;
  demo?: string;
}) {
  if (!rows.length) {
    return <Section title="What it has read lately"><p>It has not read anything yet.</p></Section>;
  }
  return (
    <Section title="What it has read lately">
      <ul className="divide-y divide-border">
        {rows.slice(0, 5).map((row) => (
          <li className="py-3" key={row.day}>
            <Link href={appDayHref(row, demo)}>
              <p>
                {["Today", "Yesterday"].includes(dayLabel(row.day, offset))
                  ? dayLabel(row.day, offset)
                  : new Date(`${row.day}T12:00:00Z`).toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                      timeZone: "UTC",
                    })}{" "}
                · read your data {row.reads} times
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
