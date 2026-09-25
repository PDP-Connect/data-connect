// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { IcButton } from "@pdpp/brand-react";
import { PageHeader, Section } from "@pdpp/operator-ui/components/primitives";
import { dashboardRoutes } from "@pdpp/operator-ui/components/views/routes";
import { TimelineDetailView } from "@pdpp/operator-ui/components/views/timeline-detail-view";
import Link from "next/link";
import { notFound } from "next/navigation";
import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx";
import { ServerUnreachable } from "../../components/server-unreachable.tsx";
import { getAsInternalUrl, ReferenceServerUnreachableError } from "../../lib/owner-token.ts";
import { getGrantTimeline, lookupGrantPackageIdForGrant } from "../../lib/ref-client.ts";
import { revokeGrantAction } from "./revoke-action.ts";

export const dynamic = "force-dynamic";

type TimelineSearchParams = Promise<{ cursor?: string | string[]; revoke_error?: string; revoked?: string }>;

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
  const sp = await searchParams;
  const cursor = getCursor(sp);

  let envelope: Awaited<ReturnType<typeof getGrantTimeline>>;
  let packageId: string | null = null;
  try {
    [envelope, packageId] = await Promise.all([
      getGrantTimeline(grantId, { cursor }),
      lookupGrantPackageIdForGrant(grantId),
    ]);
  } catch (err) {
    if (err instanceof ReferenceServerUnreachableError) {
      return (
        <RecordroomShellWithPalette>
          <PageHeader title="Grant" />
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

  const subscriptionsHref = `/event-subscriptions?grant_id=${encodeURIComponent(grantId)}`;
  const packageHref = packageId ? `/grants/packages/${encodeURIComponent(packageId)}` : null;

  return (
    <RecordroomShellWithPalette>
      <TimelineDetailView
        beforeTimelineContent={
          <>
            {sp.revoke_error ? (
              <div className="pdpp-caption mb-6 rounded-md border border-destructive/30 border-l-4 border-l-destructive/60 bg-destructive/5 px-4 py-2.5">
                <span className="font-medium text-destructive">Revoke error:</span> <span>{sp.revoke_error}</span>
              </div>
            ) : null}

            {sp.revoked === "yes" ? (
              <div className="pdpp-caption mb-6 rounded-md border border-emerald-500/30 border-l-4 border-l-emerald-500/60 bg-emerald-500/5 px-4 py-2.5">
                <span className="font-medium text-emerald-700 dark:text-emerald-400">Grant revoked.</span>{" "}
                <span>The client's tokens for this grant no longer read data.</span>
              </div>
            ) : null}

            <div className="pdpp-caption mb-6 flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
              {packageHref ? (
                <Link className="underline-offset-2 hover:underline" href={packageHref}>
                  Parent grant package {packageId} →
                </Link>
              ) : null}
              <Link className="underline-offset-2 hover:underline" href={subscriptionsHref}>
                Event subscriptions for this grant →
              </Link>
            </div>

            {revoked ? null : (
              <Section description="Revoking ends this client's access to the granted data." title="Revoke">
                <form action={revokeGrantAction} className="flex flex-wrap items-center gap-3">
                  <input name="grant_id" type="hidden" value={grantId} />
                  <label className="pdpp-caption flex items-center gap-2 text-muted-foreground">
                    <input name="confirm_revoke" type="checkbox" value="yes" />
                    <span>
                      Confirm revoke of grant <code className="font-mono">{grantId}</code>.
                    </span>
                  </label>
                  <IcButton type="submit" variant="destructive">
                    Revoke grant
                  </IcButton>
                </form>
              </Section>
            )}
          </>
        }
        breadcrumbs={[{ href: "/grants", label: "Grants" }, { label: "Grant" }]}
        cliCommand={`pdpp ref grant timeline ${grantId}`}
        count={`${envelope.events.length} events${revoked ? " · revoked" : ""}`}
        envelope={envelope}
        id={grantId}
        loadMoreHref={
          envelope.truncated && envelope.next_cursor ? grantTimelineHref(grantId, envelope.next_cursor) : null
        }
        rawUrl={`${getAsInternalUrl()}/_ref/grants/${encodeURIComponent(grantId)}/timeline`}
        routes={dashboardRoutes}
        subject="grant"
      />
    </RecordroomShellWithPalette>
  );
}
