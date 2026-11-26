// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { IcButton, IcSelect, IcTimestamp } from "@pdpp/brand-react";
import { grantRowLabel } from "@pdpp/display";
import { PeekEmpty, PeekPane, PeekTimeline, pivotsFromEnvelope } from "@pdpp/operator-ui/components/peek";
import { DataList, PageHeader, StatusBadge } from "@pdpp/operator-ui/components/primitives";
import { GRANT_LIFECYCLE_VOCABULARY } from "@pdpp/operator-ui/components/status-vocabularies";
import { dashboardRoutes } from "@pdpp/operator-ui/components/views/routes";
import Link from "next/link";
import { ConnectorMark } from "@/app/(console)/components/connector-mark.tsx";
import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx";
import { DeveloperModeRequestLink } from ".././developer-mode-gate.tsx";
import { ServerUnreachable } from "../../components/shell.tsx";
import { ReferenceServerUnreachableError } from "../../lib/owner-token.ts";
import {
  type GrantSummary,
  getGrantTimeline,
  type ListResponse,
  listGrants,
} from "../../lib/ref-client.ts";
import { listConnectorManifests } from "../../lib/rs-client.ts";
import { clientCaption } from ".././client-caption.ts";

import { appSourceName } from "../app-access.ts";

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
  return qs ? `/grants/technical?${qs}` : "/grants/technical";
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
  const connectorManifests = demoMode ? [] : await listConnectorManifests().catch(() => []);
  const connectorIcons = Object.fromEntries(
    connectorManifests.flatMap((manifest) => [
      [manifest.connector_id, manifest.icon] as const,
      ...(manifest.connector_key ? ([[manifest.connector_key, manifest.icon]] as const) : []),
    ])
  );
  let peekEnvelope: Awaited<ReturnType<typeof getGrantTimeline>> = null;
  if (demoMode) {
    const demo = await import("../grants-demo-data.ts");
    const demoData = params.demo === "empty" ? demo.buildEmptyGrantsDemoData() : demo.buildGrantsDemoData();
    result = demoData.grants;
  } else {
    try {
      result = await listGrants(filters);
      if (params.peek) {
        peekEnvelope = await getGrantTimeline(params.peek);
      }
    } catch (err) {
      if (err instanceof ReferenceServerUnreachableError) {
        return (
          <RecordroomShellWithPalette>
            <PageHeader title="Technical details for apps" />
      <p className="text-muted-foreground">Ids, records and logs for whoever is helping you with a problem.</p>
            <ServerUnreachable />
          </RecordroomShellWithPalette>
        );
      }
      throw err;
    }
  }

  return (
    <RecordroomShellWithPalette>
      <PageHeader title="Technical details for apps" />
      <p className="text-muted-foreground">Ids, records and logs for whoever is helping you with a problem.</p>
      <div className="mt-5 border-t border-border pt-3">
        
        <div className="flex flex-wrap items-center gap-4 border-b border-border py-2">
          <Link className="text-[13px] text-primary underline-offset-2 hover:underline" href="/grants/packages">Packages</Link>
          <DeveloperModeRequestLink />
        </div>
        <form action="/grants/technical" className="flex flex-wrap items-end gap-2 border-b border-border py-3" method="get">
          {params.demo ? <input name="demo" type="hidden" value={params.demo} /> : null}
          {params.cursor ? <input name="cursor" type="hidden" value={params.cursor} /> : null}
          {params.client_id ? <input name="client_id" type="hidden" value={params.client_id} /> : null}
          {params.source_kind ? <input name="source_kind" type="hidden" value={params.source_kind} /> : null}
          {params.source_id ? <input name="source_id" type="hidden" value={params.source_id} /> : null}
          <label className="grid min-w-36 gap-1 text-[13px] text-muted-foreground">
            Search access
            <input className="h-10 rounded-[6px] border border-border bg-background px-3 text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" defaultValue={params.q ?? ""} name="q" placeholder="ID contains…" type="search" />
          </label>
          <label className="grid min-w-32 gap-1 text-[13px] text-muted-foreground" htmlFor="access-filter-state">
            State
            <IcSelect defaultValue={params.status ?? ""} id="access-filter-state" name="status" options={[{ label: "Active", value: "issued" }, { label: "Removed", value: "revoked" }, { label: "Not allowed", value: "denied" }, { label: "Failed", value: "failed" }, { label: "Waiting", value: "pending" }]} placeholder="Any state" />
          </label>
          <IcButton size="sm" type="submit" variant="ghost">Filter</IcButton>
          {params.q || params.status || params.client_id || params.source_kind || params.source_id ? <Link className="inline-flex min-h-11 items-center rounded-[6px] border border-border px-3 py-2 text-[13px] text-muted-foreground" href="/grants/technical">Clear filters</Link> : null}
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
              return <li key={id}><GrantRow connectorIcons={connectorIcons} detailHref={`/grants/${encodeURIComponent(id)}/technical`} grant={grant} href={listHref(params, { peek: id })} peeked={params.peek === id} /></li>;
            })}
          </DataList>
          {params.peek && peekEnvelope ? (
            <PeekPane closeHref={listHref(params, { peek: undefined })} cliCommand={`pdpp ref grant timeline ${params.peek}`} openHref={`/grants/${encodeURIComponent(params.peek)}/technical`} title={`Access ${params.peek}`}>
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
            <PeekPane closeHref={listHref(params, { peek: undefined })} openHref={`/grants/${encodeURIComponent(params.peek)}/technical`} title={`Access ${params.peek}`}>
              <p className="text-muted-foreground">Access not found.</p>
            </PeekPane>
          ) : <PeekEmpty />}
        </div>
        {result.has_more && result.next_cursor ? (
          <div className="py-4 text-right">
            <Link className="inline-flex min-h-11 items-center rounded-[6px] border border-border px-3 text-[13px] text-primary hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" href={listHref(params, { cursor: result.next_cursor, peek: undefined })}>Next →</Link>
          </div>
        ) : null}
      </div>
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
            <span>data source {appSourceName(grant.source)}</span>
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
