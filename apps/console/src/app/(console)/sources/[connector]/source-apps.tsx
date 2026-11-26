// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { personDate } from "../../history/day-cut.ts";
import { readPersonOffset } from "../../history/server-day.ts";
import { Section } from "@pdpp/operator-ui/components/primitives";
import Link from "next/link";
import type { AppAccess } from "../../grants/app-access.ts";
import { groupGrantAccessByApp } from "../../grants/app-access.ts";
import { listAppAccess } from "../../lib/ref-client.ts";
export async function SourceApps({ connectionId }: { connectionId: string }) {
  let apps: AppAccess[];
  try {
    apps = groupGrantAccessByApp((await listAppAccess()).data);
  } catch {
    return null;
  }
  return <SourceAppsList apps={apps} connectionId={connectionId} offset={await readPersonOffset()} />;
}
export function SourceAppsList({ apps, connectionId,offset=0 }: { apps: AppAccess[]; connectionId: string;offset?:number }) {
  const allowed = apps.flatMap((app) => {
    const sources = app.sourceAccess.filter(
      (row) => row.in_force && (row.source.connection_id === connectionId || row.connection_ids?.includes(connectionId))
    );
    return sources.length ? [{ app, since: sources.map((row) => row.first_issued_at).sort()[0] }] : [];
  });
  return (
    <Section title="Apps that can read this">
      {allowed.length ? (
        <ul className="divide-y divide-border">
          {allowed.map(({ app, since }) => (
            <li className="py-3" key={app.hrefId}>
              <Link href={`/grants/${encodeURIComponent(app.hrefId)}`}>{app.name}</Link>
              <span className="ml-3 text-[13px] text-muted-foreground">
                {app.place && app.place !== "no address given" && app.place !== app.name ? app.place : ""}
                {since
                  ? ` · since ${personDate(since,offset)}`
                  : ""}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <>
          <p>No app can read this yet.</p>
          <Link className="underline underline-offset-4 hover:text-foreground" href="/connect">
            Connect an app
          </Link>
        </>
      )}
    </Section>
  );
}
