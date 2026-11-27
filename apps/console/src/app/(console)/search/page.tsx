// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { dashboardRoutes } from "@pdpp/operator-ui/components/views/routes";
import { formatConnectorKeyForDisplay } from "@pdpp/display";
import { PageHeader, Section } from "@pdpp/operator-ui/components/primitives";
import { Button } from "@pdpp/operator-ui/ui/button";
import { Input } from "@pdpp/operator-ui/ui/input";
import Link from "next/link";
import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx";
import { ServerUnreachable } from "../components/server-unreachable.tsx";
import { ReferenceServerUnreachableError } from "../lib/owner-token.ts";
import { type GrantSummary, type RunSummary, refSearch, type TraceSummary } from "../lib/ref-client.ts";
import { verifyDashboardSession } from "../lib/verify-session.ts";

export const dynamic = "force-dynamic";

interface SearchResult {
  exact: { kind: "trace" | "grant" | "run"; id: string } | null;
  grants: GrantSummary[];
  runs: RunSummary[];
  traces: TraceSummary[];
}

function exactMatchRedirectTarget(exact: { id: string; kind: "trace" | "grant" | "run" }): string {
  const { kind, id } = exact;
  if (kind === "trace") {
    return `/audit/${encodeURIComponent(id)}`;
  }
  if (kind === "grant") {
    return `/grants/${encodeURIComponent(id)}`;
  }
  return `/syncs/${encodeURIComponent(id)}`;
}

interface LoadSearchOutput {
  result: SearchResult | null;
  unreachable: boolean;
}

async function loadSearchResult(query: string, jump: string | undefined): Promise<LoadSearchOutput> {
  try {
    const spineResult = await refSearch(query);

    // Deep-link on exact id match. jump=0 opts out so operators can inspect
    // what matched without auto-following the redirect.
    if (spineResult.exact && jump !== "0") {
      redirect(exactMatchRedirectTarget(spineResult.exact));
    }

    // Free-text submit: hand off record-content search to Explore, which is
    // the sole owner-token record search surface after
    // `narrow-search-to-spine-jump`. `jump=0` opts out and renders the
    // spine-only results.
    if (jump !== "0") {
      redirect(`${dashboardRoutes.section.explore}?q=${encodeURIComponent(query)}`);
    }

    return {
      result: {
        exact: spineResult.exact,
        grants: spineResult.grants,
        runs: spineResult.runs,
        traces: spineResult.traces,
      },
      unreachable: false,
    };
  } catch (err) {
    if (err instanceof ReferenceServerUnreachableError) {
      return { result: null, unreachable: true };
    }
    throw err;
  }
}

export default async function SearchPage({ searchParams }: { searchParams: Promise<{ q?: string; jump?: string }> }) {
  const { q: qParam, jump } = await searchParams;
  const query = (qParam ?? "").trim();

  // Empty-query loads bypass `loadSearchResult`, so they would otherwise miss
  // the DAL gate. Verify the session here so the empty-shell render redirects
  // unauthenticated callers consistently with sibling dashboard routes.
  if (!query) {
    await verifyDashboardSession();
  }

  const { result, unreachable } = query ? await loadSearchResult(query, jump) : { result: null, unreachable: false };

  if (unreachable) {
    return (
      <RecordroomShellWithPalette>
        <ServerUnreachable />
      </RecordroomShellWithPalette>
    );
  }

  const data: SearchResult | null = result
    ? {
        exact: result.exact,
        grants: result.grants,
        runs: result.runs,
        traces: result.traces,
      }
    : null;

  return (
    <RecordroomShellWithPalette>
      <SearchPageView data={data} query={query} />
    </RecordroomShellWithPalette>
  );
}

