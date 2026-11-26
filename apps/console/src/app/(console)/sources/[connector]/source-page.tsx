import { sourceRecordCount, sourceStreamRecordCount } from "../../lib/source-record-count.ts";
import { sourceRecordLabel, isOwnerRecordKind } from "../../lib/source-record-label.ts";
import { SourceApps, SourceAppsList } from "./source-apps.tsx";
import { groupGrantAccessByApp } from "../../grants/app-access.ts";
import { buildAppPractice } from "../../grants/app-practice.ts";
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { buttonVariants, IcButton } from "@pdpp/brand-react";
import type { StreamManifestEntry } from "@pdpp/display";
import {
  formatConnectorKeyForDisplay,
  formatConnectorNameForDisplay,
  formatRelative,
  isFallbackConnectionLabel,
  isSetupFailedSource,
} from "@pdpp/display";
import { scheduleSentence } from "../../connect/status/[connectionId]/first-sync-outcome.ts";
import { classifyKnownGaps, normalizeKnownGaps } from "../../lib/run-gaps.ts";
import { listConnectionsByConnector } from "../../lib/ref-client.ts";
import { CopyButton } from "@pdpp/operator-ui/components/copy-button";
import { DataList, PageHeader, Section } from "@pdpp/operator-ui/components/primitives";
import { buildBreakdownLabel } from "@pdpp/operator-ui/lib/source-storage";
import { formatTotalRecordsLabel } from "../../lib/total-records-label.ts";
import { formatStorageBytes } from "@pdpp/operator-ui/lib/storage-footprint";
import Link from "next/link";
import { Suspense } from "react";
import type { ReactNode } from "react";
import { notFound, redirect } from "next/navigation";
import {
  canonicalConnectorKey,
  manualUploadSetupFromManifest,
  staticSecretCredentialCaptureFromManifest,
} from "pdpp-reference-implementation/connection-setup-plan";
import { ConnectorMark } from "@/app/(console)/components/connector-mark.tsx";
import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx";
import { ServerUnreachable } from "../../components/server-unreachable.tsx";
import {
  formatStreamCollectionFacts,
  indexCollectionReportByStream,
  runStatusWithCollectionReportGaps,
  type StreamCollectionFacts,
} from "../../lib/collection-report.ts";
import { getConnectionConfig, listConnectionConfigRevisions } from "../../lib/connection-config-client.ts";
import {
  type AutoPausedBanner,
  deriveAutoPausedBanner,
  summarizeOutboxStallRemediation,
  derivePrimaryRowAction,
  type PrimaryRowAction,
  syncActionIdleLabel,
} from "../../lib/connection-evidence.ts";
import { isBrowserSessionBoundConnection } from "../../lib/connection-modality.ts";
import { connectorInstallKey, isConnectorNotInstalled } from "../../lib/connector-implementation.ts";
import { connectorRunSummaryId, isActiveConnectorRunSummaryStatus } from "../../lib/connector-run-summary-status.ts";
import { getReferencePublicOrigin, ReferenceServerUnreachableError } from "../../lib/owner-token.ts";
import { isRevokedConnection } from "../../lib/records-list-classification.ts";
import {
  type DeviceSourceInstance,
  getConnectorSchedule,
  listDeviceExporterSourceInstances,
  type RefAcquisitionBatchSummary,
  type RefAcquisitionCoverageSummary,
  type RefCollectionReportEntry,
  type RefConnectionHealthSnapshot,
  type RefConnectorRunSummary,
  type RefConnectorSummary,
  type RefCoverageAsOf,
  type RefCoverageHorizon,
  type RefRenderedVerdict,
  type RefRequiredAction,
  type RefSchedule,
  type RunSummary,
} from "../../lib/ref-client.ts";
import {
  type ConnectorManifest,
  type ConnectorOverview,
  listConnectorManifests,
  type StreamSummary,
} from "../../lib/rs-client.ts";
import {
  hasPrimaryOwnerLocalDeviceRemediation,
  primaryOwnerActionRemediation,
  isSetupInProgressConnector,
  projectSourceActionability,
  type SourceStreamOwnerActionAvailability,
} from "../../lib/source-actionability.ts";
import { type SourceStatusAction, sourceStateSentence, sourceStatusWords, sourceNeverConnected } from "../../lib/source-status-words.ts";
import { connectorInstanceIdForConnection, resolveConnectionForRecordsRoute } from "../connection-route.ts";
import { findManifestForConnectorId } from "../lib/relationships.ts";
import { readConnectorUpdates } from "../connector-updates-read.ts";
import {
  pauseConnectionAction,
  resumeConnectionAction,
  resumeConnectorScheduleAction,
  resumeSetupConnectionAction,
} from "./actions.ts";
import { acknowledgeConnectionLossAction, confirmCoverageHorizonAction } from "./confirmation-actions.ts";
import type { ConfigRevisionWire, ConnectionConfigWire } from "./connection-config-view-model.ts";
import { ConnectionConfiguration, ConnectionSettingsHistory } from "./connection-configuration.tsx";
import { ConnectionConfirmation } from "./connection-confirmation.tsx";
import { DeviceSteps } from "./device-steps.tsx";
import { ConnectionDangerZone } from "./connection-danger-zone.tsx";
import { ConnectionDeviceRecoverySteps, ConnectionDiagnostics, ConnectionRecoverySummary, hasDeviceRecoverySteps } from "./connection-diagnostics.tsx";
import { ConnectorInstallPrompt } from "./connector-install-prompt.tsx";
import { AddAnotherAccount } from "./add-another-account.tsx";
import { RenameConnection } from "./rename-connection.tsx";
import { SourceStateSentenceText } from "./source-state-sentence.tsx";
import { StreamCollectionFactsLine } from "./stream-collection-facts.tsx";
import { SyncNowButton } from "./sync-now-button.tsx";
import { SourceUpdateSlot, type SourceUpdateModel } from "./source-update-section.tsx";
import { buildSourceUpdateModel } from "./source-update-view-model.ts";
import { connectionDisplayName } from "../../lib/connection-display-name.ts";



function addSourceHrefForConnector(connectorId: string): string {
  return `/sources/add?source_q=${encodeURIComponent(connectorId)}`;
}

function buildDemoSourceUpdate(shared: boolean): SourceUpdateModel {
  return {
    connectorKey: "claude-code",
    currentVersion: "1.4.0",
    otherSources: shared ? ["Claude Code personal", "Claude Code work"] : [],
    targetVersion: "1.5.0",
  };
}

function canStartSyncFromSummary(source: RefConnectorSummary): boolean {
  return source.source_kind !== "local_device" &&
    source.source_kind !== "manual" &&
    source.connector_implementation?.state !== "not_installed" &&
    source.status !== "paused" &&
    source.status !== "revoked" &&
    source.source_visibility !== "setup_failed" &&
    !source.revoked_at;
}

/**
 * Build the "Update credential" / "Repair" href for an existing static-secret
 * connection. Reuses the same setup form in replace-credential mode, preserving
 * connection_id, records, history, and schedule.
 */
function updateCredentialHref(connectorId: string, connectionId: string): string {
  const key = canonicalConnectorKey(connectorId);
  const params = new URLSearchParams({ connection_id: connectionId });
  return `/connect/static-secret/${encodeURIComponent(key)}?${params.toString()}`;
}

/**
 * Build the "Reconnect" href for a browser-bound connection that needs
 * re-authentication. Uses the browser-session connect page in repair mode
 * (?connectionId=<existing>), so the owner's records, history, and schedule
 * are preserved (Plaid update-mode equivalent).
 */
function browserSessionReconnectHref(connectorId: string, connectionId: string): string {
  const key = canonicalConnectorKey(connectorId);
  const params = new URLSearchParams({ connectionId });
  return `/connect/browser-session/${encodeURIComponent(key)}?${params.toString()}`;
}

function manualUploadHrefForConnection(
  connectorId: string,
  connectionId: string,
  manifest: ConnectorManifest
): string | null {
  const setup = manualUploadSetupFromManifest(manifest);
  if (!setup?.importDirEnvVar) {
    return null;
  }
  const connectorKey = canonicalConnectorKey(connectorId);
  const params = new URLSearchParams({ connection_id: connectionId });
  return `/connect/manual-upload/${encodeURIComponent(connectorKey)}?${params.toString()}`;
}

export interface ConnectorPageModel {
  activeRunId: string | null;
  initialDialog?: "reset" | "disconnect" | "delete";
  otherAccounts?: { connectionId: string; displayName: string }[];
  /**
   * Per-stream collection facts derived from the connection summary's
   * `collection_report`, keyed by stream name. Empty when the reference did not
   * return a report (a reference predating
   * `define-connector-progress-evidence-contract`), so the Streams section
   * renders exactly as before in that case.
   */
  collectionFactsByStream: Map<string, StreamCollectionFacts>;
  collectionOwnerActionByStream: SourceStreamOwnerActionAvailability;
  /** The attributed revision ledger, for the history timeline. */
  configRevisions: ConfigRevisionWire[];
  /**
   * The connection's live configuration read (active revision, options schema,
   * and the base a later propose must echo). `null` when the read failed — the
   * configuration panel then says so instead of the page failing.
   */
  configuration: ConnectionConfigWire | null;
  connectionHealth: RefConnectionHealthSnapshot | null;
  connectionId: string;
  /**
   * The owner-set `display_name` to seed the rename field, or "" when the
   * current label is a fallback (bare connector type / registry URL) so the
   * operator starts blank instead of re-typing a meaningless default.
   */
  connectionLabelSeed: string;
  connectionPrimaryAction: RefRequiredAction | null;
  connectionRenderedVerdict: RefRenderedVerdict | null;
  connectorId: string;
  /** Bare key the owner install route accepts for this source's connector. */
  connectorInstallKey: string;
  connectorInstanceId: string | null;
  /**
   * True when the reference reports no implementation to run this connector
   * (`connector_implementation.state: "not_installed"`). The page then says so
   * up front and offers Install, instead of letting Sync fail.
   */
  connectorNotInstalled: boolean;
  /** The run the connection's local coverage describes; `null` when none backs it. */
  coverageAsOf: RefCoverageAsOf | null;
  /** Current durable horizon disclosures from the reference owner projection. */
  coverageHorizons: readonly RefCoverageHorizon[];
  accountDeviceLabels: string[];
  deviceLabels: string[];
  displayName: string;
  headerCount: string;
  /** Latest-run structured gap evidence; never derived from rendered copy. */
  latestKnownGaps: readonly unknown[] | null | undefined;
  manifest: ConnectorManifest;
  manualUploadHref: string | null;
  overview: ConnectorOverview;
  /** Public reference origin, for resolving `<provider-url>` in remediation
   *  command templates. `null` when unavailable → command fails closed. */
  providerOrigin: string | null;
  recentRuns: RunSummary[];
  /**
   * Retained payload for this connection, already computed onto `overview`
   * (`retainedBytes` / `totalRetainedBytes`) and previously discarded. `null`
   * when the retained-bytes evidence is unobserved/stale/failed — the header
   * then omits the size rather than fabricating a `0 B`.
   */
  retainedStorage: { breakdown: string | null; total: string } | null;
  schedule: RefSchedule | null;
  scheduleError: string | null;
  setupFailed: boolean;
  /** Connection-scoped source-binding kind for binding-first repair routing. */
  sourceBindingKind: string | null;
  sourceInstances: DeviceSourceInstance[];
  sourceInstancesError: string | null;
  source: RefConnectorSummary;
  streams: StreamSummary[];
  totalRecords: number;
}

