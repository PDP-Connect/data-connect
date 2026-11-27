// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { PageHeader } from "@pdpp/operator-ui/components/primitives";
import { TimelineDetailView } from "@pdpp/operator-ui/components/views/timeline-detail-view";
import { dashboardRoutes } from "@pdpp/operator-ui/components/views/routes";
import Link from "next/link";
import { notFound } from "next/navigation";
import { RecordroomShellWithPalette } from "../../../components/recordroom-shell-with-palette.tsx";
import { getAsInternalUrl } from "../../../lib/owner-token.ts";
import { getGrantTimeline, listAppAccess } from "../../../lib/ref-client.ts";
import { groupGrantAccessByApp } from "../../app-access.ts";
export const dynamic = "force-dynamic";
export default async function AppTechnicalPage({
  params,
  searchParams,
}: {
  params: Promise<{ grantId: string }>;
  searchParams: Promise<{ cursor?: string; record?: string; demo?: string }>;
}) {
  const { grantId } = await params;
  const query = await searchParams;
  const practice = process.env.NODE_ENV !== "production" && Boolean(query.demo);
  const apps = practice
    ? (await import("../../app-practice.ts")).buildAppPractice(query.demo || "one").apps
    : groupGrantAccessByApp((await listAppAccess()).data);
  const app = apps.find((item) => item.grantIds.includes(decodeURIComponent(grantId)));
  if (!app) notFound();
  const selected = query.record && app.grantIds.includes(query.record) ? query.record : decodeURIComponent(grantId);
  const records = [
    {
      id: selected,
      envelope: practice
        ? { object: "timeline", event_count: 0, events: [], trace_id: null }
        : await getGrantTimeline(selected, { cursor: query.cursor }),
    },
  ];
  return (
    <RecordroomShellWithPalette>
      <Link href={`/grants/${encodeURIComponent(grantId)}`}>Apps / {app.name} / Technical details</Link>
      <PageHeader title={`Technical details for ${app.name}`} />
      <p className="text-muted-foreground">Ids, records and logs for whoever is helping you with a problem.</p>
      <ul className="mb-6 flex flex-wrap gap-3">
        {app.grantIds.map((id) => (
          <li key={id}>
            <Link
              className="text-[13px] underline"
              href={`/grants/${encodeURIComponent(grantId)}/technical?${new URLSearchParams({ record: id, ...(practice ? { demo: query.demo || "one" } : {}) })}`}
            >
              {id}
            </Link>
          </li>
        ))}
      </ul>
      {records.map(({ id, envelope }) =>
        envelope ? (
          <TimelineDetailView
            key={id}
            beforeTimelineContent={
              <div className="flex flex-wrap gap-4">
                {app.sourceAccess
                  .flatMap((source) => (source.grant_ids.includes(id) ? source.package_ids : []))
                  .map((packageId) => (
                    <Link key={packageId} href={`/grants/packages/${encodeURIComponent(packageId)}`}>
                      Parent access package → {packageId}
                    </Link>
                  ))}
                <Link href={`/event-subscriptions?grant_id=${encodeURIComponent(id)}`}>Event subscriptions →</Link>
              </div>
            }
            breadcrumbs={[{ href: "/grants", label: "Apps" }, { label: app.name }]}
            cliCommand={`pdpp ref grant timeline ${id}`}
            count={`${envelope.events.length} events`}
            envelope={envelope}
            id={id}
            loadMoreHref={
              envelope.truncated && envelope.next_cursor
                ? `/grants/${encodeURIComponent(grantId)}/technical?${new URLSearchParams({ record: id, cursor: envelope.next_cursor })}`
                : null
            }
            rawUrl={`${getAsInternalUrl()}/_ref/grants/${encodeURIComponent(id)}/timeline`}
            routes={dashboardRoutes}
            subject="grant"
          />
        ) : null
      )}
    </RecordroomShellWithPalette>
  );
}
