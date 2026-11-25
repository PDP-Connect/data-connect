// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Operator detail surface for a single hosted-MCP grant package.
 *
 * Renders the package metadata, the full child-grant table (active and
 * revoked rows both shown so the operator can see the cascade after
 * revocation), and a server-action revoke form. Revocation is a
 * confirmed POST through `revokePackageAction`; the page itself never
 * calls `_ref/grant-packages/:id/revoke` directly. No secret material
 * is rendered.
 *
 * Spec: openspec/changes/add-grant-package-operator-visibility/
 *       specs/reference-implementation-architecture/spec.md
 */

import { IcButton, IcTimestamp } from "@pdpp/brand-react";
import { formatRelative } from "@pdpp/display";
import { formatSourceWithConnectionForDisplay } from "@pdpp/display";
import { DataList, PageHeader, Section, StatusBadge } from "@pdpp/operator-ui/components/primitives";
import { GRANT_LIFECYCLE_VOCABULARY } from "@pdpp/operator-ui/components/status-vocabularies";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx";
import { ConnectorMark } from "@/app/(console)/components/connector-mark.tsx";
import { ServerUnreachable } from "../../../components/server-unreachable.tsx";
import { ReferenceServerUnreachableError } from "../../../lib/owner-token.ts";
import {
  type CumulativeClientAccess,
  type GrantPackageChild,
  listGrants,
  getCumulativeClientAccess,
  getGrantPackage,
} from "../../../lib/ref-client.ts";
import { listConnectorManifests } from "../../../lib/rs-client.ts";
import { technicalClientCaption } from "../../client-caption.ts";
import { revokePackageAction } from "./revoke-action.ts";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "App access",
};

interface DetailParams {
  revoke_error?: string;
  revoked?: string;
}