function toConnectorRunRef(summary: RefConnectorRunSummary | null) {
  const runId = connectorRunSummaryId(summary?.run_id);
  if (!(summary && runId)) {
    return null;
  }
  return {
    event_count: summary.event_count,
    failure_reason: summary.failure_reason,
    first_at: summary.first_at,
    known_gaps: summary.known_gaps ?? [],
    last_at: summary.last_at,
    run_id: runId,
    status: summary.status,
  };
}

function toRunSummaryForConnection(
  connectorId: string,
  connectionId: string,
  summary: RefConnectorRunSummary | null,
  collectionReport: readonly RefCollectionReportEntry[] | null | undefined
): RunSummary | null {
  if (!summary) {
    return null;
  }
  const runId = connectorRunSummaryId(summary.run_id);
  if (!runId) {
    return null;
  }
  const status = runStatusWithCollectionReportGaps(summary.status, collectionReport);
  return {
    connection_id: connectionId,
    connector_id: connectorId,
    connector_instance_id: connectionId,
    event_count: summary.event_count,
    failure_reason: summary.failure_reason,
    first_at: summary.first_at,
    grant_id: null,
    kinds: [],
    last_at: summary.last_at,
    needs_input: false,
    object: "run_summary",
    run_id: runId,
    status,
  };
}

function connectionRecentRuns(summary: RefConnectorSummary): RunSummary[] {
  // biome-ignore lint/suspicious/noUnnecessaryConditions: the receiver here is a genuinely optional/nullable type per its declared interface; tsc rejects removing this guard.
  const reportRunId = summary.last_run?.run_id ?? null;
  const collectionReport = summary.collection_report ?? null;
  const byId = new Map<string, RunSummary>();
  for (const run of [
    toRunSummaryForConnection(summary.connector_id, summary.connection_id, summary.last_run, collectionReport),
    toRunSummaryForConnection(
      summary.connector_id,
      summary.connection_id,
      summary.last_successful_run,
      summary.last_successful_run?.run_id === reportRunId ? collectionReport : null
    ),
  ]) {
    if (run) {
      byId.set(run.run_id, run);
    }
  }
  return Array.from(byId.values()).sort((a, b) => Date.parse(b.last_at) - Date.parse(a.last_at));
}

function toConnectorOverview(summary: RefConnectorSummary, streams: StreamSummary[]): ConnectorOverview {
  const lastRun = toConnectorRunRef(summary.last_run);
  const lastSuccessfulRun = toConnectorRunRef(summary.last_successful_run);
  return {
    acquisitionCoverage: summary.acquisition_coverage ?? null,
    collectionReport: summary.collection_report ?? null,
    connectionHealth: summary.connection_health,
    connectionId: summary.connection_id,
    connectionStatus: summary.status ?? null,
    connector: {
      connector_id: summary.connector_id,
      display_name: summary.display_name,
      name: summary.connector_display_name ?? summary.display_name,
      streams: summary.streams.map((name) => ({ name })),
    },
    connectorDisplayName: summary.connector_display_name,
    connectorInstanceId: summary.connector_instance_id ?? summary.connection_id,
    // biome-ignore lint/suspicious/noEqualsToNull: The source-shape regression test requires a nullish guard before reading the durable run status.
    isRunning: lastRun != null && isActiveConnectorRunSummaryStatus(lastRun.status),
    lastRun,
    lastSuccessfulRun,
    localDeviceProgress: summary.local_device_progress ?? null,
    retainedBytes: summary.retained_bytes ?? null,
    revokedAt: summary.revoked_at ?? null,
    streamCount: summary.stream_count,
    streams,
    totalRecords: summary.total_records,
    totalRecordsState: summary.total_records_state,
    totalRetainedBytes: summary.total_retained_bytes,
  };
}

function gapStreamNames(gap: unknown): string[] {
  if (typeof gap === "string") {
    return [gap];
  }
  if (!gap || typeof gap !== "object" || Array.isArray(gap)) {
    return [];
  }
  const row = gap as Record<string, unknown>;
  const scope = row.scope && typeof row.scope === "object" && !Array.isArray(row.scope) ? row.scope : null;
  return [row.stream, row.stream_id, row.parent_stream, scope && (scope as Record<string, unknown>).stream].filter(
    (candidate): candidate is string => typeof candidate === "string"
  );
}

function streamsFromConnectorSummary(summary: RefConnectorSummary): StreamSummary[] {
  const recordsByStream = new Map((summary.stream_records ?? []).map((record) => [record.stream, record]));
  const orderedNames = new Set<string>();
  const streams: StreamSummary[] = [];

  const pushStream = (name: string) => {
    if (orderedNames.has(name)) {
      return;
    }
    orderedNames.add(name);
    const record = recordsByStream.get(name);
    streams.push({
      count_state: record?.count_state,
      declaration_state: record?.declaration_state,
      last_updated: record?.last_updated ?? null,
      name,
      object: "stream",
      // An absent retained-size row is NOT zero: the server synthesizes
      // exact-zero rows whenever the retained-size projection is proven
      // fresh/clean, so absence means the count is currently unreliable.
      // A present row's own `record_count` can ALSO genuinely be `null`
      // (count_state: "unobserved"/"stale"/"unknown") — never coerced to a
      // fabricated 0 either.
      record_count: record ? record.record_count : null,
      retained_record_count: record?.retained_record_count,
    });
  };

  const pushGapStreams = (gaps: readonly unknown[] | null | undefined) => {
    for (const gap of gaps ?? []) {
      for (const name of gapStreamNames(gap)) {
        pushStream(name);
      }
    }
  };

  // Preserve manifest/source order for known streams, then append live-only
  // streams from the retained-size projection. Local collectors can retain
  // streams before the committed manifest catches up; hiding those rows makes
  // the owner think records disappeared.
  for (const name of summary.streams) {
    pushStream(name);
  }
  for (const record of summary.stream_records ?? []) {
    pushStream(record.stream);
  }
  // Collection facts include streams that were observed without a retained row;
  // the rendered verdict includes server-classified gap streams even when the
  // latest run did not retain a count row. Keep both evidence paths visible.
  for (const entry of summary.collection_report ?? []) {
    pushStream(entry.stream);
  }
  for (const entry of summary.rendered_verdict?.streams ?? []) {
    pushStream(entry.stream_id);
  }
  pushGapStreams(summary.last_run?.known_gaps);
  return streams;
}

export default async function ConnectorPage({
  params,
  searchParams,
}: {
  params: Promise<{ connector: string }>;
  searchParams: Promise<{
    active_run_id?: string;
    connection_id?: string;
    demo?: string;
    error?: string;
    message?: string;
  }>;
}) {
  const { connector } = await params;
  const routeId = decodeURIComponent(connector);
  const sp = await searchParams;

  let model: ConnectorPageModel;
  let addAnotherAccountAction: ReactNode;
  let otherAccounts: ReactNode;
  const practiceModel = process.env.NODE_ENV !== "production" && sp.demo ? (await import("./source-page-practice.ts")).buildSourcePracticeModel(sp.demo) : null;
  const updateDemo = practiceModel && (sp.demo === "update-ready" || sp.demo === "update-ready-shared") ? buildDemoSourceUpdate(sp.demo === "update-ready-shared") : null;
  if (practiceModel) {
    model = practiceModel;
    if (model.otherAccounts) otherAccounts = <OtherAccountsLine accounts={model.otherAccounts.filter((account) => account.connectionId !== model.connectionId && account.connectionId !== model.connectorInstanceId)} />;
  } else {
    try {
      model = await loadConnectorPageModel(routeId, sp.connection_id ?? null);
      otherAccounts = <Suspense fallback={null}><OtherAccounts connectionId={model.connectionId} connectorInstanceId={model.connectorInstanceId} connectorId={model.connectorId} /></Suspense>;
      addAnotherAccountAction = <Suspense fallback={null}><AddAnotherAccount connectorKey={model.connectorId} /></Suspense>;
    } catch (err) {
      if (err instanceof ReferenceServerUnreachableError) {
        return (
          <RecordroomShellWithPalette>
            <PageHeader title="Sources" />
            <ServerUnreachable />
          </RecordroomShellWithPalette>
        );
      }
      throw err;
    }
  }

  // Capture the server render instant so the diagnostics recovery panel can arm
  // its stall watchdog against real time. This page is `force-dynamic`, so the
  // instant is fresh on every request.
  const now = new Date().toISOString();
  const updates = practiceModel
    ? undefined
    : buildSourceUpdateModel(
        model.connectorId,
        connectionDisplayName(model.source.display_name, model.source.connector_display_name, model.source.connector_id),
        readConnectorUpdates
      );
  return (
    <ConnectorPageView
      addAnotherAccountAction={addAnotherAccountAction}
      dangerActiveRunId={sp.active_run_id}
      dangerError={sp.error}
      dangerMessage={sp.message}
      model={model}
      apps={practiceModel ? <SourceAppsList apps={sp.demo === "apps-some" ? groupGrantAccessByApp(buildAppPractice("one").registrations.map((app) => ({ ...app, sources: app.sources.map((row) => ({ ...row, source: { ...row.source, connection_id: model.connectionId, connector_id: model.connectorId, id: model.connectorId } })) }))) : []} connectionId={model.connectionId} /> : <Suspense fallback={null}><SourceApps connectionId={model.connectorInstanceId ?? model.connectionId} /></Suspense>}
      otherAccounts={otherAccounts}
      now={now}
      updateDemo={updateDemo}
      updates={updates}
      practiceState={practiceModel ? sp.demo : undefined}
    />
  );
}

