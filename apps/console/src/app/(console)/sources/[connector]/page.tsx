// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { buttonVariants, IcButton } from "@pdpp/brand-react";
import type { StreamManifestEntry } from "@pdpp/display";
import {
  formatConnectorKeyForDisplay,
  formatConnectorNameForDisplay,
  formatRelative,
  humanizeFieldLabel,
  isFallbackConnectionLabel,
  isSetupFailedSource,
  streamDisplayLabel,
} from "@pdpp/display";
import { CopyButton } from "@pdpp/operator-ui/components/copy-button";
import { DataList, PageHeader, Section } from "@pdpp/operator-ui/components/primitives";
import { buildBreakdownLabel } from "@pdpp/operator-ui/lib/source-storage";
import { formatTotalRecordsLabel } from "../../lib/total-records-label.ts";
import { formatStorageBytes } from "@pdpp/operator-ui/lib/storage-footprint";
import Link from "next/link";
import { Suspense } from "react";
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
  isSetupInProgressConnector,
  projectSourceActionability,
  type SourceStreamOwnerActionAvailability,
} from "../../lib/source-actionability.ts";
import { type SourceStatusAction, type SourceStatusRow, sourceStateSentence, sourceStatusWords } from "../../lib/source-status-words.ts";
import { isUnexpectedStreamDeclaration, streamCountLabel } from "../../lib/stream-evidence-state.ts";
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
import { ConnectionConfiguration } from "./connection-configuration.tsx";
import { ConnectionConfirmation } from "./connection-confirmation.tsx";
import { ConnectionDangerZone } from "./connection-danger-zone.tsx";
import { ConnectionDiagnostics, ConnectionRecoverySummary } from "./connection-diagnostics.tsx";
import { ConnectorInstallPrompt } from "./connector-install-prompt.tsx";
import { RenameConnection } from "./rename-connection.tsx";
import { SourceStateSentenceText } from "./source-state-sentence.tsx";
import { StreamCollectionFactsLine } from "./stream-collection-facts.tsx";
import { SyncNowButton } from "./sync-now-button.tsx";
import { SourceUpdateSlot, type SourceUpdateModel } from "./source-update-section.tsx";
import { buildSourceUpdateModel } from "./source-update-view-model.ts";

export const dynamic = "force-dynamic";

function addSourceHrefForConnector(connectorId: string): string {
  return `/sources/add?source_q=${encodeURIComponent(connectorId)}`;
}

