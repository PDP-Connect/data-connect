// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { formatRelative } from "@pdpp/display";
import type {
  DatasetSummary,
  GrantSummary,
  OwnerIssuedClient,
  PendingApproval,
  RefConnectorSummary,
  TraceSummary,
} from "../../lib/ref-client.ts";
import { connectionDisplayName } from "../../lib/connection-display-name.ts";
import { isUpToDateRow, type SourceStatusWords, sourceStatusWords } from "../../lib/source-status-words.ts";

const SCOPE_HUMAN: Record<string, string> = {
  browser_history: "your browsing",
  browsing: "your browsing",
  "consent.approved": "access decisions",
  conversations: "your conversations",
  current_activity: "your spending",
  "disclosure.served": "data disclosures",
  emails: "your email",
  employment: "your employment history",
  health: "your health records",
  income: "your pay",
  listening_history: "what you listen to",
  location: "where you've been",
  messages: "your messages",
  orders: "your orders",
  pay_statements: "your pay",
  paystubs: "your pay",
  purchases: "your purchases",
  "query.received": "read requests",
  "query.rejected": "rejected reads",
  statements: "your statements",
  tax_docs: "your tax documents",
  tax_documents: "your tax documents",
  "token.issued": "token activity",
  transactions: "your spending",
  watch_history: "what you watch",
};

const READ_SUFFIX_RE = /\.read$/;
const STREAM_PREFIX_RE = /^[a-z0-9-]+:/;
const UNDERSCORE_RE = /_/g;
const PROTOCOL_KIND_PREFIX_RE = /^(grant|trace|run|event)\./;
const PROTOCOL_KIND_WORDS = new Set(["read", "issued", "approved", "revoked", "denied"]);
const HEX_TOKEN_RE = /^[a-f0-9]{16,}$/i;
const LONG_MACHINE_TOKEN_RE = /^(?=.{32,}$)(?=.*\d)[A-Za-z0-9_-]+$/;
const TECH_ID_PREFIX_RE = /^(cli|grt|trc|run|req|cin|dsrc|dexp|ldt)_[A-Za-z0-9_-]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WWW_PREFIX_RE = /^www\./;
const REVOKED_STATES = new Set(["revoked", "denied", "rejected", "expired"]);

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

interface PreparedApp {
  clientId: string;
  href: string;
  id: string;
  name: string;
  reads: string;
}

/** Humanize one permission scope, with an honest spaced-name fallback. */
export function scopeHuman(name: string): string {
  const bare = name.replace(READ_SUFFIX_RE, "").replace(STREAM_PREFIX_RE, "");
  return SCOPE_HUMAN[bare] ?? (bare.replace(UNDERSCORE_RE, " ").trim() || name);
}

/** Join plain permission phrases without dropping any of them. */
export function joinHuman(parts: readonly string[]): string {
  const list = parts.filter(Boolean);
  if (list.length <= 1) return list[0] ?? "";
  if (list.length === 2) return `${list[0]} and ${list[1]}`;
  return `${list.slice(0, -1).join(", ")}, and ${list.at(-1)}`;
}

/** Reuse the existing permission-to-plain-words mapping. */
export function grantReads(grant: GrantSummary): string {
  const meaningfulKinds = grant.kinds
    .map((kind) => kind.replace(PROTOCOL_KIND_PREFIX_RE, ""))
    .filter((kind) => kind && !PROTOCOL_KIND_WORDS.has(kind));
  const phrases = Array.from(new Set(meaningfulKinds.map(scopeHuman))).filter(Boolean);
  if (phrases.length > 0) return `reads only ${joinHuman(phrases)}`;
  if (grant.connector_id) return `reads only ${scopeHuman(grant.connector_id)}`;
  return "reads a scoped slice of your data";
}

function approvalReads(approval: PendingApproval): string {
  const streams = (approval.grant_preview?.streams ?? [])
    .map((stream) => (typeof stream === "string" ? stream : (stream.name ?? "")))
    .filter(Boolean);
  const phrases = Array.from(new Set(streams.map(scopeHuman)));
  return phrases.length > 0 ? joinHuman(phrases) : "parts of your data";
}

function hostFromUrl(value: string): string | null {
  try {
    return new URL(value).hostname.replace(WWW_PREFIX_RE, "") || null;
  } catch {
    return null;
  }
}

function looksLikeTechnicalId(value: string): boolean {
  return (
    TECH_ID_PREFIX_RE.test(value) ||
    UUID_RE.test(value) ||
    HEX_TOKEN_RE.test(value) ||
    LONG_MACHINE_TOKEN_RE.test(value)
  );
}

function clientLabel(name: string | null, fallbackId: string): string {
  const raw = name?.trim() || fallbackId;
  const host = hostFromUrl(raw);
  if (host) return host;
  return looksLikeTechnicalId(raw) ? "Unnamed app" : raw;
}

