// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Syncs — the Recordroom reskin of the Runs route.
 *
 * Health-first: this surface answers "what was recently collected, and what (in
 * needs my attention?" It fuses three real reference contracts:
 *   - `_ref/runs`       → the runs feed, for per-connection Rhythm + last result
 *   - `_ref/connectors` → per-connection health + schedule + stream list
 * via the pure {@link buildSyncsViewModel}, then renders the {@link SyncsView}
 * (Ink Carbon kit) inside the {@link RecordroomShell}.
 *
 * The route, its `?peek=` deep-link redirect, and the `listRuns` fetch are
 * preserved (a held invariant: the peek redirect must run before any fetch and
 * the page must never pull an inline run timeline).
 *
 * Recent syncs is a real cursor-paginated view over the runs feed (`run_cursor`),
 * with two honest server-side filters — `status` and `connector_id`. `_ref/runs`
 * applies both (see `listRuns`'s `ListQuery`), so every returned row genuinely
 * matches, and the two compose. The source options are projected from the
 * connector-summary page this route already fetches, so the picker can only ever
 * offer connectors the owner really has and the console never holds a connector
 * roster of its own. There is no sort param on `_ref/runs`, so the list is never
 * presented as sortable — it stays newest-first, the one order the feed actually
 * guarantees.
 */

import { dashboardRoutes } from "@pdpp/operator-ui/components/views/routes";
import { PageHeader } from "@pdpp/operator-ui/components/primitives";
import Link from "next/link";
import { redirect } from "next/navigation";
import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx";
import {
  ConnectorSummaryPageError,
  ConnectorSummaryPager,
  loadConnectorSummaryPage,
} from "../components/connector-summary-page.tsx";
import { isPagedRequest, parseConnectorSummaryPageState } from "../components/connector-summary-pager.ts";
import { LivePoller } from "../components/live-poller.tsx";
import { ServerUnreachable } from "../components/server-unreachable.tsx";
import { buildConnectorIconMap } from "../lib/connector-icon-map.ts";
import { ReferenceServerUnreachableError } from "../lib/owner-token.ts";
import { type ListResponse, listConnectorSummaries, listRuns, type RunSummary } from "../lib/ref-client.ts";
import { listConnectorManifests } from "../lib/rs-client.ts";
import { DEMO_SYNCS_MODEL } from "./syncs-demo.ts";
import { buildSyncsViewModel } from "./syncs-model.ts";
import { loadSourceFilterOptions } from "./source-filter-options.ts";
import { SyncsView } from "./syncs-view.tsx";

const SYNCS_PATH = "/syncs";

export const dynamic = "force-dynamic";
const SYNCS_OVERVIEW_RUN_LIMIT = 25;

interface Params {
  connector_id?: string;
  demo?: string;
  page_cursor?: string;
  peek?: string;
  run_cursor?: string;
  status?: string;
  [key: string]: string | undefined;
}

function fetchSyncsConnectorsPage(pageState: ReturnType<typeof parseConnectorSummaryPageState>) {
  return loadConnectorSummaryPage(pageState, (opts) => listConnectorSummaries(opts));
}

/** Real, honest run-status filter options — every value `_ref/runs` actually recognises. */
const RUN_STATUS_FILTER_OPTIONS = [
  { label: "Any result", value: "" },
  { label: "Succeeded", value: "succeeded" },
  { label: "Succeeded with gaps", value: "succeeded_with_gaps" },
  { label: "Failed", value: "failed" },
  { label: "Cancelled", value: "cancelled" },
  { label: "In progress", value: "in_progress" },
] as const;

function runListQuery(params: Params) {
  return {
    connector_id: params.connector_id || undefined,
    cursor: params.run_cursor || undefined,
    limit: SYNCS_OVERVIEW_RUN_LIMIT,
    status: params.status || undefined,
  };
}

function isLiveRun(run: RunSummary): boolean {
  return !["cancelled", "completed", "deferred", "failed", "rejected", "succeeded"].includes(run.status);
}

export default async function RunsPage({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams;
  if (params.peek) {
    redirect(dashboardRoutes.run(params.peek));
  }

  // Dev/screenshot affordance: `?demo=...` renders a deterministic seeded model
  // (incl. a source-pressure WAIT card and a genuine reconnect card) so the
  // honesty of the copy is reviewable without a live throttled connection. The
  // real data path is never touched when `demo` is absent.
  if (params.demo) {
    return (
      <RecordroomShellWithPalette>
        <SyncsView model={DEMO_SYNCS_MODEL} seeded />
      </RecordroomShellWithPalette>
    );
  }

  const pageState = parseConnectorSummaryPageState(params);
  const filterFirstPagePromise = pageState.cursor
    ? fetchSyncsConnectorsPage({ cursor: undefined })
    : Promise.resolve(undefined);
  let runsResult: ListResponse<RunSummary>;
  let connectorsPage: Awaited<ReturnType<typeof fetchSyncsConnectorsPage>>;
  let connectorIcons: Awaited<ReturnType<typeof buildConnectorIconMap>>;
  let connectorManifests: Awaited<ReturnType<typeof listConnectorManifests>>;
  let filterFirstPage: Awaited<ReturnType<typeof fetchSyncsConnectorsPage>> | undefined;
  try {
    const manifestsPromise = listConnectorManifests().catch(() => []);
    [runsResult, connectorsPage, connectorIcons, filterFirstPage, connectorManifests] = await Promise.all([
      listRuns(runListQuery(params)),
      fetchSyncsConnectorsPage(pageState),
      manifestsPromise.then((manifests) => buildConnectorIconMap(manifests, [])),
      filterFirstPagePromise,
      manifestsPromise,
    ]);
  } catch (err) {
    if (err instanceof ReferenceServerUnreachableError) {
      return (
        <RecordroomShellWithPalette>
          <main className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 lg:px-8">
            <PageHeader title="Sync history" />
            <p className="text-[15px] text-muted-foreground">
              This could not be loaded. <Link className="text-primary underline" href="/syncs">Try again</Link>.
            </p>
            <details className="mt-4">
              <summary className="min-h-11 cursor-pointer py-2 text-[13px] text-muted-foreground">Details</summary>
              <ServerUnreachable />
            </details>
          </main>
        </RecordroomShellWithPalette>
      );
    }
    throw err;
  }

  if (connectorsPage.kind === "error") {
    return (
      <RecordroomShellWithPalette>
        <main className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 lg:px-8">
          <PageHeader title="Sync history" />
          <p className="text-[15px] text-muted-foreground">
            This could not be loaded. <Link className="text-primary underline" href={SYNCS_PATH}>Try again</Link>.
          </p>
          <details className="mt-4">
            <summary className="min-h-11 cursor-pointer py-2 text-[13px] text-muted-foreground">Details</summary>
            <ConnectorSummaryPageError basePath={SYNCS_PATH} currentParams={params} message={connectorsPage.message} />
          </details>
        </main>
      </RecordroomShellWithPalette>
    );
  }

  // The visible summary still follows the requested page cursor, but the
  // source filter starts at page 1 and follows server cursors up to its cap.
  const firstFilterPage = filterFirstPage ?? connectorsPage;
  const sourceFilter = await loadSourceFilterOptions(
    firstFilterPage,
    (cursor) =>
      cursor === pageState.cursor ? Promise.resolve(connectorsPage) : fetchSyncsConnectorsPage({ cursor }),
    params.connector_id
  );

  const connectorDisplayNames = new Map<string, string>();
  for (const manifest of connectorManifests) {
    const displayName = manifest.display_name?.trim();
    if (!displayName) continue;
    connectorDisplayNames.set(manifest.connector_id, displayName);
    if (manifest.connector_key) connectorDisplayNames.set(manifest.connector_key, displayName);
  }

  const model = buildSyncsViewModel({
    connectors: connectorsPage.items,
    connectorDisplayNames,
    runs: runsResult.data,
  });

  const liveRunCount = runsResult.data.filter(isLiveRun).length;
  return (
    <RecordroomShellWithPalette>
      <LivePoller enabled={liveRunCount > 0} />
      <SyncsView
        connectorIcons={connectorIcons}
        model={model}
        sourceSummaries={connectorsPage.items}
        sourcePager={
          <ConnectorSummaryPager
            basePath={SYNCS_PATH}
            currentParams={params}
            hasMore={connectorsPage.hasMore}
            isPaged={isPagedRequest(pageState)}
            nextCursor={connectorsPage.nextCursor}
          />
        }
        recentSyncsPaging={{
          connectorOptions: sourceFilter.options,
          hasMore: runsResult.has_more,
          isPaged: Boolean(params.run_cursor),
          nextCursor: runsResult.next_cursor,
          params,
          sourceFilterNote: sourceFilter.note,
          statusOptions: RUN_STATUS_FILTER_OPTIONS,
        }}
      />
    </RecordroomShellWithPalette>
  );
}