function SearchPageView({ data, query }: { data: SearchResult | null; query: string }) {
  const results = data ? data.traces.length + data.grants.length + data.runs.length + (data.exact ? 1 : 0) : 0;
  const foundSomething = Boolean(data && (data.exact || data.traces.length || data.grants.length || data.runs.length));
  let statusMessage: ReactNode = null;

  if (query && data && foundSomething) {
    statusMessage = (
      <p className="pdpp-caption mb-5 text-muted-foreground">
        Found results for <span className="text-foreground">{query}</span>.
      </p>
    );
  } else if (query && data) {
    statusMessage = (
      <p className="pdpp-caption mb-5 text-muted-foreground">
        Nothing found for <span className="text-foreground">{query}</span>.
      </p>
    );
  } else if (!query) {
    statusMessage = (
      <p className="pdpp-caption text-muted-foreground">
        Enter an ID, or{" "}
        <Link className="underline underline-offset-2 hover:text-foreground" href={dashboardRoutes.section.explore}>
          search record text in Explore
        </Link>
        .
      </p>
    );
  }

  return (
    <>
      <PageHeader
        breadcrumbs={[{ href: dashboardRoutes.section.explore, label: "Explore" }, { label: "Search" }]}
        count={query && data ? `${results.toLocaleString()} found` : undefined}
        description="Search for a sync, an app, or an activity entry by ID. Search record text in Explore."
        title="Search"
      />

      <form className="mb-6" method="get">
        <label className="mb-1 block" htmlFor="jump-q">
          <span className="pdpp-eyebrow text-muted-foreground">Search by ID</span>
        </label>
        <div className="flex min-w-0">
          <Input
            autoFocus
            className="flex-1 rounded-r-none border-r-0 focus-visible:z-10"
            defaultValue={query}
            id="jump-q"
            name="q"
            placeholder="Paste an ID…"
            type="search"
          />
          <Button className="-ml-px h-8 rounded-l-none px-3 text-sm focus-visible:z-10" size="default" type="submit" variant="outline">
            Search
          </Button>
        </div>
      </form>

      {statusMessage}

      {query && data ? (
        <div className="space-y-6">
          {data.exact ? (
            <Section title="Exact match">
              <p className="pdpp-caption text-muted-foreground">
                <Link
                  className="underline underline-offset-2 hover:text-foreground"
                  href={exactMatchRedirectTarget(data.exact)}
                >
                  Open {exactKindLabel(data.exact.kind)} {data.exact.id}
                </Link>
              </p>
            </Section>
          ) : null}
          <ResultSection
            href={dashboardRoutes.section.traces}
            items={data.traces}
            keyFor={(item) => item.trace_id}
            render={(item) => (
              <Link className="block px-2 py-2 hover:bg-muted/40" href={dashboardRoutes.trace(item.trace_id)}>
                <span className="pdpp-caption break-all font-medium">{item.trace_id}</span>
                <span className="pdpp-caption block text-muted-foreground">
                  {item.status} · {item.event_count.toLocaleString()} events · {item.kinds.slice(0, 3).join(", ")}
                </span>
              </Link>
            )}
            title="Activity"
          />
          <ResultSection
            href={dashboardRoutes.section.grants}
            items={data.grants}
            keyFor={(item) => item.grant_id}
            render={(item) => (
              <Link className="block px-2 py-2 hover:bg-muted/40" href={dashboardRoutes.grant(item.grant_id)}>
                <span className="pdpp-caption break-all font-medium">{item.grant_id}</span>
                <span className="pdpp-caption block text-muted-foreground">
                  {item.status} · app ID {item.client_id ?? "—"}
                </span>
              </Link>
            )}
            title="Apps"
          />
          <ResultSection
            href={dashboardRoutes.section.runs}
            items={data.runs}
            keyFor={(item) => item.run_id}
            render={(item) => (
              <Link className="block px-2 py-2 hover:bg-muted/40" href={dashboardRoutes.run(item.run_id)}>
                <span className="pdpp-caption break-all font-medium">{item.run_id}</span>
                <span className="pdpp-caption block text-muted-foreground">
                  {item.status} · {item.connector_id ? formatConnectorKeyForDisplay(item.connector_id) : "—"}
                </span>
              </Link>
            )}
            title="Sync history"
          />
        </div>
      ) : null}
    </>
  );
}

function exactKindLabel(kind: "trace" | "grant" | "run"): string {
  if (kind === "trace") {
    return "activity entry";
  }
  return kind === "grant" ? "app access" : "sync";
}

function ResultSection<T>({
  href,
  items,
  keyFor,
  render,
  title,
}: {
  href: string;
  items: T[];
  keyFor: (item: T) => string;
  render: (item: T) => ReactNode;
  title: string;
}) {
  if (items.length === 0) {
    return null;
  }
  return (
    <Section title={title}>
      <ul className="divide-y divide-border/70 border-border/70 border-y">
        {items.map((item) => (
          <li key={keyFor(item)}>{render(item)}</li>
        ))}
      </ul>
      <p className="mt-2 text-right text-sm">
        <Link className="underline underline-offset-2 hover:text-foreground" href={href}>
          See all {title.toLowerCase()}
        </Link>
      </p>
    </Section>
  );
}
