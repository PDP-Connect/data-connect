import { sourceRecordCount } from "../../lib/source-record-count.ts";
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { formatRelative, humanizeFieldLabel } from "@pdpp/display";
import { appNamesByClientId, appSourceName, groupGrantAccessByApp, pendingApprovalAppName } from "../../grants/app-access.ts";
import type {
  AppAccess,
  DatasetSummary,
  GrantSummary,
  OwnerIssuedClient,
  PendingApproval,
  RefConnectorSummary,
  TraceSummary,
} from "../../lib/ref-client.ts";
import { connectionDisplayName, connectionNameDisambiguators } from "../../lib/connection-display-name.ts";
import { isUpToDateRow, type SourceStatusWords, sourceStatusWords } from "../../lib/source-status-words.ts";


export const HOME_GRANT_LIMIT = 12;

export interface HomeHrefs {
  addSource: string;
  connect: string;
  deployment: string;
  deploymentTokens: string;
  grant: (id: string) => string;
  grants: string;
  source: (id: string) => string;
  sources: string;
}

export interface HomeReads {
  appRegistrations?: AppAccess[];
  approvals: PendingApproval[];
  approvalsFailed: boolean;
  approvalsHaveMore: boolean;
  grants: GrantSummary[];
  grantsFailed: boolean;
  grantsHaveMore: boolean;
  ownerClients: OwnerIssuedClient[];
  ownerClientsFailed: boolean;
  ownerClientsHaveMore: boolean;
  sourcePage: {
    error?: string;
    hasMore: boolean;
    kind: "error" | "ok";
    sources: RefConnectorSummary[];
  };
  summary: DatasetSummary | null;
  summaryFailed: boolean;
  traces: TraceSummary[];
  tracesFailed: boolean;
  tracesHaveMore: boolean;
}

export interface HomeSourceRow {
  href: string;
  id: string;
  name: string;
  source: RefConnectorSummary;
  status: SourceStatusWords;
}

export interface HomeNeedRow {
  actionHref: string;
  actionLabel: string | null;
  detail: string | null;
  href: string;
  id: string;
  iconId: string;
  kind: "waiting_sync" | "approval" | "source";
  name: string;
  source?: RefConnectorSummary;
  status?: SourceStatusWords;
  /** "last synced <when>" or "sync started <when>"; null when the data source has neither. */
  syncNote: string | null;
}

export interface HomeAppRow {
  href: string;
  id: string;
  lastRead: string | null;
  name: string;
  reads: string;
}

export interface HomeData {
  addSourceHref: string;
  activeTokenCount: number;
  allAppsHref: string;
  allAppsLink: boolean;
  allTokensLink: boolean;
  appError: boolean;
  apps: HomeAppRow[];
  appsEmpty: boolean;
  appsHref: string;
  dataSourceCount: string | null;
  dataSourceError: boolean;
  dataSources: HomeSourceRow[];
  deploymentHref: string;
  firstRun: boolean;
  needs: HomeNeedRow[];
  needsError: boolean;
  needsMore: boolean;
  needsVisible: boolean;
  noSources: boolean;
  recordCount: string | null;
  summaryError: boolean;
  reloadHref: string;
  sourcesHref: string;
  showMoreSources: boolean;
  shownSourceCount: number;
  /** "All N data sources" when a complete read has more rows than Home shows; null on a paged read. */
  sourceTotalLink: string | null;
  subtitle: string | null;
  title: string;
  tokensHref: string;
  warning: boolean;
}

export interface HomeInputs extends HomeReads {
  hrefs: HomeHrefs;
  now: Date;
  reloadHref: string;
}

interface PreparedSource extends HomeSourceRow {
  actionSurface: string | null;
  sortAt: string | null;
}

/** Join source names without dropping any of them. */
export function joinHuman(parts: readonly string[]): string {
  const list = parts.filter(Boolean);
  if (list.length <= 1) return list[0] ?? "";
  if (list.length === 2) return `${list[0]} and ${list[1]}`;
  return `${list.slice(0, -1).join(", ")}, and ${list.at(-1)}`;
}