export async function loadConnectorPageModel(
  routeId: string,
  explicitConnectionId?: string | null
): Promise<ConnectorPageModel> {
  const [summary, manifests] = await Promise.all([
    resolveConnectionForRecordsRoute(routeId, explicitConnectionId),
    listConnectorManifests(),
  ]);
  if (!summary) {
    notFound();
  }
  // A draft connection has no health/coverage/schedule evidence to render on
  // this detail page yet — its one durable status surface is
  // `/connect/status/:id`, which already resolves `draft` for both
  // static-secret and browser-enrollment-shell setup. Redirect here rather
  // than rendering a half-populated page, so direct/bookmarked navigation to
  // a fresh connection's `/sources/:id` lands the owner on the correct
  // "Continue setup" surface instead of a misleading empty detail view. Use
  // the resolved `connection_id`, not the raw route segment: `routeId` may be
  // a connector-key fallback (e.g. `/sources/gmail`), which setup-status does
  // not accept. See fix-pending-connection-discovery design.
  if (isSetupInProgressConnector(summary)) {
    redirect(`/connect/status/${encodeURIComponent(summary.connection_id)}`);
  }

  const connectorId = summary.connector_id;
  const connectionId = summary.connection_id;
  const connectorInstanceId = connectorInstanceIdForConnection(summary);
  const manifest =
    findManifestForConnectorId(manifests, connectorId) ??
    ({
      connector_id: connectorId,
      display_name: summary.connector_display_name ?? summary.display_name,
      name: summary.connector_display_name ?? summary.display_name,
      streams: summary.streams.map((name) => ({ name })),
    } satisfies ConnectorManifest);
  // The scoped connector summary already carries the retained-size read-model
  // stream projection. Do not call `/v1/streams` here: for high-volume local
  // sources that endpoint re-aggregates current records and has been measured
  // at ~4.5s on the owner detail route. The detail page is an owner/control
  // surface, so using the owner-only summary read-model is the SLVP construction
  // boundary: one cheap projection read, no duplicate expensive RS metadata read.
  const streams = streamsFromConnectorSummary(summary);
  // `connectorInstanceIdForConnection` already falls back to `connection_id`,
  // so this is the concrete instance selector the config routes resolve.
  const configConnectionId = connectorInstanceId;
  const [diagnostics, providerOrigin, configuration, configRevisions] = await Promise.all([
    loadConnectorDiagnostics(connectorId, connectorInstanceId),
    // Resolve the public origin to late-bind `<provider-url>` in remediation
    // command templates. Failure → null → the command fails closed (no broken
    // copy-paste command), never throws and breaks the page.
    getReferencePublicOrigin().catch(() => null),
    // Configuration reads join this existing phase rather than adding a serial
    // await — `page-performance.test.ts` pins that shape. Both degrade to null
    // on failure: a connector whose manifest declares a malformed
    // `options_schema` answers 400, and that must cost the owner the
    // configuration panel only, never the health and streams they opened this
    // page for.
    getConnectionConfig(configConnectionId).catch(() => null),
    listConnectionConfigRevisions(configConnectionId).catch(() => []),
  ]);
  const { schedule } = diagnostics;
  const overview = toConnectorOverview(summary, streams);
  const recentRuns = connectionRecentRuns(summary);
  const latestKnownGaps = summary.last_run?.known_gaps;
  const totalRecords = summary.total_records;
  // Per-stream collection facts from the reference's derived `collection_report`
  // (absent on references predating the field → empty map → Streams section
  // renders unchanged). Indexed by stream name to join with the resource-server
  // stream list below.
  const connectorNotInstalled = isConnectorNotInstalled(summary);
  const collectionFactsByStream = new Map<string, StreamCollectionFacts>();
  for (const [stream, entry] of indexCollectionReportByStream(summary.collection_report)) {
    collectionFactsByStream.set(
      stream,
      formatStreamCollectionFacts(entry, {
        connectorNotInstalled,
        coverageAsOf: summary.coverage_as_of ?? null,
      })
    );
  }
  const actionability = projectSourceActionability(summary);
  const collectionOwnerActionByStream = actionability.ownerActionByStream;
  const displayName = formatConnectorNameForDisplay({
    connectorId,
    displayName: manifest.display_name,
    name: manifest.name,
  });
  // Source instances surface the device(s) that fed this connection. For
  // filesystem-class collectors (claude-code, codex), the same connector
  // type can be active on multiple devices; without these labels, two
  // claude-code instances are visually indistinguishable.
  const { accountDeviceLabels, deviceLabels } = summarizeSourceInstancesForHeader(diagnostics.sourceInstances);
  const headerCount = formatTotalRecordsLabel(totalRecords, summary.total_records_state, "records");
  // The retained payload for this connection was already projected onto the
  // overview and then discarded by every renderer. Surface it in the header.
  // `total_retained_bytes` is `null` whenever the retained-bytes evidence is
  // unobserved/stale/failed, so absence hides the line rather than rendering
  // a fabricated `0 B`. This is a LOGICAL payload size — it is deliberately
  // not compared here against any physical on-disk figure.
  const retainedTotal = overview.totalRetainedBytes;
  const retainedStorage =
    typeof retainedTotal === "number" && Number.isFinite(retainedTotal) && retainedTotal >= 0
      ? { breakdown: buildBreakdownLabel(overview.retainedBytes), total: formatStorageBytes(retainedTotal) }
      : null;
  // Seed the rename field with the owner-set label only. A fallback label
  // (bare connector type / registry URL) seeds blank so the operator names
  // the connection from scratch rather than editing a meaningless default.
  const connectionLabelSeed = isFallbackConnectionLabel({
    connectorId,
    displayName: summary.display_name,
    name: summary.connector_display_name,
  })
    ? ""
    : (summary.display_name ?? "");

  return {
    activeRunId: schedule?.active_run_id ?? null,
    configRevisions,
    configuration,
    collectionFactsByStream,
    collectionOwnerActionByStream,
    connectionHealth: summary.connection_health ?? null,
    connectionId,
    connectionLabelSeed,
    connectionPrimaryAction: actionability.primaryAction,
    connectionRenderedVerdict: summary.rendered_verdict ?? null,
    connectorId,
    connectorInstallKey: connectorInstallKey(summary),
    connectorInstanceId,
    connectorNotInstalled,
    coverageAsOf: summary.coverage_as_of ?? null,
    coverageHorizons: summary.coverage_horizons ?? [],
    accountDeviceLabels,
    deviceLabels,
    displayName,
    headerCount,
    latestKnownGaps,
    manifest,
    manualUploadHref: manualUploadHrefForConnection(connectorId, connectionId, manifest),
    overview,
    providerOrigin,
    recentRuns,
    retainedStorage,
    // Connection-scoped binding kind, so repair routing is binding-first (a
    // browser-session connection reconnects its session, not a static secret).
    sourceBindingKind: summary.source_binding_kind ?? null,
    source: summary,
    setupFailed: isSetupFailedSource(summary),
    streams,
    totalRecords,
    ...diagnostics,
  };
}

async function loadConnectorDiagnostics(
  connectorId: string,
  connectorInstanceId: string | null
): Promise<{
  schedule: RefSchedule | null;
  scheduleError: string | null;
  sourceInstances: DeviceSourceInstance[];
  sourceInstancesError: string | null;
}> {
  let schedule: RefSchedule | null = null;
  let scheduleError: string | null = null;
  let sourceInstances: DeviceSourceInstance[] = [];
  let sourceInstancesError: string | null = null;

  // Diagnostics evidence. Each branch is independently failable so a
  // device-exporter outage cannot suppress schedule data, and vice versa.
  const [scheduleResult, sourcesResult] = await Promise.allSettled([
    getConnectorSchedule(connectorId, { connectorInstanceId: connectorInstanceId ?? undefined }),
    listDeviceExporterSourceInstances({ connector_instance_id: connectorInstanceId ?? undefined }),
  ]);
  if (scheduleResult.status === "fulfilled") {
    schedule = scheduleResult.value;
  } else {
    scheduleError = errorMessage(scheduleResult.reason);
  }
  if (sourcesResult.status === "fulfilled") {
    sourceInstances = sourcesResult.value.data.filter((s) => s.connector_id === connectorId);
  } else {
    sourceInstancesError = errorMessage(sourcesResult.reason);
  }

  return { schedule, scheduleError, sourceInstances, sourceInstancesError };
}

function resolveActiveRunNavigation(input: { overview: ConnectorOverview; scheduleActiveRunId: string | null }): {
  activeRunHref: string | null;
  running: boolean;
} {
  const activeRunId =
    input.scheduleActiveRunId ??
    (input.overview.isRunning && input.overview.lastRun ? input.overview.lastRun.run_id : null);
  return {
    activeRunHref: activeRunId ? `/syncs/${encodeURIComponent(activeRunId)}` : null,
    running: activeRunId !== null || input.overview.isRunning,
  };
}