function appNamesById(clients: readonly OwnerIssuedClient[]): Map<string, string> {
  return new Map(
    clients.flatMap((client) => {
      const name = client.client_name?.trim();
      return name ? [[client.client_id, name] as const] : [];
    }),
  );
}

function appAccesses(
  grants: readonly GrantSummary[],
  clients: readonly OwnerIssuedClient[],
  hrefs: HomeHrefs,
): PreparedApp[] {
  const groups = new Map<string, { grantIds: string[]; name: string; phrases: Set<string> }>();
  const knownNames = appNamesById(clients);

  for (const grant of grants) {
    if (REVOKED_STATES.has(grant.status.toLowerCase())) continue;
    const clientId = grant.client_id || grant.grant_id;
    const existing = groups.get(clientId) ?? {
      grantIds: [],
      name: clientLabel(
        grant.client?.client_name?.trim() || knownNames.get(clientId) || grant.client_id,
        grant.grant_id,
      ),
      phrases: new Set<string>(),
    };
    existing.grantIds.push(grant.grant_id);
    const reads = grantReads(grant)
      .replace(/^reads only /, "")
      .replace(/^reads /, "");
    if (reads) existing.phrases.add(reads);
    groups.set(clientId, existing);
  }

  return Array.from(groups, ([clientId, group]) => {
    const uniqueGrantIds = Array.from(new Set(group.grantIds));
    const grantId = uniqueGrantIds.length === 1 ? uniqueGrantIds[0] : null;
    return {
      clientId,
      href: grantId ? hrefs.grant(grantId) : hrefs.grants,
      id: clientId,
      name: group.name,
      reads: joinHuman(Array.from(group.phrases)) || "a scoped slice of your data",
    };
  });
}

function latestSuccessfulRead(traces: readonly TraceSummary[], clientId: string, now: Date): string | null {
  let latest: number | null = null;
  for (const trace of traces) {
    const traceClientId = trace.client?.client_id ?? trace.client_id;
    if (traceClientId !== clientId || trace.status.toLowerCase() !== "succeeded" || trace.failure !== null) continue;
    const at = Date.parse(trace.last_at);
    if (Number.isFinite(at) && (latest === null || at > latest)) latest = at;
  }
  return latest === null ? null : formatRelative(new Date(latest), now.getTime());
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
  return sources.map((source) => ({
    actionSurface: sourceActionSurface(source),
    href: hrefs.source(source.connection_id),
    id: source.connection_id,
    name: connectionDisplayName(source.display_name, source.connector_display_name, source.connector_id),
    sortAt: sourceSortTime(source),
    source,
    status: sourceStatusWords(source, { now }),
  }));
}

function approvalRow(approval: PendingApproval, now: Date, hrefs: HomeHrefs): HomeNeedRow {
  const name = clientLabel(approval.client_id ?? null, approval.approval_id);
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
    approvalRow(approval, input.now, input.hrefs),
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
  const appAccessesPrepared = input.grantsFailed
    ? []
    : appAccesses(input.grants, input.ownerClientsFailed ? [] : input.ownerClients, input.hrefs);
  const apps = appAccessesPrepared.map((app) => ({
    ...app,
    lastRead: input.tracesFailed ? null : latestSuccessfulRead(input.traces, app.clientId, input.now),
  }));
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

  const dataSourceTotal = input.summaryFailed
    ? sourceReadComplete
      ? preparedSources.length
      : null
    : input.summary
      ? input.summary.connector_count
      : sourceReadComplete
        ? preparedSources.length
        : null;
  const dataSourceCount = dataSourceTotal === null ? null : number(dataSourceTotal);
  // A refreshing summary still carries the last known total; rebuilding,
  // stale, failed or unknown states do not.
  const recordState = input.summary?.projection?.state;
  const recordTotal =
    !input.summaryFailed && (recordState === "fresh" || recordState === "refreshing")
      ? (input.summary?.record_count ?? null)
      : null;
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
    input.summary?.projection?.state === "failed" ||
    sourceReadFailed ||
    needsReadFailed ||
    input.grantsFailed ||
    input.tracesFailed ||
    input.ownerClientsFailed;

  const showMoreSources = !sourceReadFailed && (input.sourcePage.hasMore || sortedDataSources.length > 12);
  const sourceTotalLink =
    sourceReadComplete && sortedDataSources.length > 12
      ? `All ${counted(preparedSources.length, "data source", "data sources")}`
      : null;
  return {
    activeTokenCount: tokenReadIncomplete ? 0 : activeTokenCount,
    allAppsHref: input.hrefs.grants,
    allAppsLink: !input.grantsFailed && input.grants.length >= HOME_GRANT_LIMIT,
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
