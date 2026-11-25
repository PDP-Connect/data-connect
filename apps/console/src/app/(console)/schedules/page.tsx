// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx";
import {
  ConnectorSummaryPageError,
  ConnectorSummaryPager,
  loadConnectorSummaryPage,
} from "../components/connector-summary-page.tsx";
import { isPagedRequest, parseConnectorSummaryPageState } from "../components/connector-summary-pager.ts";
import { ServerUnreachable } from "../components/server-unreachable.tsx";
import { ReferenceServerUnreachableError } from "../lib/owner-token.ts";
import Link from "next/link";
import { listConnectorSummaries } from "../lib/ref-client.ts";
import { listConnectorManifests } from "../lib/rs-client.ts";
import { ScheduleRow } from "./schedule-row.tsx";
import { SchedulesPoller } from "./schedules-poller.tsx";

const SCHEDULES_PATH = "/schedules";

export const dynamic = "force-dynamic";

function fetchSchedulesPage(pageState: ReturnType<typeof parseConnectorSummaryPageState>) {
  return loadConnectorSummaryPage(pageState, (opts) => listConnectorSummaries(opts));
}

export default async function SchedulesPage({ searchParams }: { searchParams?: Promise<{ page_cursor?: string }> }) {
  const params = searchParams ? await searchParams : {};
  const pageState = parseConnectorSummaryPageState(params);

  let page: Awaited<ReturnType<typeof fetchSchedulesPage>>;
  const connectorManifests = await listConnectorManifests().catch(() => []);
  const connectorIcons = Object.fromEntries(
    connectorManifests.flatMap((manifest) => [
      [manifest.connector_id, manifest.icon] as const,
      ...(manifest.connector_key ? ([[manifest.connector_key, manifest.icon]] as const) : []),
    ])
  );
  try {
    page = await fetchSchedulesPage(pageState);
  } catch (err) {
    if (err instanceof ReferenceServerUnreachableError) {
      return (
        <RecordroomShellWithPalette>
          <main className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 lg:px-8">
            <PageHeading />
            <p className="text-[15px] text-muted-foreground">
              This could not be loaded. <Link className="text-primary underline" href="/schedules">Try again</Link>.
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

  if (page.kind === "error") {
    return (
      <RecordroomShellWithPalette>
        <main className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 lg:px-8">
          <PageHeading />
          <p className="text-[15px] text-muted-foreground">
            This could not be loaded. <Link className="text-primary underline" href="/schedules">Try again</Link>.
          </p>
          <details className="mt-4">
            <summary className="min-h-11 cursor-pointer py-2 text-[13px] text-muted-foreground">Details</summary>
            <ConnectorSummaryPageError basePath={SCHEDULES_PATH} currentParams={params} message={page.message} />
          </details>
        </main>
      </RecordroomShellWithPalette>
    );
  }

  const summaries = page.items;
  const hasActiveRun = summaries.some(
    (s) => typeof s.schedule?.active_run_id === "string" && s.schedule.active_run_id.length > 0
  );

  return (
    <RecordroomShellWithPalette>
      <SchedulesPoller enabled={hasActiveRun} />
      <main className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 lg:px-8">
        <PageHeading />
        {summaries.length > 0 ? (
          <ul className="border-t border-border/70">
            {summaries.map((summary) => (
              <ScheduleRow
                connectorIcon={connectorIcons[summary.connector_id]}
                key={summary.connection_id ?? summary.connector_instance_id ?? summary.connector_id}
                runsHref="/syncs"
                summary={summary}
              />
            ))}
          </ul>
        ) : (
          <p className="border-y border-border/70 py-5 text-[15px] text-muted-foreground">
            No data sources to schedule yet.
          </p>
        )}
        <ConnectorSummaryPager
          basePath={SCHEDULES_PATH}
          currentParams={params}
          hasMore={page.hasMore}
          isPaged={isPagedRequest(pageState)}
          nextCursor={page.nextCursor}
        />
        <details className="mt-6 border-t border-border/70 text-[13px] text-muted-foreground">
          <summary className="min-h-11 cursor-pointer py-3">Details</summary>
          <p>{summaries.filter((summary) => summary.schedule !== null).length} scheduled · {summaries.filter((summary) => summary.schedule === null).length} manual on this page.</p>
        </details>
      </main>
    </RecordroomShellWithPalette>
  );
}

function PageHeading() {
  return (
    <header className="mb-6">
      <h1 className="text-[23px] font-semibold leading-tight tracking-[-0.022em] text-foreground min-[860px]:text-[26px]">
        Schedules
      </h1>
    </header>
  );
}
