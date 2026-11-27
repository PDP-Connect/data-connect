import { readPersonOffset } from "../history/server-day.ts";
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Sources — the paged data sources list.
 *
 * The page reads one bounded page of summaries and projects each data source
 * into a row. Row actions and folded groups keep the other list controls close
 * to the data source they affect. Records are never rendered here — Explore is
 * the one reader.
 *
 * Data path is REAL: the page fetches exactly ONE bounded page of connector
 * summaries (`listConnectorSummaries({ cursor, limit: 100 })` — never the
 * exhaustive fold) through the existing owner-token `liveDashboardDataSource`,
 * and projects it with the pure `toSourcesView` mapping. A list larger than
 * one page is reachable via the shared `ConnectorSummaryPager` (a bounded
 * `page_cursor` Next link + explicit Restart; Previous is the browser's own
 * back button, never URL-side history), not by prefetching every page
 * before first paint. The route id is unchanged
 * (`/sources`); redirects + tests pin it. The Sync and Revoke
 * mutations bind to the same server actions the prior surface used
 * (`runConnectorNowAction`, `revokeConnectionAction`, `reactivateConnectionAction`).
 *
 * A DEV-ONLY seeded demo (`?demo=mixed|healthy|attention`, blocked in
 * production) lets a reviewer screenshot every status flag and the revoke
 * ceremony without a live server. The live path never imports the fixtures
 * when `demo` is absent.
 */
import { buttonVariants, IcButton, Text } from "@pdpp/brand-react";
import Link from "next/link";
import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx";
import {
  ConnectorSummaryPageError,
  ConnectorSummaryPager,
  loadConnectorSummaryPage,
} from "../components/connector-summary-page.tsx";
import { isPagedRequest, parseConnectorSummaryPageState } from "../components/connector-summary-pager.ts";
import { ServerUnreachable } from "../components/server-unreachable.tsx";
import { buildConnectorIconMap } from "../lib/connector-icon-map.ts";
import { isActiveConnectorRunSummaryStatus } from "../lib/connector-run-summary-status.ts";
import { liveDashboardDataSource } from "../lib/data-source.ts";
import { getReferencePublicOrigin, ReferenceServerUnreachableError } from "../lib/owner-token.ts";
import { listConnectorManifests } from "../lib/rs-client.ts";
import {
  purgeBrowserProfileAction,
  reactivateConnectionAction,
  resumeConnectionAction,
  resumeConnectorScheduleAction,
  resumeSetupConnectionAction,
  revokeConnectionAction,
} from "./[connector]/actions.ts";
import { runConnectorNowAction } from "./actions.ts";
import { readConnectorUpdates } from "./connector-updates-read.ts";
import { RecordsPagePoller } from "./records-page-poller.tsx";
import { actionEmphasis } from "../lib/action-emphasis.ts";
import { SourcesView } from "./sources-view.tsx";
import {
  buildSourcesRuntimeAdvisory,
  type SourcesRuntimeAdvisory,
  toSourcesView,
} from "./sources-view-model.ts";
import { buildUpdatesReadyDemo, isUpdatesReadyDemoScenario, readUpdatesReadySafely } from "./updates-ready-model.ts";

const SOURCES_PATH = "/sources";
const REFERENCE_REVISION = process.env.PDPP_REFERENCE_REVISION?.trim() || undefined;

export const dynamic = "force-dynamic";

const SCHEME_RE = /^https?:\/\//;

function stripScheme(url: string): string {
  return url.replace(SCHEME_RE, "");
}

async function resolveHost(): Promise<string> {
  try {
    return stripScheme(await getReferencePublicOrigin());
  } catch {
    return "this server";
  }
}

function fetchSourcesPage(pageState: ReturnType<typeof parseConnectorSummaryPageState>) {
  // `sourcesVisibility: true` asks the reference to exclude a pure recovered
  // historical fragment BEFORE its own LIMIT, so `hasMore`/the next cursor
  // stay correct for the rows this page actually renders — never a
  // post-LIMIT filter. Explore and every other surface omit this flag.
  return loadConnectorSummaryPage(pageState, (opts) =>
    liveDashboardDataSource.listConnectorSummaries({ ...opts, sourcesVisibility: true })
  );
}

