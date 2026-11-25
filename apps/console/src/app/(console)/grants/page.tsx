// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { IcButton, IcSelect, IcTimestamp } from "@pdpp/brand-react";
import { formatSourceForDisplay, grantRowLabel } from "@pdpp/display";
import { PeekEmpty, PeekPane, PeekTimeline, pivotsFromEnvelope } from "@pdpp/operator-ui/components/peek";
import { DataList, PageHeader, Section, StatusBadge } from "@pdpp/operator-ui/components/primitives";
import { GRANT_LIFECYCLE_VOCABULARY } from "@pdpp/operator-ui/components/status-vocabularies";
import { dashboardRoutes } from "@pdpp/operator-ui/components/views/routes";
import Link from "next/link";
import { ConnectorMark } from "@/app/(console)/components/connector-mark.tsx";
import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx";
import { AppAccessList } from "./app-access-list.tsx";
import { groupGrantAccessByApp } from "./app-access.ts";
import { DeveloperModeRequestLink } from "./developer-mode-gate.tsx";
import { revokeGrantAccessAction } from "./[grantId]/revoke-action.ts";
import { ServerUnreachable } from "../components/shell.tsx";
import { getOwnerLoginPath, ReferenceServerUnreachableError } from "../lib/owner-token.ts";
import {
  type GrantSummary,
  getGrantTimeline,
  type ListResponse,
  listGrants,
  listPendingApprovals,
  type PendingApproval,
} from "../lib/ref-client.ts";
import { listConnectorManifests } from "../lib/rs-client.ts";
import { clientCaption } from "./client-caption.ts";
import { denyPendingApprovalAction } from "./pending-actions.ts";
import { PendingApprovalRow } from "./pending-approval-row.tsx";

export const dynamic = "force-dynamic";

interface Params {
  approval_error?: string;
  client_id?: string;
  cursor?: string;
  demo?: string;
  peek?: string;
  q?: string;
  source_id?: string;
  source_kind?: "connector" | "provider_native";
  status?: string;
}

function listHref(params: Params, overrides: Partial<Params> = {}): string {
  const merged = { ...params, ...overrides };
  const qs = Object.entries(merged)
    .flatMap(([k, v]) =>
      v === undefined || v === "" ? [] : [`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`]
    )
    .join("&");
  return qs ? `/grants?${qs}` : "/grants";
}