/** Name the data source attached to an app's access. */
export function grantReads(grant: GrantSummary): string {
  const source =
    appSourceName(grant.source) ??
    (grant.connector_id ? appSourceName({ id: grant.connector_id, kind: "connector" }) : null);
  if (source) return `reads only ${source}`;
  return "reads a scoped slice of your data";
}

function approvalReads(approval: PendingApproval): string {
  const streams = (approval.grant_preview?.streams ?? [])
    .map((stream) => (typeof stream === "string" ? stream : (stream.name ?? "")))
    .filter(Boolean);
  const phrases = Array.from(new Set(streams.map(humanizeFieldLabel)));
  return phrases.length > 0 ? joinHuman(phrases) : "parts of your data";
}

function relativeWhen(value: string | null | undefined, now: Date): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : formatRelative(date, now.getTime());
}

function oldestFirst<T>(items: T[], at: (item: T) => string | null): T[] {
  return [...items].sort((left, right) => {
    const leftAt = at(left) ? Date.parse(at(left) as string) : Number.POSITIVE_INFINITY;
    const rightAt = at(right) ? Date.parse(at(right) as string) : Number.POSITIVE_INFINITY;
    if (leftAt === rightAt) return 0;
    return leftAt < rightAt ? -1 : 1;
  });
}

function sourceActionSurface(source: RefConnectorSummary): string | null {
  return source.rendered_verdict?.required_actions.find((action) => action.audience === "owner")?.surface?.kind ?? null;
}

function sourceSortTime(source: RefConnectorSummary): string | null {
  return source.owner_state?.evidence_as_of ?? source.last_run?.started_at ?? null;
}

function lastSuccessfulSync(source: RefConnectorSummary): string | null {
  return source.connection_health.last_success_at ?? source.last_successful_run?.last_at ?? null;
}

function prepareSources(sources: readonly RefConnectorSummary[], now: Date, hrefs: HomeHrefs): PreparedSource[] {
  const disambiguators = connectionNameDisambiguators(sources);
  return sources.map((source) => ({
    actionSurface: sourceActionSurface(source),
    href: hrefs.source(source.connection_id),
    id: source.connection_id,
    name: connectionDisplayName(source.display_name, source.connector_display_name, source.connector_id, disambiguators.get(source.connection_id)),
    sortAt: sourceSortTime(source),
    source,
    status: sourceStatusWords(source, { now }),
  }));
}

function approvalRow(
  approval: PendingApproval,
  now: Date,
  hrefs: HomeHrefs,
  knownNames: ReadonlyMap<string, string>,
): HomeNeedRow {
  const name = pendingApprovalAppName(knownNames.get(approval.client_id ?? ""));
  const when = relativeWhen(approval.created_at, now);
  const asksFor = approvalReads(approval);
  return {
    actionHref: hrefs.grants,
    actionLabel: "Review",
    detail: `Asks to read ${asksFor}${when ? ` · ${when}` : ""}`,
    href: hrefs.grants,
    iconId: approval.client_id || name,
    id: `approval:${approval.approval_id}`,
    kind: "approval",
    name,
    syncNote: null,
  };
}

function sourceNeedRow(source: PreparedSource, now: Date, waitingSync: boolean): HomeNeedRow {
  const lastSynced = relativeWhen(lastSuccessfulSync(source.source), now);
  const syncStarted =
    source.source.last_run?.status === "started" ? relativeWhen(source.source.last_run.started_at, now) : null;
  // Lead decision (home-pictures 1, 2): the second line carries the status words,
  // then a sync time only when a sync succeeded or started.
  const syncNote =
    waitingSync && syncStarted ? `sync started ${syncStarted}` : lastSynced ? `last synced ${lastSynced}` : null;
  return {
    actionHref: source.href,
    actionLabel: source.status.action?.label ?? null,
    detail: null,
    href: source.href,
    iconId: source.source.connector_id,
    id: source.id,
    kind: waitingSync ? "waiting_sync" : "source",
    name: source.name,
    source: source.source,
    status: source.status,
    syncNote,
  };
}

