// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { dashboardRoutes } from "@pdpp/operator-ui/components/views/routes";
import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx";
import { loadConnectorSummaryPage } from "./components/connector-summary-page.tsx";
import { parseConnectorSummaryPageState } from "./components/connector-summary-pager.ts";
import { StandingOverview } from "./components/views/standing-overview.tsx";
import {
  buildHomeViewModel,
  HOME_GRANT_LIMIT,
  type HomeHrefs,
  type HomeInputs,
  type HomeReads,
} from "./components/views/standing-view-model.ts";
import { rethrowControlFlow } from "./lib/control-flow.ts";
import { liveDashboardDataSource } from "./lib/data-source.ts";
import { getReferencePublicOrigin } from "./lib/owner-token.ts";
import {
  type DatasetSummary,
  type GrantSummary,
  type ListResponse,
  listOwnerIssuedClients,
  type OwnerIssuedClient,
  type PendingApproval,
  type RefConnectorSummary,
  type TraceSummary,
} from "./lib/ref-client.ts";

export const dynamic = "force-dynamic";

const HREFS: HomeHrefs = {
  addSource: "/sources/add",
  connect: "/connect",
  deployment: dashboardRoutes.section.deployment,
  deploymentTokens: dashboardRoutes.section.deploymentTokens,
  grant: (id) => dashboardRoutes.grant(id),
  grants: dashboardRoutes.section.grants,
  packages: `${dashboardRoutes.section.grants}/packages`,
  source: (id) => dashboardRoutes.connector(id),
  sources: dashboardRoutes.section.records,
};

interface SafeRead<T> {
  issue: string | null;
  value: T;
}

/** Run a read, re-throwing control flow and retaining a safe fallback on data errors. */
async function safeRead<T>(issue: string, fn: () => Promise<T>, fallback: T): Promise<SafeRead<T>> {
  try {
    return { issue: null, value: await fn() };
  } catch (err) {
    rethrowControlFlow(err);
    return { issue, value: fallback };
  }
}

function reloadHref(params: Record<string, string | string[] | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, raw] of Object.entries(params)) {
    const values = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
    for (const value of values) search.append(key, value);
  }
  const query = search.toString();
  return query ? `/?${query}` : "/";
}

function listFallback<T>(): ListResponse<T> {
  return { data: [], has_more: false, object: "list" };
}

async function loadHomeInputs(params: Record<string, string | string[] | undefined>): Promise<HomeInputs> {
  const ds = liveDashboardDataSource;
  const pageState = parseConnectorSummaryPageState(params);
  const [summary, grants, traces, approvals, ownerClients, sourcePage] = await Promise.all([
    safeRead<DatasetSummary | null>("dataset_summary", () => ds.getDatasetSummary(), null),
    safeRead("grants", () => ds.listGrants({ limit: HOME_GRANT_LIMIT }), listFallback<GrantSummary>()),
    safeRead("traces", () => ds.listTraces({ limit: 6 }), listFallback<TraceSummary>()),
    safeRead("approvals", () => ds.listPendingApprovals(), listFallback<PendingApproval>()),
    safeRead("owner_clients", () => listOwnerIssuedClients(), listFallback<OwnerIssuedClient>()),
    safeRead(
      "source_page",
      () =>
        loadConnectorSummaryPage(pageState, (opts) =>
          ds.listConnectorSummaries({ ...opts, includeFleetHealth: false }),
        ),
      { kind: "error" as const, message: "Could not load this page." },
    ),
  ]);

  const sourceResult = sourcePage.value;
  const sourceRead: HomeReads["sourcePage"] =
    sourcePage.issue !== null || sourceResult.kind === "error"
      ? {
          error: sourceResult.kind === "error" ? sourceResult.message : undefined,
          hasMore: false,
          kind: "error",
          sources: [],
        }
      : {
          // A page reached through an old Home cursor is still only part of the inventory.
          hasMore: sourceResult.hasMore || Boolean(pageState.cursor),
          kind: "ok",
          sources: [...sourceResult.items] as RefConnectorSummary[],
        };

  const reads: HomeReads = {
    approvals: approvals.value.data,
    approvalsFailed: approvals.issue !== null,
    approvalsHaveMore: approvals.value.has_more,
    grants: grants.value.data,
    grantsFailed: grants.issue !== null,
    grantsHaveMore: grants.value.has_more,
    ownerClients: ownerClients.value.data,
    ownerClientsFailed: ownerClients.issue !== null,
    ownerClientsHaveMore: ownerClients.value.has_more,
    sourcePage: sourceRead,
    summary: summary.value,
    summaryFailed: summary.issue !== null,
    traces: traces.value.data,
    tracesFailed: traces.issue !== null,
    tracesHaveMore: traces.value.has_more,
  };

  return {
    ...reads,
    hrefs: HREFS,
    now: new Date(),
    reloadHref: reloadHref(params),
  };
}

function stripScheme(url: string): string {
  return url.replace(/^https?:\/\//, "");
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const demoValue = typeof params.demo === "string" ? params.demo : undefined;
  const demoAllowed = process.env.NODE_ENV !== "production";
  let inputs: HomeInputs;
  let notice: string | undefined;

  if (demoAllowed && demoValue) {
    const { buildDemoInputs, isDemoScenario } = await import("./components/views/standing-demo-data.ts");
    const scenario = isDemoScenario(demoValue) ? demoValue : "calm";
    inputs = buildDemoInputs(scenario, HREFS);
    notice = `Seeded demo · ${scenario} state · fictional data`;
  } else {
    inputs = await loadHomeInputs(params);
  }

  const data = buildHomeViewModel(inputs);
  const host = stripScheme(
    await (async () => {
      try {
        return await getReferencePublicOrigin();
      } catch (err) {
        rethrowControlFlow(err);
        return "this server";
      }
    })(),
  );

  return (
    <RecordroomShellWithPalette host={host}>
      <StandingOverview data={data} notice={notice} />
    </RecordroomShellWithPalette>
  );
}