function demoStatusRow(value: string | undefined): SourceStatusRow | null {
  const match = value?.match(/^status-(\d{1,2})(?:-[a-z-]+)?$/);
  if (!match) return null;
  const row = Number(match[1]);
  return row >= 1 && row <= 24 ? (row as SourceStatusRow) : null;
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
  const demoRow = demoStatusRow(sp.demo);
  const updateDemo = process.env.NODE_ENV !== "production" && (sp.demo === "update-ready" || sp.demo === "update-ready-shared")
    ? buildDemoSourceUpdate(sp.demo === "update-ready-shared")
    : null;
  if (process.env.NODE_ENV !== "production" && (sp.demo === "atlas" || demoRow !== null || sp.demo === "pending-details" || sp.demo === "pending-details-19" || updateDemo !== null)) {
    const demo = await import("./source-detail-demo-data.ts");
    const row = sp.demo === "pending-details" ? 20 : sp.demo === "pending-details-19" ? 19 : demoRow ?? (sp.demo === "atlas" ? 16 : 19);
    model = demo.buildRecoveryDemoModel(row, sp.demo === "pending-details" || sp.demo === "pending-details-19" || row === 16);
    const demoVariant = sp.demo?.replace(/^status-\d{1,2}-?/, "");
    if (demoRow !== null && demoVariant) model = demo.withStatusDemoVariant(model, demoVariant);
    if (sp.demo === "status-10-local-device") {
      model = { ...model, source: { ...model.source, source_kind: "local_device" }, sourceInstances: demo.buildRecoveryDemoModel(1).sourceInstances };
    }
  } else {
    try {
      model = await loadConnectorPageModel(routeId, sp.connection_id ?? null);
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
  const updates = updateDemo
    ? undefined
    : buildSourceUpdateModel(model.connectorId, model.source.display_name ?? model.displayName, readConnectorUpdates);
  return (
    <ConnectorPageView
      dangerActiveRunId={sp.active_run_id}
      dangerError={sp.error}
      dangerMessage={sp.message}
      model={model}
      now={now}
      updateDemo={updateDemo}
      updates={updates}
    />
  );
}

async function loadConnectorPageModel(
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

function StreamDisplayName({
  displayLabel,
  name,
  unexpected,
}: {
  displayLabel: string;
  name: string;
  unexpected: boolean;
}) {
  return (
    <span className="pdpp-body break-words font-medium" title={displayLabel === name ? undefined : name}>
      {displayLabel}
      {unexpected ? (
        <span
          className="ml-1.5 align-middle text-attention"
          data-testid="stream-unexpected-declaration"
          title="This kind of record has canonical or retained data, but its current declaration no longer lists it."
        >
          (undeclared)
        </span>
      ) : null}
    </span>
  );
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: this server view intentionally composes the detail evidence panels and their binding-aware actions in one owner-visible route.
function ConnectorPageView({
  model,
  dangerActiveRunId,
  dangerMessage,
  dangerError,
  now,
  updateDemo,
  updates,
}: {
  model: ConnectorPageModel;
  /** The run that blocked a delete, forwarded from the delete action redirect. */
  dangerActiveRunId?: string;
  dangerMessage?: string;
  dangerError?: string;
  /** Server render instant (ISO-8601) for the diagnostics recovery stall watchdog. */
  now: string;
  updateDemo: SourceUpdateModel | null;
  updates?: Promise<SourceUpdateModel | null>;
}) {
  const {
    activeRunId: scheduleActiveRunId,
    collectionFactsByStream,
    collectionOwnerActionByStream,
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
    coverageAsOf,
    coverageHorizons,
    accountDeviceLabels,
    deviceLabels,
    displayName,
    headerCount,
    latestKnownGaps,
    manifest,
    manualUploadHref,
    overview,
    providerOrigin,
    recentRuns,
    retainedStorage,
    schedule,
    scheduleError,
    setupFailed,
    sourceBindingKind,
    sourceInstances,
    sourceInstancesError,
    source,
    streams,
  } = model;
  const { activeRunHref, running } = resolveActiveRunNavigation({
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
  const pausable = !(revoked || paused) && overview.connectionStatus === "active";
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
  const autoPausedBanner = deriveAutoPausedBanner(schedule);
  const renderedAt = new Date(now);
  const pendingDetails = Boolean(connectionHealth?.detail_gap_backlog?.pending) ||
    [...collectionFactsByStream.values()].some((facts) => facts.pendingDetailGaps > 0);
  const signInRepairAvailable = credentialUpdateHref !== null;
  const sourceStatus = sourceStatusWords(source, { now: renderedAt, signInRepairAvailable });
  const stateSentence = sourceStateSentence(source, { now: renderedAt, name: displayName, pendingDetails, signInRepairAvailable });
  const pageStatusAction = sourceStatus.action; // never Resume for a local-device source: its paused action is "View this device"
  const hasDeviceLocalRemediation = hasPrimaryOwnerLocalDeviceRemediation(connectionRenderedVerdict);
  const manifestStreams = Array.isArray(manifest.streams) ? manifest.streams : [];
  const streamLabelsByName = new Map(
    manifestStreams.map(
      (stream) => [stream.name, streamDisplayLabel(stream.name, stream as StreamManifestEntry)] as const
    )
  );
  const accountLine = connectionLabelSeed ||
    (source.source_kind === "local_device" ? accountDeviceLabels.join(", ") || "On your device" : undefined);

  return (
    <RecordroomShellWithPalette>
      <PageHeader
        actions={
          <ConnectorHeaderActions
            browserSessionRepairHref={browserSessionRepairHref}
            canStartSync={canStartSyncFromSummary(source)}
            connectionId={connectorInstanceId}
            connectorId={connectorId}
            credentialUpdateHref={credentialUpdateHref}
            displayName={displayName}
            installPromptShown={installPromptShown}
            primaryAction={primaryAction}
            renderedAction={connectionPrimaryAction}
            running={running}
            installKey={installKey}
            routeConnectionId={connectionId}
            sourceInstances={sourceInstances}
            storedCredentialUpdateHref={storedCredentialUpdateHref}
            statusAction={pageStatusAction}
          />
        }
        breadcrumbs={[{ href: "/sources", label: "Data sources" }]}
        count={headerCount}
        description={accountLine === displayName ? undefined : accountLine}
        title={
          <span>
            <span className="mr-2 inline-block align-middle [&_.pdpp-connector-icon]:size-12">
              <ConnectorMark connectorId={connectorId} icon={manifest.icon} name={displayName} />
            </span>
            {displayName}
          </span>
        }
      />

      <SourceStateSentenceText connectionId={connectionId} sentence={stateSentence} status={sourceStatus} />

      {hasDeviceLocalRemediation ? (
        <section className="mb-6" data-testid="device-collector-trouble">
          <h2 className="pdpp-title text-foreground">Device needs attention</h2>
          <p className="pdpp-caption mt-1 text-muted-foreground">
            Follow the recovery steps in Details on the device that holds this data.
          </p>
        </section>
      ) : null}
      {revoked && !setupFailed ? <RevokedConnectionSection revokedAt={overview.revokedAt ?? null} /> : null}

      <div className="grid min-w-0 gap-10 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="min-w-0">
      <Section action={<Link className="text-primary hover:underline" href="/explore">Browse records</Link>} title="What is here">
        {streams.length === 0 ? (
          <p className="pdpp-caption text-muted-foreground italic">{emptyStreamsHint(primaryAction, syncIdleLabel)}</p>
        ) : (
          <DataList>
            {streams.map((s) => {
              const countLabel = streamCountLabel(s);
              const unexpected = isUnexpectedStreamDeclaration(s.declaration_state);
              const manifestLabel = streamLabelsByName.get(s.name);
              const displayLabel = manifestLabel && manifestLabel !== s.name ? manifestLabel : humanizeFieldLabel(s.name);
              const lastUpdated = sourceTimeLabel(s.last_updated);
              const reportEntry = source.collection_report?.find((entry) => entry.stream === s.name);
              const incompleteLine = reportEntry &&
                typeof reportEntry.collected === "number" &&
                typeof reportEntry.considered === "number" &&
                reportEntry.collected < reportEntry.considered
                ? `${reportEntry.collected.toLocaleString()} of ${reportEntry.considered.toLocaleString()} fetched so far.`
                : null;
              return (
                <li key={s.name}>
                  <Link
                    className="flex flex-col gap-1 px-3 py-3 transition-colors hover:bg-muted/40 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
                    href={`/sources/${encodeURIComponent(connectionId)}/${encodeURIComponent(s.name)}`}
                  >
                    <span className="flex min-w-0 flex-col gap-1">
                      <StreamDisplayName displayLabel={displayLabel} name={s.name} unexpected={unexpected} />
                      <span className="pdpp-caption text-muted-foreground tabular-nums" data-count-state={s.count_state ?? "unknown_state"}>
                        {countLabel.text}{lastUpdated ? ` · latest ${lastUpdated}` : ""}
                      </span>
                      {incompleteLine ? <span className="pdpp-caption text-muted-foreground">{incompleteLine}</span> : null}
                    </span>
                  </Link>
                </li>
              );
            })}
          </DataList>
        )}
      </Section>

      <RecentRunsSection
        activeRunHref={activeRunHref}
        autoPausedBanner={autoPausedBanner}
        connectorId={connectorId}
        hasSyncHistory={Boolean(source.connection_health.last_success_at ?? source.last_successful_run?.last_at ?? source.last_run?.last_at)}
        recentRuns={recentRuns}
      />
      {manualUploadHref || scheduleSyncAvailable ? (
        <Section title="More sync options">
          <div className="flex flex-wrap items-center gap-3">
            {manualUploadHref ? <Link className={buttonVariants({ size: "sm", variant: "ghost" })} href={manualUploadHref}>Add another export</Link> : null}
            {manualUploadHref ? (
              <SyncNowButton
                connectionId={connectorInstanceId ?? connectionId}
                connectorId={connectorId}
                displayName={displayName}
                installPromptShown={installPromptShown}
                idleLabel="Reprocess all exports"
                initialRunning={running}
                runningLabel="Import running"
                title="Reprocesses files already uploaded for this data source. It does not add a new export."
                variant="outline"
              />
            ) : null}
            {scheduleSyncAvailable ? (
              <SyncNowButton connectionId={connectorInstanceId ?? connectionId} connectorId={connectorId} displayName={displayName} installPromptShown={installPromptShown} idleLabel={syncIdleLabel} initialRunning={running} variant="outline" />
            ) : null}
          </div>
        </Section>
      ) : null}
        </div>

        <aside className="min-w-0">
          <ScheduleSummary schedule={schedule} />
          <Suspense fallback={<SourceVersion version={source.manifest_version ?? null} />}>
            <SourceUpdateSlot
              demoModel={updateDemo}
              displayName={displayName}
              updates={updates}
              version={source.manifest_version ?? null}
            />
          </Suspense>
          <Section title="This data source">
            <RenameConnection
              connectionId={renameSelector}
              currentLabel={connectionLabelSeed}
              typeName={formatConnectorKeyForDisplay(connectorId)}
            />
            {pausable ? <PauseConnectionSection connectionId={renameSelector} /> : null}
            <CredentialRepairLinks
              revoked={revoked}
              setupFailed={setupFailed}
              storedCredentialUpdateHref={storedCredentialUpdateHref}
              hasStaticSecretCredentialUpdate={storedCredentialUpdateHref !== null && !sessionBound && primaryActionSurface !== "stored_credential"}
            />
            <ConnectionDangerZone
              activeRunId={dangerActiveRunId ?? scheduleActiveRunId}
              connectionId={connectorInstanceId ?? connectionId}
              error={dangerError}
              message={dangerMessage}
              setupFailed={setupFailed}
            />
          </Section>
          {configuration ? (
            <ConnectionConfiguration
              config={configuration}
              connectionId={connectorInstanceId ?? connectionId}
              connectorId={connectorId}
              revisions={configRevisions}
            />
          ) : null}
          <details className="mb-8 border-t border-border pt-4" data-testid="source-details">
            <summary className="cursor-pointer text-sm font-medium text-muted-foreground">Details</summary>
            <div className="pt-4">
              <ConnectionIdentityLine
                connectionId={connectionId}
                connectorId={connectorId}
                deviceLabels={deviceLabels}
                providerId={manifest.provider_id ?? null}
              />
              {retainedStorage ? <p className="mt-2 text-sm text-muted-foreground">{retainedStorage.total} retained</p> : null}
              <p className="mt-2 text-sm text-muted-foreground">Connector: {formatConnectorKeyForDisplay(connectorId)}</p>
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
                message={dangerMessage}
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
          </details>
        </aside>
      </div>
    </RecordroomShellWithPalette>
  );
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
    return <form action={resumeConnectionAction}><input name="connection_id" type="hidden" value={connectionId ?? ""} /><IcButton size="sm" type="submit" variant="ghost">{statusAction.label}</IcButton></form>;
  }
  if (statusAction?.kind === "repair_credential" && credentialUpdateHref) {
    return <Link className={buttonVariants({ size: "sm", variant: "ghost" })} href={credentialUpdateHref}>{statusAction.label}</Link>;
  }
  if (statusAction?.kind === "continue_setup") {
    return <form action={resumeSetupConnectionAction}><input name="connection_id" type="hidden" value={routeConnectionId} /><IcButton size="sm" type="submit" variant={statusAction.filled ? "default" : "ghost"}>Continue setup</IcButton></form>;
  }
  if (statusAction?.kind === "install") {
    return <ConnectorInstallPrompt actionLabel={statusAction.label} connectorKey={installKey} displayName={displayName} routeId={connectionId ?? connectorId} variant="inline" />;
  }
  if (statusAction?.kind === "view_device") {
    const device = sourceInstances[0];
    return device ? <Link className={buttonVariants({ size: "sm", variant: "ghost" })} href={`/device-exporters#${encodeURIComponent(device.device_id)}`}>View this device</Link> : null;
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
    return <PrimaryActionNotice action={primaryAction} />;
  }
  return null;
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
      return (
        <span
          className="pdpp-caption max-w-[18rem] text-right text-muted-foreground"
          data-action-kind={action.kind}
          data-action-target="local_device"
          data-testid="detail-action-rendered-verdict-device-local"
          title="Use the recovery commands shown in Details, on the host that holds this data source's data."
        >
          {label ?? action.cta} — see the commands in Details
        </span>
      );
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
function RecentRunsSection({
  activeRunHref,
  autoPausedBanner,
  connectorId,
  hasSyncHistory,
  recentRuns,
}: {
  activeRunHref: string | null;
  autoPausedBanner: AutoPausedBanner | null;
  connectorId: string;
  hasSyncHistory: boolean;
  recentRuns: RunSummary[];
}) {
  return (
    <Section
      action={
        <div className="flex gap-3">
          {activeRunHref ? <Link className="text-primary hover:underline" href={activeRunHref}>Active sync</Link> : null}
          <Link className="text-primary hover:underline" href="/syncs">All sync history</Link>
        </div>
      }
      title="Latest syncs"
    >
      {recentRuns.length === 0 ? (
        hasSyncHistory ? null : <p className="pdpp-caption text-muted-foreground">No syncs yet.</p>
      ) : (
        <DataList>
          {autoPausedBanner ? (
            <li data-testid="auto-paused-banner">
              <AutoPausedBannerRow banner={autoPausedBanner} connectorId={connectorId} />
            </li>
          ) : null}
          {recentRuns.map((r) => (
            <li key={r.run_id}>
              <Link
                className="flex flex-col gap-1 px-3 py-3 transition-colors hover:bg-muted/40 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
                href={`/syncs/${encodeURIComponent(r.run_id)}`}
              >
                <span className="pdpp-caption flex items-center gap-2">
                  <span>{syncOutcome(r)}</span>
                </span>
                <span className="pdpp-caption inline-flex flex-wrap items-baseline gap-x-1 text-muted-foreground tabular-nums">
                  <span>{sourceTimeLabel(r.first_at) ?? "Time unavailable"}</span>
                  <span aria-hidden>·</span>
                  <span>{durationLabel(r.first_at, r.last_at)}</span>
                </span>
              </Link>
            </li>
          ))}
        </DataList>
      )}
    </Section>
  );
}

/**
 * Empty-streams hint, keyed on the same modality as the header action so a
 * push-mode connection is never told to start a remote run - a button it does
 * not have. Owner-runnable connections use the same idle label as the button,
 * so failed first attempts read as recovery ("Retry sync") instead of a fresh
 * first-time action.
 */
function emptyStreamsHint(action: PrimaryRowAction, syncIdleLabel: string): string {
  if (action.kind === "sync") {
    return `No records here yet. ${syncIdleLabel} to add the first.`;
  }
  return "No records yet. This data source fills in when its device sends them.";
}

function syncOutcome(sync: RunSummary): string {
  if (["succeeded", "completed", "success", "succeeded_with_gaps"].includes(sync.status)) return "Finished";
  if (["cancelled", "canceled", "rejected"].includes(sync.status)) return "Stopped";
  if (["failed", "error"].includes(sync.status)) return "Failed";
  if (["pending", "started", "in_progress", "running"].includes(sync.status)) return "Running";
  if (["waiting_for_input", "needs_input", "waiting_for_owner"].includes(sync.status)) return "Waiting for you";
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
 * Honest non-clickable primary action for a connection that cannot be synced
 * from the dashboard. Mirrors the records row's `PrimaryRowActionControl`
 * non-sync branch: push-mode (local-collector) connections show a "waiting for
 * the local device" status. Inert text, never a `<button>`, so it can never
 * reach `runConnectorNowAction`.
 */
function PrimaryActionNotice({ action }: { action: Exclude<PrimaryRowAction, { kind: "sync" | "cooldown_wait" }> }) {
  return (
    <span
      className="pdpp-caption max-w-[18rem] text-right text-muted-foreground"
      data-testid="detail-action-device-wait"
      title={action.detail}
    >
      {action.label}
    </span>
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
    <div className="mt-6 flex flex-col items-start gap-2">
      <p className="pdpp-caption text-muted-foreground">Stop syncing for now. Your records, schedule, and sign-in are kept.</p>
      <form action={pauseConnectionAction}>
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

function durationLabel(firstAt: string, lastAt: string): string {
  const a = Date.parse(firstAt);
  const b = Date.parse(lastAt);
  if (!(Number.isFinite(a) && Number.isFinite(b)) || b < a) {
    return "—";
  }
  const ms = b - a;
  if (ms < 1000) {
    return `${ms}ms`;
  }
  const secs = Math.round(ms / 100) / 10;
  if (secs < 60) {
    return `${secs}s`;
  }
  const m = Math.floor(secs / 60);
  const s = Math.round(secs % 60);
  return `${m}m ${s}s`;
}

function ScheduleSummary({ schedule }: { schedule: RefSchedule | null }) {
  const retryAt = schedule?.scheduler_backoff?.next_run_at;
  const retry = sourceTimeLabel(retryAt);
  const interval = schedule?.interval_seconds ?? null;
  const intervalLabel = interval === 3600 ? "Every hour" : interval === 21_600 ? "Every 6 hours" : interval === 86_400 ? "Every day" : interval ? `Every ${Math.round(interval / 60)} minutes` : null;
  const text = retry
    ? `Trying again ${retry}.`
    : schedule?.effective_mode === "manual"
      ? "Only when you ask."
      : intervalLabel
        ? `${intervalLabel}, on its own.`
        : "No schedule is set.";
  return (
    <Section title="Schedule" action={<Link className="text-primary hover:underline" href="/schedules">Change</Link>}>
      <p className="text-sm text-muted-foreground" data-testid="source-schedule-summary">{text}</p>
    </Section>
  );
}

function SourceVersion({ version }: { version: string | null }) {
  return version ? (
    <Section title="Version"><p className="text-sm text-muted-foreground">Version {version}.</p></Section>
  ) : null;
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
    <div className="mt-4 flex flex-col gap-2">
      <Link className="text-sm text-primary hover:underline" href={storedCredentialUpdateHref}>Update sign-in details</Link>
    </div>
  ) : null;
}
