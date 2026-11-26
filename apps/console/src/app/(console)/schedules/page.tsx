// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx";
import {
  ConnectorSummaryPager,
  loadConnectorSummaryPage,
} from "../components/connector-summary-page.tsx";
import { isPagedRequest, parseConnectorSummaryPageState } from "../components/connector-summary-pager.ts";
import { ReferenceServerUnreachableError } from "../lib/owner-token.ts";
import Link from "next/link";
import { listDeviceExporterSourceInstances, listConnectorSummaries } from "../lib/ref-client.ts";
import { listConnectorManifests } from "../lib/rs-client.ts";
import { SupportCopy } from "../components/support-copy.tsx";
import { ScheduleRow } from "./schedule-row.tsx";
import { buildSchedulePractice } from "./schedule-presentation.ts";
import { SchedulesPoller } from "./schedules-poller.tsx";

const SCHEDULES_PATH = "/schedules";

export const dynamic = "force-dynamic";

function fetchSchedulesPage(pageState: ReturnType<typeof parseConnectorSummaryPageState>) {
  return loadConnectorSummaryPage(pageState, (opts) => listConnectorSummaries(opts));
}

export default async function SchedulesPage({ searchParams }: { searchParams?: Promise<{ page_cursor?: string; demo?: string }> }) {
  const params = searchParams ? await searchParams : {};
  const pageState = parseConnectorSummaryPageState(params);

  let page: Awaited<ReturnType<typeof fetchSchedulesPage>>;
  const practice = process.env.NODE_ENV !== "production" && params.demo ? buildSchedulePractice(params.demo) : null;
  const connectorManifests = practice ? [] : await listConnectorManifests().catch(() => []);
  const connectorIcons = Object.fromEntries(
    connectorManifests.flatMap((manifest) => [
      [manifest.connector_id, manifest.icon] as const,
      ...(manifest.connector_key ? ([[manifest.connector_key, manifest.icon]] as const) : []),
    ])
  );
  try {
    page = practice ? { kind: "ok", runtime: undefined, items: practice, hasMore: false, nextCursor: undefined } : await fetchSchedulesPage(pageState);
  } catch (err) {
    if (err instanceof ReferenceServerUnreachableError) {
      return (
        <RecordroomShellWithPalette>
          <main className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 lg:px-8">
            <PageHeading />
            <p className="text-[15px] text-muted-foreground">
              This could not be loaded. <Link className="text-primary underline" href="/schedules">Try again</Link>.
            </p>
            <SupportCopy details={err.message} />
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
          <SupportCopy details={page.message} />
        </main>
      </RecordroomShellWithPalette>
    );
  }

  const summaries = page.items;
  const deviceSources = !practice && summaries.some((source) => source.source_kind === "local_device") ? await listDeviceExporterSourceInstances().catch(() => ({ data: [] })) : { data: [] };
  const deviceNames = new Map(deviceSources.data.map((source) => [source.connector_instance_id, source.device_display_name || "its device"]));
  const hasActiveRun = summaries.some(
    (s) => typeof s.schedule?.active_run_id === "string" && s.schedule.active_run_id.length > 0
  );

  return (
    <RecordroomShellWithPalette>
      <SchedulesPoller enabled={hasActiveRun} />
      <main className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 lg:px-8">
        <PageHeading />
        <p className="mb-6 text-muted-foreground">{summaries.length} data sources · {summaries.filter((s) => s.source_kind !== "local_device" && s.schedule?.enabled).length} sync by themselves{page.hasMore ? " on this page" : ""}.</p>
        {summaries.length > 0 ? (
          <ul className="border-t border-border/70">
            {summaries.map((summary) => (
              <ScheduleRow
                connectorIcon={connectorIcons[summary.connector_id]}
                key={summary.connection_id ?? summary.connector_instance_id ?? summary.connector_id}
                deviceName={practice ? "Work computer" : deviceNames.get(summary.connection_id)}
                presentation="plain"
                practice={practice !== null}
                runsHref="/syncs"
                summary={summary}
              />
            ))}
          </ul>
        ) : (
          <p className="border-y border-border/70 py-5 text-[15px] text-muted-foreground">
            No data sources yet. <Link href="/sources/new" className="underline">Add a data source</Link>
          </p>
        )}
        <ConnectorSummaryPager
          basePath={SCHEDULES_PATH}
          currentParams={params}
          hasMore={page.hasMore}
          isPaged={isPagedRequest(pageState)}
          nextCursor={page.nextCursor}
        />

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