export default async function GrantPackageDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ packageId: string }>;
  searchParams: Promise<DetailParams>;
}) {
  const { packageId: raw } = await params;
  const packageId = decodeURIComponent(raw);
  const sp = await searchParams;

  let pkg: Awaited<ReturnType<typeof getGrantPackage>>;
  const connectorManifests = await listConnectorManifests().catch(() => []);
  const connectorIcons = Object.fromEntries(
    connectorManifests.flatMap((manifest) => [
      [manifest.connector_id, manifest.icon] as const,
      ...(manifest.connector_key ? ([[manifest.connector_key, manifest.icon]] as const) : []),
    ])
  );
  try {
    pkg = await getGrantPackage(packageId);
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

  if (!pkg) {
    notFound();
  }

  const summaries = await listGrants({ client_id: pkg.client_id, limit: 50 }).catch(() => null);
  const appName = summaries?.data.find((grant) => grant.client?.client_name?.trim())?.client?.client_name?.trim() ?? "App";
  const sources = [...new Set(pkg.children.flatMap((child) => child.source ? [formatSourceWithConnectionForDisplay(child.source)] : []))];
  const childIds = new Set(pkg.children.map((child) => child.grant_id));
  const lastRead = summaries?.data.filter((grant) => childIds.has(grant.grant_id)).map((grant) => grant.last_at).sort().at(-1) ?? null;

  // Reference-experimental cumulative per-client view across the lineage this
  // package belongs to (linked by parent_package_id). Best-effort: a failure
  // here must not break the package detail page.
  let cumulative: CumulativeClientAccess | null = null;
  try {
    cumulative = await getCumulativeClientAccess(packageId);
  } catch {
    cumulative = null;
  }
  // Only render the lineage section when the package actually participates in a
  // multi-package lineage; a lone package needs no cumulative pivot.
  const hasLineage = cumulative !== null && (cumulative.package_count > 1 || pkg.parent_package_id !== null);

  // Revocability is decided by the PERSISTED status, not the displayed one.
  // `pkg.status` is a derived lifecycle that reads "expired" once the deadline
  // passes, but an expired package has not been revoked: revoking it is still
  // a meaningful, durable act that cascades to child grants, tokens and
  // members, and the revoke route accepts it (it guards on the same persisted
  // field). Gating this form on `status` silently removed the owner's control
  // the moment a grant lapsed. Falls back to `status` when an older reference
  // server does not send `persisted_status`.
  const isRevocable = (pkg.persisted_status ?? pkg.status) === "active";
  const childCount = pkg.children.length;
  const subscriptionsHref = "/event-subscriptions";
  const relative = (value: string | null) => {
    if (!value) return "Not available";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "Not available" : formatRelative(date, Date.now());
  };

  return (
    <RecordroomShellWithPalette>
      <div className="mb-2 text-[13px] text-muted-foreground">
        <Link className="min-h-11 inline-flex items-center underline-offset-2 hover:underline" href="/grants">← Apps</Link>
      </div>
      <PageHeader title={appName} />

      {sp.revoke_error ? (
        <p className="mb-4 text-[13px] text-destructive">Access could not be removed. Try again.</p>
      ) : null}

      {sp.revoked === "yes" ? (
        <p className="mb-4 text-[13px] text-muted-foreground">Access removed.</p>
      ) : null}

      <Section title="What it can read">
        <dl className="grid grid-cols-[8rem_minmax(0,1fr)] gap-x-4 gap-y-2 text-[13px]">
          <dt className="text-muted-foreground">Data</dt><dd>{sources.length ? sources.join(", ") : "Not available"}</dd>
          <dt className="text-muted-foreground">Since</dt><dd>{relative(pkg.approved_at ?? pkg.created_at)}</dd>
          <dt className="text-muted-foreground">Last read</dt><dd>{relative(lastRead)}</dd>
          <dt className="text-muted-foreground">How often</dt><dd>Not shown</dd>
        </dl>
      </Section>

      {isRevocable ? (
        <Section title="Remove access">
          <details className="rounded-md border border-border-strong p-3">
            <summary className="flex min-h-11 cursor-pointer items-center text-[13px] font-medium text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Remove access</summary>
            <p className="my-2 text-[13px] text-foreground">{appName} will no longer read your data. It keeps what it already read.</p>
            <form action={revokePackageAction}>
              <input name="package_id" type="hidden" value={pkg.package_id} />
              <input name="confirm_revoke" type="hidden" value="yes" />
              <IcButton size="sm" type="submit" variant="destructive">Remove access</IcButton>
            </form>
          </details>
        </Section>
      ) : null}

      <details className="mt-5 border-t border-border pt-2">
        <summary className="min-h-11 cursor-pointer text-[13px] text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Details</summary>

      <Section title="Identity">
        <dl className="pdpp-caption grid grid-cols-[8rem_minmax(0,1fr)] gap-x-4 gap-y-1 text-muted-foreground">
          <dt>Package id</dt>
          <dd className="break-all font-mono text-foreground">{pkg.package_id}</dd>
          <dt>Status</dt>
          <dd>
            <StatusBadge status={pkg.status} vocabulary={GRANT_LIFECYCLE_VOCABULARY} />
          </dd>
          <dt>Client</dt>
          <dd className="break-all font-mono text-foreground" title={pkg.client_id}>
            {technicalClientCaption(pkg.client_id) ?? pkg.client_id}
          </dd>
          {pkg.parent_package_id ? (
            <>
              <dt>Extends</dt>
              <dd className="break-all font-mono text-foreground">
                <Link
                  className="underline-offset-2 hover:underline"
                  href={`/grants/packages/${encodeURIComponent(pkg.parent_package_id)}`}
                >
                  {pkg.parent_package_id}
                </Link>
              </dd>
            </>
          ) : null}
          <dt title="The owner identity this package's access is granted on behalf of">Subject</dt>
          <dd className="break-all font-mono text-foreground">{pkg.subject_id}</dd>
          <dt>Created</dt>
          <dd>
            <IcTimestamp value={pkg.created_at} />
          </dd>
          {pkg.approved_at ? (
            <>
              <dt>Approved</dt>
              <dd>
                <IcTimestamp value={pkg.approved_at} />
              </dd>
            </>
          ) : null}
          {pkg.revoked_at ? (
            <>
              <dt>Revoked</dt>
              <dd>
                <IcTimestamp value={pkg.revoked_at} />
              </dd>
            </>
          ) : null}
        </dl>
      </Section>

      <Section
        description={childCount === 1 ? "1 source-bounded child grant." : `${childCount} source-bounded child grants.`}
        title="Children"
      >
        {childCount === 0 ? (
          <p className="pdpp-caption text-muted-foreground">No child grants on file.</p>
        ) : (
          <DataList>
            {pkg.children.map((child) => (
              <li key={child.grant_id}>
                <ChildRow child={child} connectorIcons={connectorIcons} />
              </li>
            ))}
          </DataList>
        )}
      </Section>

      {hasLineage && cumulative ? (
        <Section
          description={`Reference-experimental. This client holds ${cumulative.active_child_count} active child grant(s) across ${cumulative.package_count} linked package(s). Each child grant remains independently revocable; the link carries no source authority.`}
          title="Cumulative client access"
        >
          <DataList>
            {cumulative.packages.map((member) => (
              <li key={member.package_id}>
                <Link
                  className="block px-3 py-2.5 transition-colors hover:bg-muted/40"
                  href={`/grants/packages/${encodeURIComponent(member.package_id)}`}
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <code className="pdpp-caption break-all font-medium font-mono text-foreground">
                      {member.package_id}
                      {member.package_id === pkg.package_id ? " (this package)" : ""}
                      {member.package_id === cumulative.root_package_id ? " · root" : ""}
                    </code>
                    <div className="flex items-center gap-2">
                      <StatusBadge status={member.status} vocabulary={GRANT_LIFECYCLE_VOCABULARY} />
                      <span className="pdpp-caption text-muted-foreground">
                        {member.member_count === 1 ? "1 child" : `${member.member_count} children`}
                      </span>
                    </div>
                  </div>
                  {member.parent_package_id ? (
                    <div className="pdpp-caption mt-1 break-all text-muted-foreground">
                      extends {member.parent_package_id}
                    </div>
                  ) : null}
                </Link>
              </li>
            ))}
          </DataList>
        </Section>
      ) : null}

      <Section title="Related">
        <p className="pdpp-caption text-muted-foreground">
          <Link className="underline-offset-2 hover:underline" href={subscriptionsHref}>
            Event subscriptions across this deployment →
          </Link>
        </p>
      </Section>

      {isRevocable ? (
        <Section
          description="Revoking the package dispatches one revoke per active child grant and invalidates the package's MCP refresh token only after every child succeeds. If one child fails, the page reports which child did not revoke and leaves the package active."
          title="Revoke"
        >
          <form action={revokePackageAction} className="flex flex-wrap items-center gap-3">
            <input name="package_id" type="hidden" value={pkg.package_id} />
            <label className="pdpp-caption flex items-center gap-2 text-muted-foreground">
              <input name="confirm_revoke" type="checkbox" value="yes" />
              <span>
                Confirm revoke of package <code className="font-mono">{pkg.package_id}</code> and all {childCount} child
                grants.
              </span>
            </label>
            <IcButton type="submit" variant="destructive">
              Revoke package
            </IcButton>
          </form>
        </Section>
      ) : null}
      </details>
    </RecordroomShellWithPalette>
  );
}

function ChildRow({
  child,
  connectorIcons,
}: {
  child: GrantPackageChild;
  connectorIcons: Readonly<Record<string, import("@pdpp/brand-react").ConnectorIconLike | null | undefined>>;
}) {
  const grantHref = `/grants/${encodeURIComponent(child.grant_id)}`;
  const sourceLabel = describeSource(child.source);
  const memberStatus = child.member_status === child.grant_status ? null : child.member_status;
  const connectorId = child.source?.kind === "connector" ? child.source.connector_id ?? child.source.id : null;
  return (
    <Link className="block px-3 py-2.5 transition-colors hover:bg-muted/40" href={grantHref}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <code className="pdpp-caption break-all font-medium font-mono text-foreground">{child.grant_id}</code>
        <div className="flex items-center gap-2">
          <StatusBadge status={child.grant_status} vocabulary={GRANT_LIFECYCLE_VOCABULARY} />
          {memberStatus ? (
            <StatusBadge status={`member · ${memberStatus}`} vocabulary={GRANT_LIFECYCLE_VOCABULARY} />
          ) : null}
          <span className="pdpp-caption text-muted-foreground">
            <IcTimestamp value={child.added_at} />
          </span>
        </div>
      </div>
      <div className="pdpp-caption mt-1 text-muted-foreground">
        {connectorId ? (
          <ConnectorMark
            spacing="after"
            {...(child.source?.connector_id ? { connectorId: child.source.connector_id } : { sourceId: connectorId })}
            icon={connectorIcons[connectorId]}
            name={sourceLabel}
          />
        ) : null}
        {sourceLabel}
        {child.revoked_at ? (
          <>
            {" · revoked "}
            <IcTimestamp value={child.revoked_at} />
          </>
        ) : null}
      </div>
    </Link>
  );
}

function describeSource(source: GrantPackageChild["source"]): string {
  if (!source) {
    return "source —";
  }
  return `source ${formatSourceWithConnectionForDisplay(source)}`;
}