function number(value: number): string {
  return value.toLocaleString("en-US");
}

function counted(value: number, one: string, many: string): string {
  return `${number(value)} ${value === 1 ? one : many}`;
}

export function buildHomeViewModel(input: HomeInputs): HomeData {
  const sourceReadFailed = input.sourcePage.kind === "error";
  const preparedSources = sourceReadFailed ? [] : prepareSources(input.sourcePage.sources, input.now, input.hrefs);
  const knownNames = appNamesByClientId([], input.ownerClientsFailed ? [] : input.ownerClients);
  for (const app of groupGrantAccessByApp(input.appRegistrations ?? [], input.now.getTime())) for (const id of app.clientIds) knownNames.set(id, app.name);
  // Rows 1–3 are archived, disconnected or never set up. The direction keeps
  // those states on the data-sources page rather than treating them as active.
  const activeSources = preparedSources.filter(
    (source) => source.status.row !== 1 && source.status.row !== 2 && source.status.row !== 3,
  );
  const waitingSources = oldestFirst(
    activeSources.filter(
      (source) => source.status.needsYou && source.status.row === 8 && source.actionSurface === "provider_interaction",
    ),
    (source) => source.sortAt,
  );
  const otherNeedsSources = oldestFirst(
    activeSources.filter(
      (source) =>
        source.status.needsYou && !(source.status.row === 8 && source.actionSurface === "provider_interaction"),
    ),
    (source) => source.sortAt,
  );
  const approvals = oldestFirst(input.approvals, (approval) => approval.created_at).map((approval) =>
    approvalRow(approval, input.now, input.hrefs, knownNames),
  );
  const needs = [
    ...waitingSources.map((source) => sourceNeedRow(source, input.now, true)),
    ...approvals,
    ...otherNeedsSources.map((source) => sourceNeedRow(source, input.now, false)),
  ];

  const sortedDataSources = activeSources
    .filter((source) => !source.status.needsYou)
    .sort((left, right) => {
      const leftSyncing = left.status.row === 11;
      const rightSyncing = right.status.row === 11;
      if (leftSyncing !== rightSyncing) return leftSyncing ? -1 : 1;
      return left.name.localeCompare(right.name);
    });
  const dataSources = sortedDataSources.slice(0, 12);
  const syncingSources = activeSources.filter((source) => source.status.row === 11);
  const apps = input.grantsFailed ? [] : groupGrantAccessByApp(input.appRegistrations ?? [], input.now.getTime())
    .filter((app) => app.state === "reading").map((app) => ({ clientId: app.clientIds[0] || "", href: input.hrefs.grant(app.hrefId), id: app.hrefId, name: app.name, reads: joinHuman(app.sources), lastRead: app.lastRead ? formatRelative(new Date(app.lastRead), input.now.getTime()) : null }));
  const activeTokenCount = input.ownerClients.reduce((sum, client) => sum + Math.max(0, client.active_token_count), 0);
  // More owner-made clients than one page is not a failure: show what was read
  // and link to the full list instead of a count that may be short.
  const tokenReadIncomplete = input.ownerClientsFailed || input.ownerClientsHaveMore;
  const appError = input.grantsFailed || input.tracesFailed || input.ownerClientsFailed;
  const appsEmpty =
    apps.length === 0 &&
    activeTokenCount === 0 &&
    !input.grantsFailed &&
    !input.grantsHaveMore &&
    !input.tracesFailed &&
    !input.tracesHaveMore &&
    !tokenReadIncomplete;
  const sourceReadComplete = !sourceReadFailed && !input.sourcePage.hasMore;
  const needsReadFailed = input.approvalsFailed;
  const needsReadIncomplete = needsReadFailed || input.approvalsHaveMore;
  const firstRun =
    sourceReadComplete &&
    preparedSources.length === 0 &&
    needs.length === 0 &&
    !needsReadIncomplete &&
    apps.length === 0 &&
    activeTokenCount === 0 &&
    !appError &&
    !input.grantsHaveMore &&
    !input.tracesHaveMore;
  // No data sources, but something else exists (an app, a token): the title
  // says so and carries the one filled button, unless something needs the person.
  const noSources =
    !firstRun && sourceReadComplete && preparedSources.length === 0 && needs.length === 0 && !needsReadIncomplete;
  const title = firstRun
    ? "Start with one data source"
    : !sourceReadComplete || needsReadIncomplete
      ? "Data sources"
      : needs.length === 1
        ? "1 thing needs you"
        : needs.length > 1
          ? `${needs.length} things need you`
          : syncingSources.length === 1
            ? `Syncing ${syncingSources[0]?.name ?? "a data source"}`
            : syncingSources.length > 1
              ? `Syncing ${syncingSources.length} data sources`
              : noSources
                ? "No data sources yet."
                : activeSources.length > 0 && activeSources.every((source) => isUpToDateRow(source.status.row))
                  ? "Everything is up to date"
                  : "Nothing needs you";

  // A refreshing summary still carries the last known total; rebuilding,
  // stale, failed or unknown states do not.
  // The server counts connections in the same projection as records, so a
  // stale summary can say 0 while the full source list shows three. Without a
  // current summary, count the source list when it was read in full.
  const dataSourceTotal = sourceReadComplete ? preparedSources.length : null;
  const dataSourceCount = dataSourceTotal === null ? null : number(dataSourceTotal);
  const sourceCounts = preparedSources.map(({ source }) => sourceRecordCount(source).count);
  const recordTotal = sourceReadComplete && sourceCounts.every((count) => count !== null) ? sourceCounts.reduce<number>((sum, count) => sum + (count ?? 0), 0) : null;
  const subtitle =
    [
      dataSourceTotal === null ? null : counted(dataSourceTotal, "data source", "data sources"),
      recordTotal === null ? null : counted(recordTotal, "record", "records"),
    ]
      .filter(Boolean)
      .join(" · ") || null;
  const warning =
    input.summaryFailed ||
    input.summary?.projection?.state === "stale" ||
    input.summary?.projection?.state === "failed";

  const showMoreSources = !sourceReadFailed && (input.sourcePage.hasMore || sortedDataSources.length > 12);
  const sourceTotalLink =
    sourceReadComplete && sortedDataSources.length > 12
      ? `All ${counted(preparedSources.length, "data source", "data sources")}`
      : null;
  return {
    activeTokenCount: tokenReadIncomplete ? 0 : activeTokenCount,
    allAppsHref: input.hrefs.grants,
    allAppsLink: !input.grantsFailed && apps.length > 5,
    allTokensLink: !input.ownerClientsFailed && input.ownerClientsHaveMore,
    appError,
    apps,
    appsEmpty,
    appsHref: input.hrefs.connect,
    dataSourceCount,
    dataSourceError: sourceReadFailed,
    dataSources,
    deploymentHref: input.hrefs.deployment,
    firstRun,
    needs,
    needsError: needsReadFailed,
    needsMore: !needsReadFailed && input.approvalsHaveMore,
    needsVisible: needs.length > 0 || needsReadIncomplete,
    noSources,
    recordCount: recordTotal === null ? null : number(recordTotal),
    reloadHref: input.reloadHref,
    addSourceHref: input.hrefs.addSource,
    sourcesHref: input.hrefs.sources,
    showMoreSources,
    shownSourceCount: dataSources.length + needs.filter((need) => need.source).length,
    sourceTotalLink,
    subtitle,
    summaryError: input.summaryFailed,
    title,
    tokensHref: input.hrefs.deploymentTokens,
    warning,
  };
}