function resolveCredentialUpdateHref({
  browserSessionRepairHref,
  sessionBound,
  storedCredentialUpdateHref,
}: {
  browserSessionRepairHref: string | null;
  sessionBound: boolean;
  storedCredentialUpdateHref: string | null;
}): string | null {
  if (sessionBound) {
    return browserSessionRepairHref;
  }
  if (storedCredentialUpdateHref !== null) {
    return storedCredentialUpdateHref;
  }
  return browserSessionRepairHref;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: this server view intentionally composes the detail evidence panels and their binding-aware actions in one owner-visible route.
function ConnectorPageView({
  addAnotherAccountAction,
  model,
  otherAccounts,
  apps,
  dangerActiveRunId,
  dangerMessage,
  dangerError,
  now,
  updateDemo,
  updates,
  practiceState,
}: {
  addAnotherAccountAction?: ReactNode;
  model: ConnectorPageModel;
  otherAccounts?: ReactNode;
  apps?: ReactNode;
  /** The run that blocked a delete, forwarded from the delete action redirect. */
  dangerActiveRunId?: string;
  dangerMessage?: string;
  dangerError?: string;
  /** Server render instant (ISO-8601) for the diagnostics recovery stall watchdog. */
  now: string;
  updateDemo: SourceUpdateModel | null;
  updates?: Promise<SourceUpdateModel | null>;
  practiceState?: string;
}) {
  const {
    activeRunId: scheduleActiveRunId,
    collectionFactsByStream,
    configRevisions,
    configuration,
    connectionHealth,
    connectionRenderedVerdict,
    connectionId,
    connectionPrimaryAction,
    connectorId,
    connectorInstallKey: installKey,
    connectorInstanceId,
    connectorNotInstalled,
    connectionLabelSeed,
    manifest,
    manualUploadHref,
    overview,
    recentRuns,
    schedule,
    setupFailed,
    sourceBindingKind,
    sourceInstances,
    source,
  } = model;
  const displayName = connectionDisplayName(source.display_name, source.connector_display_name, source.connector_id);
  const serviceName = source.connector_display_name ?? manifest.display_name ?? manifest.name ?? formatConnectorKeyForDisplay(connectorId);
  const { running } = resolveActiveRunNavigation({
    overview,
    scheduleActiveRunId,
  });
  const revoked = isRevokedConnection(overview);
  const paused = !revoked && overview.connectionStatus === "paused";
  // A revoked or never-set-up source has no sync to unblock, so the install
  // prompt only shows where installing lets the next run start.
  const installPromptShown = connectorNotInstalled && !revoked && !setupFailed;
  // Pause is offered only on a connection that is actually collecting. A
  // draft/revoked/already-paused row has nothing to pause, and the route would
  // answer `connector_instance_not_active` anyway.
  const neverConnected = sourceNeverConnected(source);
  const archived = source.source_visibility === "archived";
  const oneTime = source.source_kind === "manual" || source.rendered_verdict?.pill.label === "Import complete";
  const pausable = !(revoked || paused || archived || oneTime) && overview.connectionStatus === "active";
  // Stable rename selector: prefer the explicit instance id, fall back to the
  // connection id. Both address the same connection on the backend route.
  const renameSelector = connectorInstanceId ?? connectionId;
  // Connection-binding-first repair routing. A connection BOUND as a browser
  // session (`browser_collector`/`browser_enrollment_shell`) authenticates by
  // owner-authenticated browser session, so its repair is browser/session
  // repair — even when the connector ALSO supports a static-secret credential
  // (e.g. a ChatGPT connection that logs in via SSO through the browser). Only a
  // connection that is NOT browser-session-bound routes to static-secret capture.
  // The connection binding wins over the connector-level static-secret capability
  // and the manifest's browser-binding fact.
  const sessionBound = isBrowserSessionBoundConnection(sourceBindingKind);
  const staticSecretCapture = staticSecretCredentialCaptureFromManifest(manifest);
  const repairConnectionId = connectorInstanceId ?? connectionId;
  const storedCredentialUpdateHref =
    staticSecretCapture === null ? null : updateCredentialHref(connectorId, repairConnectionId);
  const manifestBrowserBound = Object.hasOwn(manifest?.runtime_requirements?.bindings ?? {}, "browser");
  const browserSessionRepairHref =
    sessionBound || manifestBrowserBound
      ? browserSessionReconnectHref(connectorId, repairConnectionId)
      : null;
  const credentialUpdateHref = resolveCredentialUpdateHref({
    browserSessionRepairHref,
    sessionBound,
    storedCredentialUpdateHref,
  });
  // biome-ignore lint/suspicious/noUnnecessaryConditions: the receiver here is a genuinely optional/nullable type per its declared interface; tsc rejects removing this guard.
  const primaryActionSurface = connectionPrimaryAction?.surface?.kind ?? null;
  // The detail-page primary action is modality-aware for the same reason the
  // records row is (`derivePrimaryRowAction`): existing owner-runnable
  // connections get Sync now, while push-mode local-collector connections render
  // non-clickable guidance because the dashboard cannot remotely pull from the
  // operator's device. Same shared classifier as the row: one source of truth,
  // no scattered string checks.
  const primaryAction = derivePrimaryRowAction({
    connectorId,
    hasLocalDeviceProgress: Boolean(overview.localDeviceProgress),
  });
  const syncIdleLabel = syncActionIdleLabel(overview.lastRun?.status);
  const scheduleSyncAvailable = connectionPrimaryAction?.kind === "reattach_schedule" && primaryAction.kind === "sync";
  const renderedAt = new Date(now);
  const pendingDetails = Boolean(connectionHealth?.detail_gap_backlog?.pending) ||
    [...collectionFactsByStream.values()].some((facts) => facts.pendingDetailGaps > 0);
  const signInRepairAvailable = credentialUpdateHref !== null;
  const sourceStatus = sourceStatusWords(source, { now: renderedAt, signInRepairAvailable });
  let stateSentence = sourceStateSentence(source, { now: renderedAt, name: serviceName, deviceName: sourceInstances[0]?.display_name ?? sourceInstances[0]?.local_binding_name, unsentRecords: sourceInstances[0]?.records_pending ?? undefined, pendingDetails, signInRepairAvailable });
  const pageStatusAction = sourceStatus.row === 8 && !connectionPrimaryAction ? canStartSyncFromSummary(source) ? { kind: "sync_now" as const, label: "Try again", filled: true } : null : sourceStatus.action; // never Resume for a local-device source: its paused action is "View this device"
  const devicePending = sourceInstances[0]?.records_pending ?? overview.localDeviceProgress?.records_pending;
  const hasDeviceLocalRemediation = !archived && devicePending !== 0 && (primaryActionSurface === "local_device" || hasPrimaryOwnerLocalDeviceRemediation(connectionRenderedVerdict) || (source.source_kind === "local_device" && sourceStatus.row === 8));
  const deviceStepsAvailable = hasDeviceRecoverySteps({ connectionHealth, localDeviceProgress: overview.localDeviceProgress ?? null, renderedVerdict: connectionRenderedVerdict, sourceInstances, connectionId: connectorInstanceId ?? connectionId, connectorId, providerOrigin: model.providerOrigin });
  const gaps = classifyKnownGaps(normalizeKnownGaps(model.latestKnownGaps)).coverageGaps;
  const partial = source.collection_report?.some((entry) => ["retryable_gap", "terminal_gap", "gaps", "partial"].includes(entry.coverage_condition)) || gaps.length > 0;
  const markedMissing = model.streams.some((stream) => gaps.some((gap) => gap.stream === stream.name) || source.collection_report?.some((entry) => entry.stream === stream.name && ["retryable_gap", "terminal_gap", "gaps", "partial"].includes(entry.coverage_condition)));
  if (hasDeviceLocalRemediation) {
    const device = sourceInstances[0];
    const deviceName = device?.display_name ?? device?.local_binding_name;
    const pending = device?.records_pending ?? overview.localDeviceProgress?.records_pending;
    stateSentence = { text: deviceStepsAvailable ? `The computer that holds this data${deviceName ? ` (${deviceName})` : ""} could not send${typeof pending === "number" ? ` ${pending.toLocaleString()} records` : " some records"}.` : `Open DataConnect on ${deviceName ?? "the computer that holds this data"} and look for a message about ${serviceName}.`, slot: null };
  } else if (!archived && running) {
    stateSentence = { text: "Syncing now.", slot: null };
  } else if (partial && markedMissing && [19, 20, 21].includes(sourceStatus.row)) {
    const when = sourceTimeLabel(source.connection_health.last_success_at ?? source.last_successful_run?.last_at);
    stateSentence = { text: `Synced${when ? ` ${when}` : ""}. Some of it didn't come.`, slot: null };
  } else if (([14, 15].includes(sourceStatus.row) && !markedMissing) || (partial && !markedMissing && [19, 20, 21].includes(sourceStatus.row))) {
    stateSentence = { text: `${serviceName} synced, but DataConnect could not copy some of it.`, slot: null };
  } else if (sourceStatus.row === 8 && !connectionPrimaryAction) {
    stateSentence = { text: `Something stopped ${serviceName} from syncing.`, slot: null };
  }
  const recordTotal = sourceRecordCount(source);
  const visibleTotal = recordTotal.count === null ? undefined : `${recordTotal.count.toLocaleString()} record${recordTotal.count === 1 ? "" : "s"}`;

  return (
    <RecordroomShellWithPalette>
      <PageHeader
        actions={
          hasDeviceLocalRemediation ? deviceStepsAvailable ? <DeviceSteps panelTargetId="source-device-steps">
            <ConnectionDeviceRecoverySteps connectionHealth={connectionHealth} localDeviceProgress={overview.localDeviceProgress ?? null} renderedVerdict={connectionRenderedVerdict} sourceInstances={sourceInstances} connectionId={connectorInstanceId ?? connectionId} connectorId={connectorId} providerOrigin={model.providerOrigin} />
          </DeviceSteps> : null : running ? null : <ConnectorHeaderActions
            browserSessionRepairHref={browserSessionRepairHref}
            canStartSync={!archived && canStartSyncFromSummary(source) && !(sourceStatus.row === 16 && sourceStatus.action === null)}
            connectionId={connectorInstanceId}
            connectorId={connectorId}
            credentialUpdateHref={credentialUpdateHref}
            displayName={serviceName}
            installPromptShown={installPromptShown}
            primaryAction={primaryAction}
            renderedAction={connectionPrimaryAction}
            running={running}
            installKey={installKey}
            routeConnectionId={connectionId}
            sourceInstances={sourceInstances}
            storedCredentialUpdateHref={storedCredentialUpdateHref}
            statusAction={archived || (devicePending === 0 && primaryActionSurface === "local_device") ? null : pageStatusAction}
          />
        }
        breadcrumbs={[{ href: "/sources", label: "Data sources" }]}
        count={neverConnected ? undefined : visibleTotal}
        description={undefined}
        title={
          <span>
            <span className="mr-2 inline-block align-middle [&_.pdpp-connector-icon]:size-12">
              <ConnectorMark connectorId={connectorId} icon={manifest.icon} name={displayName} />
            </span>
            {displayName}
          </span>
        }
      />

      {otherAccounts}
      <SourceStateSentenceText connectionId={connectionId} sentence={stateSentence} status={sourceStatus} />

      <div className="min-w-0 max-w-full" id="source-device-steps" />

      {!/synced|syncing|imported|last updated|last successful sync/i.test(stateSentence.text) && sourceTimeLabel(source.connection_health.last_success_at ?? source.last_successful_run?.last_at) ? <p className="pdpp-body mb-6 text-muted-foreground">Last updated {sourceTimeLabel(source.connection_health.last_success_at ?? source.last_successful_run?.last_at)}.</p> : null}
      <Suspense fallback={null}>
        <SourceUpdateSlot demoModel={updateDemo} displayName={serviceName} updates={updates} version={null} />
      </Suspense>
      {!neverConnected ? <Section action={<Link className="text-primary hover:underline" href="/explore">Browse records</Link>} title="What is here">
        <SourceRecords model={model} />
        {recordTotal.conflicting ? <p className="pdpp-body mt-3 text-muted-foreground">DataConnect can't yet tell whether it got everything.</p> : null}
        {manualUploadHref ? <div className="mt-3 flex flex-wrap gap-3">
          <Link className={buttonVariants({ size: "sm", variant: "ghost" })} href={manualUploadHref}>Add another export</Link>
          <SyncNowButton connectionId={connectorInstanceId ?? connectionId} connectorId={connectorId} displayName={displayName} installPromptShown={installPromptShown} idleLabel="Read the files again" initialRunning={running} runningLabel="Reading the files" title="Reads the files already uploaded for this data source again." variant="outline" />
        </div> : null}
      </Section> : null}
      {apps}
      {!neverConnected && !archived && !oneTime ? <ScheduleSummary displayName={serviceName} schedule={schedule} scheduleError={model.scheduleError} sourceInstances={sourceInstances} now={renderedAt} disconnected={revoked} paused={paused} /> : null}
      <RecentRunsSection recentRuns={recentRuns.filter((run) => !["pending", "started", "in_progress", "running"].includes(run.status))} />
          {configuration && !neverConnected ? (
            <ConnectionConfiguration
              config={configuration}
              connectionId={connectorInstanceId ?? connectionId}
              connectorId={connectorId}
              revisions={configRevisions}
            />
          ) : null}
          <Section title="Manage">
            {!neverConnected ? <RenameConnection
              connectionId={renameSelector}
              currentLabel={connectionLabelSeed}
              typeName={formatConnectorKeyForDisplay(connectorId)}
            /> : null}
            {revoked && !neverConnected ? <p className="mt-5"><Link className={buttonVariants({ size: "sm", variant: "ghost" })} href={addSourceHrefForConnector(connectorId)}>Set up again</Link></p> : null}
            {scheduleSyncAvailable ? ( <SyncNowButton connectionId={connectorInstanceId ?? connectionId} connectorId={connectorId} displayName={displayName} installPromptShown={installPromptShown} idleLabel={syncIdleLabel} initialRunning={running} variant="outline" /> ) : null}
            {pausable ? <PauseConnectionSection connectionId={renameSelector} /> : null}
            <CredentialRepairLinks
              revoked={revoked}
              setupFailed={setupFailed || archived}
              storedCredentialUpdateHref={credentialUpdateHref}
              hasStaticSecretCredentialUpdate={credentialUpdateHref !== null && primaryActionSurface !== "stored_credential" && primaryActionSurface !== "browser_session"}
            />
            {!neverConnected && !revoked ? addAnotherAccountAction : null}
            <ConnectionDangerZone
              activeRunId={dangerActiveRunId ?? scheduleActiveRunId}
              connectionId={connectorInstanceId ?? connectionId}
              displayName={displayName}
              initialDialog={model.initialDialog}
              error={dangerError}
              message={dangerMessage ? "Done." : undefined}
              setupFailed={setupFailed}
              inactive={revoked || archived || oneTime}
              neverConnected={neverConnected}
            />
          </Section>

      <p className="mb-8 text-sm text-muted-foreground"><Link className="underline underline-offset-4 hover:text-foreground" href={`/sources/${encodeURIComponent(connectionId)}/technical${practiceState ? `?demo=${encodeURIComponent(practiceState)}` : ""}`}>Technical details</Link></p>
    </RecordroomShellWithPalette>
  );
}

function SourceRecords({ model }: { model: ConnectorPageModel }) {
  const { connectionId, source, manifest } = model;
  const streams = model.streams.filter(stream => isOwnerRecordKind(stream.name));
  const gaps = classifyKnownGaps(normalizeKnownGaps(model.latestKnownGaps)).coverageGaps;
  const label = (name: string) => sourceRecordLabel(name, manifest.streams as StreamManifestEntry[]);
  const missing = streams.filter((stream) => sourceStreamRecordCount(stream) === 0 && (gaps.some((gap) => gap.stream === stream.name) || source.collection_report?.some((entry) => entry.stream === stream.name && ["terminal_gap", "retryable_gap"].includes(entry.coverage_condition))));
  const empty = streams.filter((stream) => sourceStreamRecordCount(stream) === 0 && !missing.includes(stream));
  const present = streams.filter((stream) => !missing.includes(stream) && !empty.includes(stream));
  return <>
    {present.length ? <DataList>{present.map((stream) => {
      const report = source.collection_report?.find((entry) => entry.stream === stream.name);
      const gap = gaps.find((item) => item.stream === stream.name);
      const partial = Boolean(gap) || Boolean(report && ["retryable_gap", "terminal_gap", "gaps", "partial"].includes(report.coverage_condition));
      const more = report ? report.forward_disposition === "resumable" : gap?.recovery_hint?.retryable === true;
      const lost = report?.coverage_condition === "terminal_gap" && report.forward_disposition === "terminal";
      const recordCount = sourceStreamRecordCount(stream);
      const count = recordCount === null ? null : `${recordCount.toLocaleString()} record${recordCount === 1 ? "" : "s"}`;
      const sentence = partial
        ? more ? `${recordCount === null ? "" : `${recordCount.toLocaleString()} so far. `}More at the next sync.` : lost ? `${count ? `${count}. ` : ""}Some could not be copied.` : count
        : count;
      const newest = recordCount === 0 ? null : recordDateLabel(stream.last_updated);
      const cause = gap ? "DataConnect could not copy this." : null;
      return <li key={stream.name}>
        <Link className="flex flex-col gap-1 px-3 py-3 transition-colors hover:bg-muted/40 sm:flex-row sm:items-center sm:justify-between sm:gap-4" href={`/sources/${encodeURIComponent(connectionId)}/${encodeURIComponent(stream.name)}`}>
          <span className="flex min-w-0 flex-col gap-1">
            <span className="pdpp-body text-foreground">{label(stream.name)}</span>
            {sentence || newest ? <span className="pdpp-caption text-muted-foreground">{sentence}{sentence && newest ? " · " : ""}{newest ? `newest ${newest}` : ""}</span> : null}
            {partial && !more && cause ? <span className="pdpp-caption text-muted-foreground">{cause}</span> : null}
          </span>
        </Link>
      </li>;
    })}</DataList> : null}
    {empty.length ? <p className="pdpp-body mt-3 text-muted-foreground">Nothing in: {empty.slice(0, 3).map((stream) => label(stream.name)).join(", ")}{empty.length > 3 ? ` and ${empty.length - 3} more` : ""}.</p> : null}
    {missing.length ? <>
      <h3 className="pdpp-eyebrow mt-4">Didn't come</h3>
      <DataList ariaLabel="Didn't come">{missing.map((stream) => {
        const relevant = gaps.filter((gap) => gap.stream === stream.name);
        const message = "DataConnect could not copy this.";
        return <li className="flex flex-col gap-1 px-3 py-3" key={stream.name}>
          <span className="text-foreground">{label(stream.name)}</span>
          <span className="pdpp-caption text-muted-foreground">{message}{relevant.some((gap) => gap.recovery_hint?.retryable === true) ? ` It will try again the next time DataConnect checks ${source.connector_display_name ?? manifest.display_name ?? manifest.name}.` : ""}</span>
        </li>;
      })}</DataList>
    </> : null}
  </>;
}

function recordDateLabel(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const today = new Date();
  const days = Math.floor((Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()) - Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())) / 86_400_000);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days > 1 && days <= 7) return `${days} days ago`;
  return sourceDateLabel(value);
}

