// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { buttonVariants } from "@pdpp/brand-react";
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
  return <SourceAppsList apps={apps} connectionId={connectionId} />;
}
export function SourceAppsList({ apps, connectionId }: { apps: AppAccess[]; connectionId: string }) {
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
                {app.place}
                {since
                  ? ` · since ${new Date(since).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })}`
                  : ""}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <>
          <p>No app can read this yet.</p>
          <Link className={buttonVariants()} href="/connect">
            Connect an app
          </Link>
        </>
      )}
    </Section>
  );
}