export default async function RecordsIndexPage({
  searchParams,
}: {
  searchParams?: Promise<{
    demo?: string;
    error?: string;
    message?: string;
    page_cursor?: string;
    purge_retry?: string;
  }>;
}) {
  const params = searchParams ? await searchParams : {};
  const host = await resolveHost();
  const pageState = parseConnectorSummaryPageState(params);

  // DEV-ONLY seeded demo. Gated by NODE_ENV so production never reads fixtures.
  const demoParam = typeof params.demo === "string" ? params.demo : undefined;
  if (process.env.NODE_ENV !== "production" && demoParam) {
    const { buildSourcesDemoSummaries, isSourcesDemoScenario } = await import(
      "./sources-demo-data.ts"
    );
    const scenario = isSourcesDemoScenario(demoParam) ? demoParam : "mixed";
    const instances = toSourcesView(buildSourcesDemoSummaries(scenario));
    const updatesReadyDemo = isUpdatesReadyDemoScenario(demoParam) ? buildUpdatesReadyDemo(demoParam) : undefined;
    return (
      <RecordroomShellWithPalette host={host}>
        <SourcesHeader notice={`Seeded demo · ${scenario} · fictional data`} />
        {/* interactive=false: the demo never reaches a live server, so the
            mutating Sync/Revoke controls are read-only here. */}
        <SourcesView
          instances={instances}
          interactive={false}
          reactivateAction={reactivateConnectionAction}
          resumeAction={resumeConnectionAction}
          resumeScheduleAction={resumeConnectorScheduleAction}
          resumeSetupAction={resumeSetupConnectionAction}
          revokeAction={revokeConnectionAction}
          runNowAction={runConnectorNowAction}
          updatesReadyDemo={updatesReadyDemo}
        />
      </RecordroomShellWithPalette>
    );
  }

  let manifests: Awaited<ReturnType<typeof listConnectorManifests>>;
  let connectorIcons: Awaited<ReturnType<typeof buildConnectorIconMap>>;
  let page: Awaited<ReturnType<typeof fetchSourcesPage>>;
  try {
    const [pageResult, connectorManifests] = await Promise.all([
      fetchSourcesPage(pageState),
      listConnectorManifests(),
    ]);
    page = pageResult;
    manifests = connectorManifests;
    connectorIcons = await buildConnectorIconMap(manifests, []);
  } catch (err) {
    if (err instanceof ReferenceServerUnreachableError) {
      return (
        <RecordroomShellWithPalette host={host}>
          <SourcesHeader />
          <ServerUnreachable />
        </RecordroomShellWithPalette>
      );
    }
    throw err;
  }

  if (page.kind === "error") {
    return (
      <RecordroomShellWithPalette host={host}>
        <SourcesHeader error={params.error} message={params.message} purgeRetryId={params.purge_retry} />
        <ConnectorSummaryPageError basePath={SOURCES_PATH} currentParams={params} message={page.message} />
      </RecordroomShellWithPalette>
    );
  }

  const summaries = [...page.items];
  const runtimeAdvisory: SourcesRuntimeAdvisory | null = buildSourcesRuntimeAdvisory(page.runtime);
  const instances = toSourcesView(summaries, { connectorIcons, manifests,offset:await readPersonOffset() });
  const updatesReady = readUpdatesReadySafely(readConnectorUpdates);
  // The poller is mounted unconditionally; `running` (derived from any active
  // run) only selects the fast vs. idle cadence. Named `runningCount` to match
  // the records-poller mount invariant.
  const runningCount = summaries.filter(
    (s) => s.last_run !== null && isActiveConnectorRunSummaryStatus(s.last_run.status)
  ).length;

  return (
    <RecordroomShellWithPalette host={host}>
      <SourcesHeader error={params.error} message={params.message} purgeRetryId={params.purge_retry} quietAdd={actionEmphasis(instances.some((instance) => instance.statusWords.needsYou)).optional === "quiet"} />
      <SourcesView
        instances={instances}
        interactive={true}
        pagingInPlay={isPagedRequest(pageState) || page.hasMore}
        reactivateAction={reactivateConnectionAction}
        resumeAction={resumeConnectionAction}
        resumeScheduleAction={resumeConnectorScheduleAction}
        resumeSetupAction={resumeSetupConnectionAction}
        revokeAction={revokeConnectionAction}
        runNowAction={runConnectorNowAction}
        runtimeAdvisory={runtimeAdvisory}
        updatesReady={updatesReady}
      />
      <ConnectorSummaryPager
        basePath={SOURCES_PATH}
        currentParams={params}
        hasMore={page.hasMore}
        isPaged={isPagedRequest(pageState)}
        nextCursor={page.nextCursor}
      />
      <RecordsPagePoller running={runningCount > 0} />
    </RecordroomShellWithPalette>
  );
}

function SourcesHeader({
  quietAdd = false,
  error,
  message,
  notice,
  purgeRetryId,
}: {
  quietAdd?: boolean;
  error?: string;
  message?: string;
  notice?: string;
  purgeRetryId?: string;
}) {
  return (
    <header className="rr-s-header" data-pdpp-reference-revision={REFERENCE_REVISION}>
      <div className="rr-s-header__title-row">
        <Text as="h1" className="rr-s-header__title" size="title" weight="semi">Data sources</Text>
        <Link className={buttonVariants({ size: "sm", variant: quietAdd ? "ghost" : "default" })} href={`${SOURCES_PATH}/add`}>Add a data source</Link>
      </div>
      {notice ? (
        // Lead decision (list-pictures 5): the demo line matches Home's, 13px in the second text colour.
        <Text as="p" className="rr-s-header__demo text-[13px] text-muted-foreground">
          {notice}
        </Text>
      ) : null}
      {error ? (
        <div className="rr-s-toast rr-s-header__notice" data-tone="error" role="status">
          {error}
        </div>
      ) : null}
      {error && purgeRetryId ? (
        // The connection is already revoked or deleted; only its saved browser
        // session is left. The retry runs the same purge again.
        <form action={purgeBrowserProfileAction} className="rr-s-header__purge" data-testid="sources-purge-retry">
          <input name="connection_id" type="hidden" value={purgeRetryId} />
          <IcButton size="sm" type="submit" variant="destructive">
            Remove saved browser session
          </IcButton>
        </form>
      ) : null}
      {message && !error ? (
        <div className="rr-s-toast rr-s-header__notice" data-tone="ok" role="status">
          <SyncStartedNotice message={message} />
        </div>
      ) : null}
    </header>
  );
}

function SyncStartedNotice({ message }: { message: string }) {
  const match = /^Run started(?: \(([^)]+)\))?$/.exec(message);
  if (!match) return message;
  return <>Sync started.{match[1] ? <> <Link href={`/syncs/${encodeURIComponent(match[1])}`}>See this sync</Link></> : null}</>;
}
