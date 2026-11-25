// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { PageHeader, Section } from "@pdpp/operator-ui/components/primitives";
import { formatRelative } from "@pdpp/display";
import { dashboardRoutes } from "@pdpp/operator-ui/components/views/routes";
import { TimelineDetailView } from "@pdpp/operator-ui/components/views/timeline-detail-view";
import Link from "next/link";
import { notFound } from "next/navigation";
import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx";
import { ServerUnreachable } from "../../components/server-unreachable.tsx";
import { getAsInternalUrl, ReferenceServerUnreachableError } from "../../lib/owner-token.ts";
import { getGrantTimeline, listGrants } from "../../lib/ref-client.ts";
import { RemoveThisAccess } from "../remove-access-confirmation.tsx";
import { appSourceName } from "../app-access.ts";
import { revokeGrantAccessAction } from "./revoke-action.ts";

export const dynamic = "force-dynamic";

type TimelineSearchParams = Promise<{ access_removed?: string; cursor?: string | string[]; remove_error?: string }>;

function getCursor(searchParams: { cursor?: string | string[] }): string | null {
  return typeof searchParams.cursor === "string" && searchParams.cursor.length > 0 ? searchParams.cursor : null;
}

function grantTimelineHref(grantId: string, cursor: string): string {
  return `/grants/${encodeURIComponent(grantId)}?${new URLSearchParams({ cursor }).toString()}`;
}

export default async function GrantDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ grantId: string }>;
  searchParams: TimelineSearchParams;
}) {
  const { grantId: raw } = await params;
  const grantId = decodeURIComponent(raw);
  const query = await searchParams;
  const cursor = getCursor(query);

  let envelope: Awaited<ReturnType<typeof getGrantTimeline>>;
  let grant: Awaited<ReturnType<typeof listGrants>>["data"][number] | null = null;
  try {
    const [timeline, summaries] = await Promise.all([
      getGrantTimeline(grantId, { cursor }),
      listGrants({ limit: 5, q: grantId }).catch(() => null),
    ]);
    envelope = timeline;
    grant = summaries?.data.find((item) => item.grant_id === grantId) ?? null;
  } catch (err) {
    if (err instanceof ReferenceServerUnreachableError) {
      return (
        <RecordroomShellWithPalette>
          <PageHeader title="Apps" />
          <ServerUnreachable />
        </RecordroomShellWithPalette>
      );
    }
    throw err;
  }

  if (!envelope) {
    notFound();
  }

  const revoked = envelope.events.some((e) => e.event_type === "grant.revoked" || e.status === "revoked");
  const appName = grant?.client?.client_name?.trim() || "App";
  const what = appSourceName(grant?.source) ?? "Not available";
  const canRemove = grant?.status === "active" || grant?.status === "issued";
  const relative = (value: string | null | undefined) => {
    if (!value) return "Not available";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "Not available" : formatRelative(date, Date.now());
  };

  const subscriptionsHref = `/event-subscriptions?grant_id=${encodeURIComponent(grantId)}`;
  const packageHref = grant?.grant_package_id ? `/grants/packages/${encodeURIComponent(grant.grant_package_id)}` : null;

  return (
    <RecordroomShellWithPalette>
      <div className="mb-2 text-[13px] text-muted-foreground"><Link className="min-h-11 inline-flex items-center underline-offset-2 hover:underline" href="/grants">← Apps</Link></div>
      <PageHeader title={appName} />
      {query.remove_error ? <p className="mb-3 text-[13px] text-destructive">Access could not be removed. Try again.</p> : null}
      {query.access_removed ? <p className="mb-3 text-[13px] text-muted-foreground">Access removed.</p> : null}
      <Section title="What this app can read">
        <dl className="grid grid-cols-[8rem_minmax(0,1fr)] gap-x-4 gap-y-2 text-[13px]">
          <dt className="text-muted-foreground">Data</dt><dd>{what}</dd>
          <dt className="text-muted-foreground">Since</dt><dd>{relative(grant?.first_at)}</dd>
          <dt className="text-muted-foreground">Last read</dt><dd>{relative(grant?.last_at)}</dd>
          <dt className="text-muted-foreground">How often</dt><dd>Not shown</dd>
          {grant?.status && !canRemove ? <><dt className="text-muted-foreground">Status</dt><dd>{grant.status === "revoked" ? "Removed" : grant.status === "denied" ? "Not allowed" : grant.status === "failed" ? "Failed" : "Waiting"}</dd></> : null}
        </dl>
      </Section>
      {canRemove ? (
        <Section title="Remove access">
          <RemoveThisAccess
            action={revokeGrantAccessAction}
            grantId={grantId}
            returnTo={`/grants/${encodeURIComponent(grantId)}`}
            sentence={`${appName} will no longer read ${grant?.source ? what : "this data"}. It keeps what it already read.`}
          />
        </Section>
      ) : null}
      <details className="mt-5 border-t border-border pt-2">
        <summary className="min-h-11 cursor-pointer text-[13px] text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Details</summary>
        <TimelineDetailView
          beforeTimelineContent={
            <div className="pdpp-caption mb-6 flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
              {packageHref ? <Link className="underline-offset-2 hover:underline" href={packageHref}>Parent access package →</Link> : null}
              <Link className="underline-offset-2 hover:underline" href={subscriptionsHref}>Event subscriptions →</Link>
            </div>
          }
          breadcrumbs={[{ href: "/grants", label: "Apps" }, { label: "Details" }]}
          cliCommand={`pdpp ref grant timeline ${grantId}`}
          count={`${envelope.events.length} events${revoked ? " · removed" : ""}`}
          envelope={envelope}
          id={grantId}
          loadMoreHref={envelope.truncated && envelope.next_cursor ? grantTimelineHref(grantId, envelope.next_cursor) : null}
          rawUrl={`${getAsInternalUrl()}/_ref/grants/${encodeURIComponent(grantId)}/timeline`}
          routes={dashboardRoutes}
          subject="grant"
        />
      </details>
    </RecordroomShellWithPalette>
  );
}