async function OtherAccounts({ connectionId, connectorInstanceId, connectorId }: { connectionId: string; connectorInstanceId: string | null; connectorId: string }) {
  const accounts = await listConnectionsByConnector(connectorId).catch(() => []);
  const others = accounts.filter((account) => account.connector_instance_id !== connectionId && account.connector_instance_id !== connectorInstanceId && account.status !== "revoked");
  if (others.length === 0) return null;
  return <OtherAccountsLine accounts={others.map((account) => ({ connectionId: account.connector_instance_id, displayName: connectionDisplayName(account.display_name, null, connectorId) }))} />;
}

function OtherAccountsLine({ accounts }: { accounts: readonly { connectionId: string; displayName: string }[] }) {
  if (accounts.length === 0) return null;
  return <p className="mb-6 text-sm text-muted-foreground">Also connected: {accounts.map((account, index) => <span key={account.connectionId}>
    {index ? ", " : ""}<Link className="underline underline-offset-4 hover:text-foreground" href={`/sources/${encodeURIComponent(account.connectionId)}`}>{account.displayName}</Link>
  </span>)}</p>;
}

export function SourceTechnicalDetails({ model, now, dangerError, dangerMessage }: {
  model: ConnectorPageModel;
  now: string;
  dangerError?: string;
  dangerMessage?: string;
}) {
  const { connectionId, connectorId, connectorInstanceId, deviceLabels, manifest, retainedStorage,
    recentRuns, schedule, connectionHealth, overview, connectionRenderedVerdict, sourceInstances,
    coverageHorizons, latestKnownGaps, streams, collectionFactsByStream, collectionOwnerActionByStream,
    connectorNotInstalled, coverageAsOf, providerOrigin, scheduleError, sourceInstancesError,
    configRevisions, configuration, displayName } = model;
  const primaryAction = derivePrimaryRowAction({ connectorId, hasLocalDeviceProgress: Boolean(overview.localDeviceProgress) });
  const { running } = resolveActiveRunNavigation({ overview, scheduleActiveRunId: model.activeRunId });
  const installPromptShown = connectorNotInstalled && !isRevokedConnection(overview) && !model.setupFailed;
  const autoPausedBanner = deriveAutoPausedBanner(schedule);
  return <>
    {latestKnownGaps?.length ? <details className="mb-4 min-w-0 max-w-full" data-testid="raw-source-errors">
      <summary className="cursor-pointer text-sm text-muted-foreground">What went wrong</summary>
      <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words text-xs">{JSON.stringify(latestKnownGaps, null, 2)}</pre>
    </details> : null}
    {autoPausedBanner ? <div data-testid="auto-paused-banner"><AutoPausedBannerRow banner={autoPausedBanner} connectorId={connectorId} /></div> : null}
            <div className="pt-4">
              <ConnectionIdentityLine
                connectionId={connectionId}
                connectorId={connectorId}
                deviceLabels={deviceLabels}
                providerId={manifest.provider_id ?? null}
              />
              {retainedStorage ? <p className="mt-2 text-sm text-muted-foreground">{retainedStorage.total} retained</p> : null}
              <p className="mt-2 text-sm text-muted-foreground">Connector: {formatConnectorKeyForDisplay(connectorId)}</p>
              {model.source.manifest_version ? <p className="mt-2 text-sm text-muted-foreground">Version {model.source.manifest_version}</p> : null}
              {recentRuns.some((sync) => sync.failure_reason || typeof sync.event_count === "number") ? (
                <details className="mt-4 border-t border-border pt-3" data-testid="sync-details">
                  <summary className="cursor-pointer text-sm text-muted-foreground">Sync details</summary>
                  <ul className="mt-2 flex flex-col gap-2">
                    {recentRuns.filter((sync) => sync.failure_reason || typeof sync.event_count === "number").map((sync) => (
                      <li className="text-sm" key={sync.run_id}>
                        <span>{sourceTimeLabel(sync.first_at) ?? "Time unavailable"}: </span>
                        {typeof sync.event_count === "number" ? <span>{sync.event_count.toLocaleString()} events. </span> : null}
                        {sync.failure_reason ? <code className="break-words font-mono text-xs">{sync.failure_reason}</code> : null}
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
              {schedule?.scheduler_backoff?.reason_class ? (
                <p className="mt-3 text-sm text-muted-foreground" data-testid="auto-pause-reason">
                  <code className="break-words font-mono text-xs">{schedule.scheduler_backoff.reason_class}</code>
                </p>
              ) : null}
              <ConnectionRecoverySummary
                connectionHealth={connectionHealth}
                localDeviceProgress={overview.localDeviceProgress ?? null}
                now={now}
                renderedVerdict={connectionRenderedVerdict}
                sourceInstances={sourceInstances}
              />
              <AcquisitionCoverageSection
                connectionId={connectorInstanceId ?? connectionId}
                coverage={overview.acquisitionCoverage ?? null}
              />
              <ConnectionConfirmation
                acknowledgeConnectionLossAction={acknowledgeConnectionLossAction}
                acknowledgedLoss={connectionRenderedVerdict?.detail.acknowledged_loss ?? null}
                confirmCoverageHorizonAction={confirmCoverageHorizonAction}
                connectionId={connectorInstanceId ?? connectionId}
                error={dangerError}
                latestKnownGaps={latestKnownGaps}
                message={dangerMessage ? "Done." : undefined}
                pendingHorizons={coverageHorizons}
              />
              {primaryAction.kind === "cooldown_wait" ? (
                <Section title="Sync options">
                  <p className="mb-2 text-sm text-muted-foreground">The next attempt is delayed.</p>
                  <CooldownPrimaryAction
                    action={primaryAction}
                    connectionId={connectorInstanceId ?? connectionId}
                    connectorId={connectorId}
                    displayName={displayName}
                    installPromptShown={installPromptShown}
                    running={running}
                  />
                </Section>
              ) : null}
              {streams.map((stream) => {
                const facts = collectionFactsByStream.get(stream.name) ?? null;
                return facts ? (
                  <StreamCollectionFactsLine
                    facts={facts}
                    key={stream.name}
                    ownerActionAvailable={collectionOwnerActionByStream[stream.name] ?? true}
                  />
                ) : null;
              })}
              <ConnectionDiagnostics
                connectionHealth={connectionHealth}
                connectionId={connectorInstanceId ?? connectionId}
                connectorId={connectorId}
                connectorNotInstalled={connectorNotInstalled}
                coverageAsOf={coverageAsOf}
                localDeviceProgress={overview.localDeviceProgress ?? null}
                now={now}
                providerOrigin={providerOrigin}
                renderedVerdict={connectionRenderedVerdict}
                schedule={schedule}
                scheduleError={scheduleError}
                showRecoverySummary={false}
                sourceInstances={sourceInstances}
                sourceInstancesError={sourceInstancesError}
              />
            </div>

    {configuration ? <ConnectionSettingsHistory config={configuration} revisions={configRevisions} /> : null}
  </>;
}

function ConnectorHeaderActions({
  browserSessionRepairHref,
  canStartSync,
  connectionId,
  connectorId,
  credentialUpdateHref,
  displayName,
  installPromptShown,
  installKey,
  primaryAction,
  renderedAction,
  running,
  storedCredentialUpdateHref,
  routeConnectionId,
  sourceInstances,
  statusAction,
}: {
  browserSessionRepairHref: string | null;
  canStartSync: boolean;
  connectionId: string | null;
  connectorId: string;
  credentialUpdateHref: string | null;
  displayName: string;
  installPromptShown: boolean;
  installKey: string;
  primaryAction: PrimaryRowAction;
  renderedAction: RefRequiredAction | null;
  running: boolean;
  storedCredentialUpdateHref: string | null;
  routeConnectionId: string;
  sourceInstances: DeviceSourceInstance[];
  statusAction: SourceStatusAction | null;
}) {
  return (
    <div className="flex flex-wrap items-start gap-2">
      <ConnectorPrimaryHeaderAction
        browserSessionRepairHref={browserSessionRepairHref}
        canStartSync={canStartSync}
        connectionId={connectionId}
        connectorId={connectorId}
        credentialUpdateHref={credentialUpdateHref}
        displayName={displayName}
        installPromptShown={installPromptShown}
        installKey={installKey}
        primaryAction={primaryAction}
        renderedAction={renderedAction}
        running={running}
        storedCredentialUpdateHref={storedCredentialUpdateHref}
        routeConnectionId={routeConnectionId}
        sourceInstances={sourceInstances}
        statusAction={statusAction}
      />
    </div>
  );
}

function ConnectorPrimaryHeaderAction({
  browserSessionRepairHref,
  canStartSync,
  connectionId,
  connectorId,
  credentialUpdateHref,
  displayName,
  installPromptShown,
  installKey,
  primaryAction,
  renderedAction,
  running,
  storedCredentialUpdateHref,
  sourceInstances,
  routeConnectionId,
  statusAction,
}: {
  browserSessionRepairHref: string | null;
  canStartSync: boolean;
  /** The route's connection id; `resumeSetupConnectionAction` matches on `connection_id`. */
  routeConnectionId: string;
  connectionId: string | null;
  connectorId: string;
  credentialUpdateHref: string | null;
  displayName: string;
  installPromptShown: boolean;
  installKey: string;
  primaryAction: PrimaryRowAction;
  renderedAction: RefRequiredAction | null;
  running: boolean;
  storedCredentialUpdateHref: string | null;
  sourceInstances: DeviceSourceInstance[];
  statusAction: SourceStatusAction | null;
}) {
  const renderedOwnerAction =
    renderedAction && renderedAction.audience === "owner" && renderedAction.satisfied_when.kind !== "none"
      ? renderedAction
      : null;

  if (statusAction?.kind === "server_cta" && renderedOwnerAction) {
    return (
      <RenderedVerdictHeaderAction
        action={renderedOwnerAction}
        label={statusAction.label}
        browserSessionRepairHref={browserSessionRepairHref}
        connectionId={connectionId}
        connectorId={connectorId}
        credentialUpdateHref={credentialUpdateHref}
        displayName={displayName}
        filled={statusAction.filled}
        installPromptShown={installPromptShown}
        running={running}
        storedCredentialUpdateHref={storedCredentialUpdateHref}
      />
    );
  }
  if (statusAction?.kind === "sync_now") {
    return (
      <SyncNowButton
        connectionId={connectionId}
        connectorId={connectorId}
        displayName={displayName}
        installPromptShown={installPromptShown}
        idleLabel={statusAction.label}
        initialRunning={running}
        variant={statusAction.filled ? "default" : "outline"}
      />
    );
  }
  if (statusAction?.kind === "set_up_again") {
    return <Link className={buttonVariants({ size: "sm", variant: "ghost" })} href={addSourceHrefForConnector(connectorId)}>Set up again</Link>;
  }
  if (statusAction?.kind === "resume") {
    return <ResumeConnectionButton connectionId={connectionId} label={statusAction.label} />;
  }
  if (statusAction?.kind === "repair_sign_in") {
    return <Link className={buttonVariants({ size: "sm", variant: "ghost" })} href={browserSessionRepairHref ?? storedCredentialUpdateHref ?? credentialUpdateHref ?? addSourceHrefForConnector(connectorId)}>{statusAction.label}</Link>;
  }
  if (statusAction?.kind === "repair_credential" && credentialUpdateHref) {
    return <Link className={buttonVariants({ size: "sm", variant: "ghost" })} href={credentialUpdateHref}>{statusAction.label}</Link>;
  }
  if (statusAction?.kind === "continue_setup") {
    return <form action={resumeSetupConnectionAction}><input name="connection_id" type="hidden" value={routeConnectionId} /><IcButton size="sm" type="submit" variant={statusAction.filled ? "default" : "ghost"}>{statusAction.label}</IcButton></form>;
  }
  if (statusAction?.kind === "install") {
    return <ConnectorInstallPrompt actionLabel={statusAction.label} connectorKey={installKey} displayName={displayName} routeId={connectionId ?? connectorId} variant="inline" />;
  }
  if (statusAction?.kind === "view_device") {
    const device = sourceInstances[0];
    return device ? <Link className="text-sm text-primary hover:underline" href={`/device-exporters#${encodeURIComponent(device.device_id)}`}>View this device</Link> : null;
  }
  if (statusAction?.kind === "review_setup" || statusAction?.kind === "retry_first_sync" || statusAction?.kind === "review_result") {
    return renderedOwnerAction ? (
      <RenderedVerdictHeaderAction action={renderedOwnerAction} browserSessionRepairHref={browserSessionRepairHref} connectionId={connectionId} connectorId={connectorId} credentialUpdateHref={credentialUpdateHref} displayName={displayName} filled={statusAction.filled} installPromptShown={installPromptShown} label={statusAction.label} running={running} storedCredentialUpdateHref={storedCredentialUpdateHref} />
    ) : statusAction.kind === "retry_first_sync" ? (
      <SyncNowButton
        connectionId={connectionId}
        connectorId={connectorId}
        displayName={displayName}
        installPromptShown={installPromptShown}
        idleLabel={statusAction.label}
        initialRunning={running}
        variant={statusAction.filled ? "default" : "outline"}
      />
    ) : null;
  }
  // During a source-pressure cooldown the ordinary sync waits; the page keeps
  // only the named "Force run anyway" override in Sync options.
  if (statusAction === null && canStartSync && primaryAction.kind === "sync") {
    return <SyncNowButton connectionId={connectionId} connectorId={connectorId} displayName={displayName} installPromptShown={installPromptShown} idleLabel="Sync now" initialRunning={running} variant="outline" />;
  }
  if (statusAction === null && primaryAction.kind === "device_wait") {
    return null;
  }
  return null;
}

function ResumeConnectionButton({ connectionId, label }: { connectionId: string | null; label: string }) {
  return <form action={resumeConnectionAction}><input name="connection_id" type="hidden" value={connectionId ?? ""} /><IcButton size="sm" type="submit" variant="ghost">{label}</IcButton></form>;
}

function reauthActionPresentation({
  action,
  browserSessionRepairHref,
  connectorId,
  credentialUpdateHref,
  storedCredentialUpdateHref,
}: {
  action: RefRequiredAction;
  browserSessionRepairHref: string | null;
  connectorId: string;
  credentialUpdateHref: string | null;
  storedCredentialUpdateHref: string | null;
}): { href: string; label: string; title: string } {
  const fallbackHref = credentialUpdateHref ?? addSourceHrefForConnector(connectorId);
  switch (action.surface?.kind) {
    case "stored_credential":
      return {
        href: storedCredentialUpdateHref ?? fallbackHref,
        label: "Update credential",
        title: "Replace this data source's sign-in details. Records, sync history, and schedule are kept.",
      };
    case "browser_session":
      return {
        href: browserSessionRepairHref ?? fallbackHref,
        label: action.cta,
        title: "Open the secure sign-in session for this data source. Records, sync history, and schedule are kept.",
      };
    case "provider_interaction":
      // The interaction dock lives on the RUN, not the connection: a provider
      // interaction (OTP, CAPTCHA, device approval, manual sign-in) can only be
      // completed while that run is still waiting, and the run's assistance
      // window expires. Without this case the chip fell to `default` and sent
      // the owner to the add-source page — a live "Complete the requested
      // action" prompt that led away from the only surface that could satisfy
      // it, while the run timed out. `target.run_id` is already on the action
      // (`exactSyncTargetFromAttention`), so the destination needs no new data.
      return {
        href:
          action.target?.kind === "sync" && action.target.run_id
            ? `/syncs/${encodeURIComponent(action.target.run_id)}/stream`
            : fallbackHref,
        label: action.cta,
        title: "Open the active sync and complete the step this provider is waiting on.",
      };
    default:
      return {
        href: fallbackHref,
        label: action.cta,
        title: "Repair this data source while keeping its records, sync history, and schedule when supported.",
      };
  }
}

function RenderedVerdictHeaderAction({
  action,
  browserSessionRepairHref,
  connectionId,
  connectorId,
  credentialUpdateHref,
  displayName,
  filled,
  installPromptShown,
  label,
  running,
  storedCredentialUpdateHref,
}: {
  action: RefRequiredAction;
  browserSessionRepairHref: string | null;
  connectionId: string | null;
  connectorId: string;
  credentialUpdateHref: string | null;
  displayName: string;
  filled: boolean;
  installPromptShown: boolean;
  label?: string;
  running: boolean;
  storedCredentialUpdateHref: string | null;
}) {
  if (action.audience !== "owner" || action.satisfied_when.kind === "none") {
    return null;
  }
  if (action.kind === "reauth") {
    const repair = reauthActionPresentation({
      action,
      browserSessionRepairHref,
      connectorId,
      credentialUpdateHref,
      storedCredentialUpdateHref,
    });
    return (
      <Link
        className={buttonVariants({ size: "sm", variant: filled ? "default" : "ghost" })}
        data-testid="detail-action-rendered-verdict"
        href={repair.href}
        title={repair.title}
      >
        {label ?? repair.label}
      </Link>
    );
  }
  if (action.kind === "add_info") {
    // A device-local recovery (stalled outbox: the owner runs commands on the
    // host that holds the data) is NOT navigable — there is nothing to click in
    // the dashboard, because the dashboard cannot run a command on the owner's
    // device. Linking it to /runs sends the owner in a circle (detail → runs →
    // detail) chasing a button that can't act. Render it as non-clickable
    // guidance that points to the recovery commands in the diagnostics panel
    // below, the only place the owner can actually act.
    // biome-ignore lint/suspicious/noUnnecessaryConditions: the receiver here is a genuinely optional/nullable type per its declared interface; tsc rejects removing this guard.
    if (action.remediation?.target.kind === "local_device") {
      return <p className="pdpp-body text-muted-foreground">Check DataConnect on the computer that holds this data for a message about what stopped this data source.</p>;
    }
    // A non-device add_info is only clickable when the server attached a
    // validated exact sync target from structured attention. Otherwise the
    // action remains plain text; the console must not invent a generic
    // /syncs fallback for a connection-scoped owner prompt.
    if (action.target?.kind !== "sync") {
      return (
        <span
          className="pdpp-caption max-w-[18rem] text-right text-muted-foreground"
          data-testid="detail-action-rendered-verdict"
        >
          {label ?? action.cta}
        </span>
      );
    }
    // A validated sync target is NOT enough on its own: the run must still be
    // waiting. `exactSyncTargetFromAttention` reads `run_id` off the attention
    // record with no liveness check, and an `expired` record keeps its `run_id`
    // forever — so a concluded run still produced a `/syncs/<id>` link. The
    // owner clicked "Complete the requested action" and nothing happened,
    // because the run that owned the interaction had already ended and taken
    // the interaction with it (production, ChatGPT alex.roe@example.com: three
    // consecutive `expired` attention records, each still carrying a run id).
    //
    // With no live run there is nothing to complete. The honest destination is
    // the surface that can re-establish the session so a NEW run can ask again.
    if (!running) {
      return browserSessionRepairHref === null ? (
        <span
          className="pdpp-caption max-w-[18rem] text-right text-muted-foreground"
          data-action-stale-target="true"
          data-testid="detail-action-rendered-verdict"
        >
          {label ?? action.cta} — no sync is waiting right now
        </span>
      ) : (
        <Link
          className={buttonVariants({ size: "sm", variant: filled ? "default" : "ghost" })}
          data-action-stale-target="true"
          data-testid="detail-action-rendered-verdict"
          href={browserSessionRepairHref}
          title="No sync is waiting right now. Open the secure browser session to sign in again; the next sync will pick up from there."
        >
          {label ?? action.cta}
        </Link>
      );
    }
    return (
      <Link
        className={buttonVariants({ size: "sm", variant: filled ? "default" : "ghost" })}
        data-testid="detail-action-rendered-verdict"
        href={`/syncs/${encodeURIComponent(action.target.run_id)}`}
      >
        {label ?? action.cta}
      </Link>
    );
  }
  if (action.kind === "reattach_schedule") {
    // Resume remains the primary action that satisfies
    // `schedule_attached_and_enabled`. An owner-runnable connection can also
    // sync once without re-enabling its automatic schedule.
    return (
      <form action={resumeConnectorScheduleAction}>
        <input name="connector_id" type="hidden" value={connectorId} />
        {connectionId ? <input name="connection_id" type="hidden" value={connectionId} /> : null}
        <IcButton data-testid="detail-action-reattach-schedule" size="sm" type="submit" variant={filled ? "default" : "ghost"}>
          {label ?? action.cta}
        </IcButton>
      </form>
    );
  }
  return (
    <SyncNowButton
      connectionId={connectionId}
      connectorId={connectorId}
      displayName={displayName}
      installPromptShown={installPromptShown}
      idleLabel={label ?? action.cta}
      initialRunning={running}
      runningLabel="Repair running"
      title="Starts a sync for this data source to satisfy the server's required action."
      variant={filled ? "default" : "outline"}
    />
  );
}

function AcquisitionCoverageSection({
  connectionId,
  coverage,
}: {
  connectionId: string;
  coverage: RefAcquisitionCoverageSummary | null;
}) {
  const batches = coverage?.recent_batches ?? [];
  if (batches.length === 0) {
    return null;
  }
  return (
    <Section
      description="Recent imports and device transfers, including repeated files, older exports, and missing media."
      title="What was collected"
    >
      <DataList ariaLabel="Collected batches">
        {batches.map((batch, index) => (
          <AcquisitionBatchRow batch={batch} connectionId={connectionId} key={batch.batch_id} latest={index === 0} />
        ))}
      </DataList>
    </Section>
  );
}

function AcquisitionBatchRow({
  batch,
  connectionId,
  latest,
}: {
  batch: RefAcquisitionBatchSummary;
  connectionId: string;
  latest: boolean;
}) {
  const lane = acquisitionMethodLabel(batch.acquisition_method);
  const countLabel = acquisitionBatchCountLabel(batch);
  const rangeLabel = acquisitionBatchRangeLabel(batch);
  const mediaLabel = acquisitionMediaCoverageLabel(batch.media_coverage);
  return (
    <li className="px-3 py-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="min-w-0">
          <p className="pdpp-body font-medium text-foreground">
            {lane}
            {latest ? <span className="pdpp-caption ml-2 text-muted-foreground">Latest</span> : null}
          </p>
          <p className="pdpp-caption mt-0.5 break-words text-muted-foreground">
            {[batch.uploaded_file_name, batch.detected_format, rangeLabel].filter(Boolean).join(" · ")}
          </p>
          <p className="pdpp-caption mt-1 text-muted-foreground">
            {[batch.status, countLabel, mediaLabel].filter(Boolean).join(" · ")}
          </p>
          {batch.warnings.length > 0 ? (
            <ul className="pdpp-caption mt-2 list-disc space-y-1 pl-4 text-attention">
              {batch.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          ) : null}
        </div>
        <Link
          className={buttonVariants({ size: "sm", variant: "ghost" })}
          href={`/connect/status/${encodeURIComponent(connectionId)}`}
        >
          Open receipt
        </Link>
      </div>
    </li>
  );
}

function acquisitionMethodLabel(method: string | null): string {
  switch (method) {
    case "owner_artifact":
      return "Imported export";
    case "device_sync":
      return "Device sync";
    case "device_backup":
      return "Device backup import";
    case "browser_polyfill":
      return "Browser collection";
    case "provider_api":
      return "Provider API window";
    default:
      return method ? method.replaceAll("_", " ") : "Acquisition batch";
  }
}

function acquisitionBatchCountLabel(batch: RefAcquisitionBatchSummary): string | null {
  const parts = [
    countPart(batch.accepted_count, "accepted"),
    countPart(batch.duplicate_count, "duplicate"),
    countPart(batch.skipped_count, "skipped"),
    countPart(batch.failed_count, "failed"),
  ].filter((part): part is string => part !== null);
  if (parts.length > 0) {
    return parts.join(" · ");
  }
  return countPart(batch.parsed_count, "parsed");
}

function countPart(count: number | null, label: string): string | null {
  if (typeof count !== "number" || count <= 0) {
    return null;
  }
  return `${count.toLocaleString()} ${label}`;
}

function sourceTimeLabel(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : formatRelative(date, Date.now());
}

function sourceDateLabel(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "date unavailable";
  const now = Date.now();
  if (Math.abs(now - date.getTime()) < 7 * 24 * 60 * 60 * 1000) {
    return formatRelative(date, now);
  }
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    ...(date.getUTCFullYear() === new Date(now).getUTCFullYear() ? {} : { year: "numeric" }),
    timeZone: "UTC",
  }).format(date);
}

function acquisitionBatchRangeLabel(batch: RefAcquisitionBatchSummary): string | null {
  if (!(batch.date_range.start || batch.date_range.end)) {
    return null;
  }
  return `${sourceDateLabel(batch.date_range.start) ?? "unknown"} to ${sourceDateLabel(batch.date_range.end) ?? "unknown"}`;
}

function acquisitionMediaCoverageLabel(mediaCoverage: unknown): string | null {
  if (!mediaCoverage || typeof mediaCoverage !== "object") {
    return null;
  }
  const { status } = mediaCoverage as { status?: unknown };
  return typeof status === "string" && status.length > 0 ? `media ${status.replaceAll("_", " ")}` : null;
}

/**
 * Latest syncs section with optional auto-paused banner. Extracted to keep
 * `ConnectorPageView` under the cognitive complexity budget while containing
 * the conditional branches needed for the banner and run rows.
 */
function RecentRunsSection({ recentRuns }: { recentRuns: RunSummary[] }) {
  if (recentRuns.length === 0) return null;
  return (
    <Section
      action={
        <div className="flex gap-3">
          <Link className="text-primary hover:underline" href="/syncs">All sync history</Link>
        </div>
      }
      title="Recent syncs"
    >
              <DataList>
          {recentRuns.slice(0, 3).map((r) => (
            <li key={r.run_id}>
              <Link
                className="flex flex-col gap-1 px-3 py-3 transition-colors hover:bg-muted/40 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
                href={`/syncs/${encodeURIComponent(r.run_id)}`}
              >
                <span className="pdpp-caption flex items-center gap-2">
                  <span>{syncOutcome(r)}</span>
                  {syncOutcome(r) === "Failed" ? <span>{syncFailureSentence(r.failure_reason) ?? "DataConnect could not copy this."}</span> : null}
                </span>
                <span className="pdpp-caption inline-flex flex-wrap items-baseline gap-x-1 text-muted-foreground tabular-nums">
                  <span>{sourceTimeLabel(r.first_at) ?? "Time unavailable"}</span>

                </span>
              </Link>
            </li>
          ))}
        </DataList>
    </Section>
  );
}

function syncFailureSentence(reason: string | null): string | null {
  if (reason === "assistance_timed_out") return "The sign-in was not finished. Start again when you are ready.";
  if (reason === "local collector outbox has dead-lettered rows") return "The computer that holds this data could not send some records.";
  if (reason === "provider_unavailable") return "The service could not be reached.";
  if (reason === "credential_invalid" || reason === "credentials_invalid") return "Sign in again to keep syncing.";
  return null;
}

function syncOutcome(sync: RunSummary): string {
  if (["succeeded", "completed", "success", "succeeded_with_gaps"].includes(sync.status)) return "Finished";
  if (["cancelled", "canceled", "rejected"].includes(sync.status)) return "Stopped";
  if (["failed", "error"].includes(sync.status)) return "Failed";
  if (["pending", "started", "in_progress", "running"].includes(sync.status)) return "Syncing now";
  if (["waiting_for_input", "needs_input", "waiting_for_owner"].includes(sync.status)) return "Needs you";
  return "Stopped";
}

/**
 * Source-pressure cooldown is intentionally not the default sync path: the
 * source has asked PDPP to slow down, so an ordinary run should wait. The owner
 * still gets a separate, named override on the detail page because the backend
 * supports `force: true`; keeping it separate prevents an accidental click from
 * bypassing provider safety.
 */
function CooldownPrimaryAction({
  action,
  connectionId,
  connectorId,
  displayName,
  installPromptShown,
  running,
}: {
  action: Extract<PrimaryRowAction, { kind: "cooldown_wait" }>;
  connectionId: string | null;
  connectorId: string;
  displayName: string;
  installPromptShown: boolean;
  running: boolean;
}) {
  return (
    <div className="flex flex-col items-end gap-1">
      <span
        className="pdpp-caption max-w-[18rem] text-right text-muted-foreground"
        data-testid="detail-action-cooldown-wait"
        title={action.detail}
      >
        {action.label}
      </span>
      <SyncNowButton
        connectionId={connectionId}
        connectorId={connectorId}
        displayName={displayName}
        installPromptShown={installPromptShown}
        force
        idleLabel="Force run anyway"
        initialRunning={running}
        title="Bypasses the provider-pressure cooldown. It may fail or cause more throttling."
        variant="outline"
      />
    </div>
  );
}

/**
 * Identity line under the connector title. Surfaces:
 * - the durable `connection_id` (also the records-route key);
 * - the connector type when it differs from the connection id (legacy single-instance rows);
 * - the manifest's `provider_id` when present;
 * - the bound device label(s) so two filesystem-class instances of the
 *   same connector type are visually distinguishable.
 *
 * Kept as a small helper to keep `ConnectorPage` under the cognitive
 * complexity budget while still rendering JSX inline.
 */
function ConnectionIdentityLine({
  connectionId,
  connectorId,
  deviceLabels,
  providerId,
}: {
  connectionId: string;
  connectorId: string;
  deviceLabels: readonly string[];
  providerId: string | null;
}) {
  return (
    <>
      <span className="inline-flex items-center gap-1 align-middle" data-testid="connection-id-disclosure">
        <code className="font-mono text-xs">{connectionId}</code>
        <CopyButton ariaLabel="Copy connection ID" value={connectionId} />
      </span>
      {connectionId === connectorId ? null : (
        <>
          {" · "}
          <span>Type: {formatConnectorKeyForDisplay(connectorId)}</span>
        </>
      )}
      {providerId ? (
        <>
          {" · "}
          <span>Provider: {providerId}</span>
        </>
      ) : null}
      {deviceLabels.length > 0 ? (
        <>
          {" · "}
          <span data-testid="records-device-labels">
            Device{deviceLabels.length === 1 ? "" : "s"}: {deviceLabels.join(", ")}
          </span>
        </>
      ) : null}
    </>
  );
}

/**
 * Pause control for a connection that is actively collecting. Deliberately
 * NOT in the danger zone with revoke/delete, and deliberately unconfirmed:
 * pause changes no data and is undone by one click on the same page, so the
 * confirmation ceremony those destructive actions require would be friction
 * with nothing to protect. The copy names the reversibility and contrasts
 * pause with revoke, so the owner can tell the two apart before acting.
 */
function PauseConnectionSection({ connectionId }: { connectionId: string | null }) {
  return (
    <div className="mt-5 flex flex-col items-start gap-3 sm:flex-row sm:justify-between">
      <div><p className="pdpp-body">Pause syncing</p><p className="pdpp-body text-muted-foreground">Stops checking for now. Your records and sign-in are kept.</p></div>
      <form className="shrink-0" action={pauseConnectionAction}>
        {connectionId ? <input name="connection_id" type="hidden" value={connectionId} /> : null}
        <IcButton data-testid="detail-action-pause-connection" size="sm" type="submit" variant="ghost">
          Pause syncing
        </IcButton>
      </form>
    </div>
  );
}

function RevokedConnectionSection({ revokedAt }: { revokedAt: string | null }) {
  const stoppedAt = sourceTimeLabel(revokedAt);
  return revokedAt ? (
    <p className="mb-6 pdpp-caption text-muted-foreground">
      Stopped syncing{stoppedAt ? ` ${stoppedAt}` : ""}.
    </p>
  ) : null;
}

function summarizeSourceInstancesForHeader(sourceInstances: readonly DeviceSourceInstance[]): {
  accountDeviceLabels: string[];
  deviceLabels: string[];
} {
  const accountDeviceLabels: string[] = [];
  const deviceLabels: string[] = [];
  for (const source of sourceInstances) {
    const accountLabel = source.display_name ?? source.local_binding_name;
    if (
      typeof accountLabel === "string" &&
      accountLabel.length > 0 &&
      accountLabel !== source.device_id &&
      !accountDeviceLabels.includes(accountLabel)
    ) {
      accountDeviceLabels.push(accountLabel);
    }
    const label = accountLabel ?? source.device_id;
    if (typeof label === "string" && label.length > 0) {
      deviceLabels.push(label);
    }
  }
  return { accountDeviceLabels, deviceLabels };
}

function errorMessage(reason: unknown): string {
  if (reason instanceof Error) {
    return reason.message;
  }
  return String(reason);
}

// ─── Surface 3: Auto-paused banner in the run timeline ───────────────────────

/**
 * Amber banner shown at the top of the run timeline when the scheduler has
 * entered back-off after consecutive failures.
 *
 * Design: §D.4 of the mocks. The banner sits above the run rows (before the
 * list), converting a wall of red rows into a legible "the system noticed;
 * here's what it did" moment. The terminal (`blocked`) variant is red-tinted.
 */
function AutoPausedBannerRow({ banner, connectorId }: { banner: AutoPausedBanner; connectorId: string }) {
  const failures = banner.consecutiveFailures;
  const failureNoun = `${failures} failed sync${failures === 1 ? "" : "s"}`;

  return (
    <p className="px-3 py-3 text-sm text-muted-foreground" data-testid="auto-paused-banner-row">
      {banner.isTerminal ? (
        <>
          Automatic syncing is paused after {failureNoun}.{" "}
            <Link className="underline hover:no-underline" href={addSourceHrefForConnector(connectorId)}>
              Start a new setup
            </Link>
        </>
      ) : (
        <>
          Automatic syncing paused after {failureNoun}.
          {sourceTimeLabel(banner.nextRunAt) ? (
            <> Next attempt {sourceTimeLabel(banner.nextRunAt)}.</>
          ) : null}
        </>
      )}
    </p>
  );
}

export function ScheduleSummary({ displayName, schedule, scheduleError, sourceInstances, now = new Date(), disconnected = false, paused = false }: {
  displayName: string; schedule: RefSchedule | null; scheduleError: string | null; sourceInstances: DeviceSourceInstance[]; now?: Date; disconnected?: boolean; paused?: boolean;
}) {
  const text = disconnected ? "Not checked while disconnected." : paused ? "Not checked while paused." : scheduleSentence(displayName, scheduleError ? undefined : schedule);
  const next = !disconnected && !paused && schedule?.enabled && schedule.effective_mode !== "manual" && schedule.next_due_at && new Date(schedule.next_due_at).getTime() > now.getTime() ? sourceTimeLabel(schedule.next_due_at) : null;
  const device = sourceInstances[0];
  const deviceName = device?.display_name ?? device?.local_binding_name;
  const heard = sourceTimeLabel(device?.last_heartbeat_at);
  return <Section title="Schedule" action={disconnected ? undefined : <Link className="text-primary hover:underline" href="/schedules">Change</Link>}>
    {text ? <p className="pdpp-body text-muted-foreground" data-testid="source-schedule-summary">{text}</p> : null}
    {next ? <p className="text-sm text-muted-foreground">Next check {next}.</p> : null}
    {device && deviceName && heard ? <p className="text-sm text-muted-foreground">It runs on {deviceName}, last heard from {heard}. <Link href={`/device-exporters#${encodeURIComponent(device.device_id)}`}>View this device</Link></p> : null}
  </Section>;
}

function CredentialRepairLinks({
  revoked,
  setupFailed,
  storedCredentialUpdateHref,
  hasStaticSecretCredentialUpdate,
}: {
  revoked: boolean;
  setupFailed: boolean;
  storedCredentialUpdateHref: string | null;
  hasStaticSecretCredentialUpdate: boolean;
}) {
  if (setupFailed) return null;
  return storedCredentialUpdateHref && !revoked && hasStaticSecretCredentialUpdate ? (
    <div className="mt-5 flex flex-col items-start gap-3 sm:flex-row sm:justify-between">
      <p className="pdpp-body">Update sign-in details</p>
      <Link className={buttonVariants({ size: "sm", variant: "ghost" })} href={storedCredentialUpdateHref}>Update sign-in details</Link>
    </div>
  ) : null;
}
