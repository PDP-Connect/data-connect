"use client";
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { IcButton } from "@pdpp/brand-react";
import Link from "next/link";
import { useState } from "react";
import { type AppAccess, formatAppLastRead } from "./app-access.ts";
export function sourcePhrase(names: readonly string[]) {
  return names.length > 3 ? `${names.slice(0, 3).join(", ")} and ${names.length - 3} more` : names.join(", ");
}
export function accessEnd(value: string | null, now = Date.now()) {
  if (!value) {
    return null;
  }
  const days = Math.ceil((Date.parse(value) - now) / 86_400_000);
  return days > 0 && days <= 7
    ? `access ends in ${days} day${days === 1 ? "" : "s"}`
    : `access ends ${new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })}`;
}
export function AppAccessList({
  apps,
  demo,
  stopped = false,
  query = "",
}: {
  apps: readonly AppAccess[];
  demo?: string;
  stopped?: boolean;
  query?: string;
}) {
  const [showAll, setShowAll] = useState(false);
  const filtered = apps.filter((app) => `${app.name} ${app.place}`.toLowerCase().includes(query.toLowerCase()));
  const visible = stopped && !showAll ? filtered.slice(0, 5) : filtered;
  return (
    <>
      <ul className="divide-y divide-border border-border border-y">
        {visible.map((app) => (
          <li key={app.hrefId}>
            <Link
              className="block py-4"
              href={`/grants/${encodeURIComponent(app.hrefId)}${demo ? `?demo=${encodeURIComponent(demo)}` : ""}`}
            >
              <span className="block font-medium text-[15px]">{app.name}</span>
              {app.place && app.place !== "no address given" && app.place !== app.name ? <span className="block text-[13px] text-muted-foreground">{app.place}</span> : null}
              {stopped ? (
                <span className="block text-[13px] text-muted-foreground">
                  {app.stoppedReason === "expired" ? "Ended" : "Removed"}
                  {app.stoppedAt ? ` ${formatAppLastRead(app.stoppedAt)}` : ""}
                </span>
              ) : (
                <>
                  <span className="block text-[13px] text-muted-foreground">
                    Can read {app.readsAllSources ? "all your data sources" : sourcePhrase(app.sources)}
                  </span>
                  <span className="block text-[13px] text-muted-foreground">
                    {app.lastRead ? `Last read ${formatAppLastRead(app.lastRead)}` : "Has not read anything yet"}
                    {app.expiresAt ? ` · ${accessEnd(app.expiresAt)}` : ""}
                  </span>
                </>
              )}
            </Link>
          </li>
        ))}
      </ul>
      {stopped && filtered.length > 5 && !showAll ? (
        <IcButton onClick={() => setShowAll(true)} variant="ghost">
          Show all {filtered.length}
        </IcButton>
      ) : null}
    </>
  );
}