export default async function GrantsPage({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams;
  const filters = {
    client_id: params.client_id,
    cursor: params.cursor,
    limit: 50,
    q: params.q,
    source_id: params.source_id,
    source_kind: params.source_kind,
    status: params.status,
  };

  const demoMode = process.env.NODE_ENV !== "production" && (params.demo === "atlas" || params.demo === "empty");
  let result: ListResponse<GrantSummary>;
  let approvals: ListResponse<PendingApproval>;
  const connectorManifests = demoMode ? [] : await listConnectorManifests().catch(() => []);
  const connectorIcons = Object.fromEntries(
    connectorManifests.flatMap((manifest) => [
      [manifest.connector_id, manifest.icon] as const,
      ...(manifest.connector_key ? ([[manifest.connector_key, manifest.icon]] as const) : []),
    ])
  );
  let peekEnvelope: Awaited<ReturnType<typeof getGrantTimeline>> = null;
  if (demoMode) {
    const demo = await import("./grants-demo-data.ts");
    const demoData = params.demo === "empty" ? demo.buildEmptyGrantsDemoData() : demo.buildGrantsDemoData();
    result = demoData.grants;
    ({ approvals } = demoData);
  } else {
    try {
      [result, approvals] = await Promise.all([listGrants(filters), listPendingApprovals()]);
      if (params.peek) {
        peekEnvelope = await getGrantTimeline(params.peek);
      }
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
  }

  const ownerLoginUrl = getOwnerLoginPath();
  const filterApps = [...new Map(result.data.flatMap((grant) => grant.client_id ? [[grant.client_id, grant.client?.client_name?.trim() || "App"] as const] : [])).entries()];
  const filterSources = [...new Map(result.data.flatMap((grant) => grant.source ? [[grant.source.id, formatSourceForDisplay(grant.source)] as const] : [])).entries()];

  return (
    <RecordroomShellWithPalette>
      <PageHeader title="Apps" />
      {params.approval_error ? <p className="mb-4 text-[13px] text-destructive">The request could not be updated. Try again.</p> : null}
      {approvals.data.length > 0 ? (
        <Section description="Approval requests waiting for you." id="pending-approvals" title={`Waiting for you (${approvals.data.length})`}>
          <DataList>
            {approvals.data.map((approval) => (
              <li key={approval.approval_id}>
                <PendingApprovalRow approval={approval} connectorIcons={connectorIcons} denyAction={denyPendingApprovalAction} />
              </li>
            ))}
          </DataList>
          <p className="mt-2 text-[13px] text-muted-foreground">
            If you need to sign in before reviewing, <a className="underline-offset-2 hover:underline" href={ownerLoginUrl}>open owner access</a>.
          </p>
        </Section>
      ) : null}

      <Section title="Apps that can read your data">
        <form action="/grants" className="mb-2 flex flex-wrap items-end gap-2" method="get">
          {params.q ? <input name="q" type="hidden" value={params.q} /> : null}
          {params.status ? <input name="status" type="hidden" value={params.status} /> : null}
          {params.demo ? <input name="demo" type="hidden" value={params.demo} /> : null}
          <label className="grid min-w-36 gap-1 text-[13px] text-muted-foreground">
            App
            <IcSelect defaultValue={params.client_id ?? ""} name="client_id" options={[{ label: "All apps", value: "" }, ...filterApps.map(([value, label]) => ({ label, value }))]} />
          </label>
          <label className="grid min-w-32 gap-1 text-[13px] text-muted-foreground">
            Kind
            <IcSelect defaultValue={params.source_kind ?? ""} name="source_kind" options={[{ label: "All kinds", value: "" }, { label: "Data source", value: "connector" }, { label: "Built-in source", value: "provider_native" }]} />
          </label>
          <label className="grid min-w-36 gap-1 text-[13px] text-muted-foreground">
            Data source
            <IcSelect defaultValue={params.source_id ?? ""} name="source_id" options={[{ label: "All data sources", value: "" }, ...filterSources.map(([value, label]) => ({ label, value }))]} />
          </label>
          <IcButton size="sm" type="submit" variant="ghost">Filter</IcButton>
          {params.client_id || params.source_kind || params.source_id ? <Link className="min-h-11 rounded-[6px] border border-border px-3 py-2 text-[13px] text-muted-foreground" href="/grants">Clear filters</Link> : null}
        </form>
        <AppAccessList
          apps={groupGrantAccessByApp(result.data)}
          canRemove={!result.has_more}
          removeAction={revokeGrantAccessAction}
          returnTo="/grants"
        />
        {result.has_more && result.next_cursor ? <p className="mt-3 text-[13px] text-muted-foreground">More apps are available in Details.</p> : null}
      </Section>

      <details className="mt-5 border-t border-border pt-3">
        <summary className="min-h-11 cursor-pointer text-[13px] font-medium text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Details</summary>
        <div className="flex flex-wrap items-center gap-4 border-b border-border py-2">
          <Link className="text-[13px] text-primary underline-offset-2 hover:underline" href="/grants/packages">Packages</Link>
          <DeveloperModeRequestLink />
        </div>
        <form action="/grants" className="flex flex-wrap items-end gap-2 border-b border-border py-3" method="get">
          {params.demo ? <input name="demo" type="hidden" value={params.demo} /> : null}
          {params.cursor ? <input name="cursor" type="hidden" value={params.cursor} /> : null}
          <label className="grid min-w-36 gap-1 text-[13px] text-muted-foreground">
            Search access
            <input className="h-10 rounded-[6px] border border-border bg-background px-3 text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" defaultValue={params.q ?? ""} name="q" placeholder="ID contains…" type="search" />
          </label>
          <label className="grid min-w-32 gap-1 text-[13px] text-muted-foreground">
            State
            <IcSelect defaultValue={params.status ?? ""} name="status" options={[{ label: "Any state", value: "" }, { label: "Active", value: "issued" }, { label: "Removed", value: "revoked" }, { label: "Not allowed", value: "denied" }, { label: "Failed", value: "failed" }, { label: "Waiting", value: "pending" }]} />
          </label>
          <label className="grid min-w-36 gap-1 text-[13px] text-muted-foreground">
            App
            <IcSelect defaultValue={params.client_id ?? ""} name="client_id" options={[{ label: "All apps", value: "" }, ...filterApps.map(([value, label]) => ({ label, value }))]} />
          </label>
          <label className="grid min-w-32 gap-1 text-[13px] text-muted-foreground">
            Data source kind
            <IcSelect defaultValue={params.source_kind ?? ""} name="source_kind" options={[{ label: "All kinds", value: "" }, { label: "Data source", value: "connector" }, { label: "Built-in data source", value: "provider_native" }]} />
          </label>
          <label className="grid min-w-36 gap-1 text-[13px] text-muted-foreground">
            Data source
            <IcSelect defaultValue={params.source_id ?? ""} name="source_id" options={[{ label: "All data sources", value: "" }, ...filterSources.map(([value, label]) => ({ label, value }))]} />
          </label>
          <IcButton size="sm" type="submit" variant="ghost">Filter</IcButton>
          {params.q || params.status || params.client_id || params.source_kind || params.source_id ? <Link className="inline-flex min-h-11 items-center rounded-[6px] border border-border px-3 py-2 text-[13px] text-muted-foreground" href="/grants">Clear filters</Link> : null}
        </form>
        {params.q || params.status || params.client_id || params.source_kind || params.source_id ? (
          <p className="border-b border-border py-2 text-[13px] text-muted-foreground">
            Filtered results{params.status ? ` · state ${params.status}` : ""}{params.q ? ` · search ${params.q}` : ""}{params.client_id ? " · app selected" : ""}{params.source_kind ? " · data source kind selected" : ""}{params.source_id ? " · data source selected" : ""}
          </p>
        ) : null}
        <p className="py-2 text-[13px] text-muted-foreground">{result.data.length} {result.has_more ? "on this page" : "shown"}</p>
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_24rem]">
          <DataList>
            {result.data.length === 0 ? (
              <li className="px-3 py-4 text-[13px] text-muted-foreground">No access records yet.</li>
            ) : result.data.map((grant) => {
              const id = grant.grant_id;
              return <li key={id}><GrantRow connectorIcons={connectorIcons} detailHref={dashboardRoutes.grant(id)} grant={grant} href={listHref(params, { peek: id })} peeked={params.peek === id} /></li>;
            })}
          </DataList>
          {params.peek && peekEnvelope ? (
            <PeekPane closeHref={listHref(params, { peek: undefined })} cliCommand={`pdpp ref grant timeline ${params.peek}`} openHref={dashboardRoutes.grant(params.peek)} title={`Access ${params.peek}`}>
              <div className="mb-3 flex flex-wrap gap-2">
                {pivotsFromEnvelope(peekEnvelope).filter((pivot) => pivot.kind !== "grant").map((pivot) => (
                  <Link className="underline-offset-2 hover:underline" href={pivot.kind === "trace" ? dashboardRoutes.trace(pivot.id) : dashboardRoutes.run(pivot.id)} key={`${pivot.kind}:${pivot.id}`}>
                    {pivot.kind} {pivot.id} →
                  </Link>
                ))}
              </div>
              <p className="mb-2 text-muted-foreground">{peekEnvelope.events.length} events</p>
              <PeekTimeline events={peekEnvelope.events} />
            </PeekPane>
          ) : params.peek ? (
            <PeekPane closeHref={listHref(params, { peek: undefined })} openHref={dashboardRoutes.grant(params.peek)} title={`Access ${params.peek}`}>
              <p className="text-muted-foreground">Access not found.</p>
            </PeekPane>
          ) : <PeekEmpty />}
        </div>
        {result.has_more && result.next_cursor ? (
          <div className="py-4 text-right">
            <Link className="inline-flex min-h-11 items-center rounded-[6px] border border-border px-3 text-[13px] text-primary hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" href={listHref(params, { cursor: result.next_cursor, peek: undefined })}>Next →</Link>
          </div>
        ) : null}
      </details>
    </RecordroomShellWithPalette>
  );
}

function GrantRow({
  connectorIcons,
  grant,
  href,
  detailHref,
  peeked,
}: {
  connectorIcons: Readonly<Record<string, import("@pdpp/brand-react").ConnectorIconLike | null | undefined>>;
  grant: GrantSummary;
  href: string;
  detailHref: string;
  peeked: boolean;
}) {
  const packageHref = grant.grant_package_id ? `/grants/packages/${encodeURIComponent(grant.grant_package_id)}` : null;
  const clientCaptionText = clientCaption(grant);
  const connectorId = grant.connector_id ?? (grant.source?.kind === "connector" ? grant.source.id : null);

  // Shared row content rendered inside both the mobile and desktop links.
  const rowContent = (
    <>
      {/* Lead with the source/client + decision; the raw grant id is demoted
          to a monospace lookup key on the detail line. */}
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {connectorId ? (
            <ConnectorMark {...(grant.connector_id ? { connectorId: grant.connector_id } : { sourceId: grant.source?.id ?? "" })} icon={connectorIcons[connectorId]} name={grantRowLabel(grant)} />
          ) : null}
          <span className="truncate font-medium text-foreground">{grantRowLabel(grant)}</span>
          <StatusBadge status={grant.status} vocabulary={GRANT_LIFECYCLE_VOCABULARY} />
          {clientCaptionText ? (
            <span
              className="pdpp-caption max-w-[20ch] truncate text-muted-foreground"
              title={grant.client_id ?? undefined}
            >
              {clientCaptionText}
            </span>
          ) : null}
        </div>
        <span className="pdpp-caption shrink-0 text-muted-foreground tabular-nums">
          <IcTimestamp value={grant.last_at} />
        </span>
      </div>
      <div className="pdpp-caption mt-0.5 flex flex-wrap items-center gap-x-2 text-muted-foreground">
        <code className="max-w-[32ch] truncate font-mono" title={grant.grant_id}>
          {grant.grant_id}
        </code>
        <span className="text-muted-foreground/50">·</span>
        <span className="tabular-nums">{grant.event_count} events</span>
        {grant.source ? (
          <>
            <span className="text-muted-foreground/50">·</span>
            <span>source {formatSourceForDisplay(grant.source)}</span>
          </>
        ) : null}
      </div>
    </>
  );

  return (
    <div
      aria-current={peeked ? "true" : undefined}
      className={`block px-3 py-2.5 transition-colors ${peeked ? "bg-muted" : "hover:bg-muted/40"}`}
    >
      {/* Mobile (below xl): navigate to full-page detail route. */}
      <Link className="block xl:hidden" href={detailHref}>
        {rowContent}
      </Link>
      {/* Desktop (xl+): open the side-panel peek via ?peek= param. */}
      <Link className="hidden xl:block" href={href} scroll={false}>
        {rowContent}
      </Link>
      {packageHref ? (
        <div className="pdpp-caption mt-1">
          <Link
            className="rounded border border-border px-2 py-0.5 text-muted-foreground hover:bg-muted/60"
            href={packageHref}
          >
            package {grant.grant_package_id} →
          </Link>
        </div>
      ) : null}
    </div>
  );
}
