// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// biome-ignore lint/correctness/noUnresolvedImports: remote-surface 1.5.1 exports ./leases; Biome 2.5.5 fails to resolve this package export.
import type { BrowserSurfaceLease } from "@opendatalabs/remote-surface/leases";

import { listSpineEventsPage, type SpineEventRecord } from "../../lib/spine.ts";
import type { ConnectionRemoteSurfaceEvidence } from "../connection-health.ts";
import type {
  BrowserSurfaceRuntimeInventorySnapshot,
  BrowserSurfaceRuntimeManagement,
  BrowserSurfaceRuntimeSurfaceObservation,
} from "../controller.ts";
import {
  type ActiveLeaseExecution,
  type EphemeralBrowserConnectionKind,
  type EphemeralBrowserRuntimeProjection,
  type LastSuccessfulRuntimeReceipt,
  projectEphemeralBrowserSurfaceHealth,
} from "./ephemeral-health-projection.ts";
import {
  buildLastSuccessfulRuntimeReceipt,
  isSucceededRunCompletionEvent,
  type RuntimeLifecycleEvent,
} from "./runtime-receipts.ts";

const RUNTIME_RECEIPT_EVENT_LIMIT = 128;
const RUNTIME_RECEIPT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface BrowserSurfaceHealthSummaryReader {
  listLeases: () => Promise<readonly BrowserSurfaceLease[]>;
}

interface LastSuccessfulRunLike {
  readonly run_id: string | undefined;
}

interface RuntimeLeaseFacts {
  readonly active_lease: ActiveLeaseExecution | null;
  readonly demand: "active" | "none";
}

interface RuntimeSummaryInstance {
  readonly sourceKind: string;
}

interface BrowserSurfaceRuntimeManagementReader {
  getBrowserSurfaceRuntimeManagement?: (connectorId: string) => BrowserSurfaceRuntimeManagement;
  observeBrowserSurfaceRuntimeInventory?: () => Promise<BrowserSurfaceRuntimeInventorySnapshot>;
  observeBrowserSurfaceRuntimeSurfaces?: (
    surfaceIds: readonly string[]
  ) => Promise<BrowserSurfaceRuntimeSurfaceObservation>;
}

export interface BrowserSurfaceHealthRemoteProjection {
  readonly evidence: ConnectionRemoteSurfaceEvidence | null;
  readonly unreliable: boolean;
}

function surfaceSubjectIdForConnection(connectionId: string, connectorId: string): string | undefined {
  return connectionId === connectorId ? undefined : connectionId;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function browserSurfaceEventMatchesLease(
  event: SpineEventRecord,
  lease: BrowserSurfaceLease,
  connectorId: string
): boolean {
  if (event.run_id !== lease.run_id || event.actor_id !== connectorId) {
    return false;
  }
  const browserSurface = recordValue(recordValue(event.data)?.browser_surface);
  return (
    browserSurface?.browser_surface_lease_id === lease.lease_id &&
    browserSurface.browser_surface_profile_key === lease.profile_key
  );
}

function receiptLeaseForConnection(input: {
  readonly connectionId: string;
  readonly connectorId: string;
  readonly leases: readonly BrowserSurfaceLease[];
  readonly profileKey: string;
  readonly runId: string;
}): BrowserSurfaceLease | null {
  const expectedSubject = surfaceSubjectIdForConnection(input.connectionId, input.connectorId);
  const matching = input.leases.filter((lease) => receiptLeaseMatches(input, lease, expectedSubject));
  return matching.length === 1 ? (matching[0] ?? null) : null;
}

function receiptLeaseMatches(
  input: { readonly connectorId: string; readonly profileKey: string; readonly runId: string },
  lease: BrowserSurfaceLease,
  expectedSubject: string | undefined
): boolean {
  return (
    lease.connector_id === input.connectorId &&
    lease.profile_key === input.profileKey &&
    lease.run_id === input.runId &&
    lease.surface_id !== undefined &&
    lease.surface_subject_id === expectedSubject
  );
}

function hasSurfaceId(
  lease: BrowserSurfaceLease | null
): lease is BrowserSurfaceLease & { readonly surface_id: string } {
  return typeof lease?.surface_id === "string" && lease.surface_id.length > 0;
}

function receiptContext(input: {
  readonly connectionId: string;
  readonly connectorId: string;
  readonly lease: BrowserSurfaceLease & { readonly surface_id: string };
  readonly now: string;
  readonly profileKey: string;
  readonly runId: string;
}) {
  return {
    connection_id: input.connectionId,
    connector_id: input.connectorId,
    generation: input.lease.fencing_token,
    lease_id: input.lease.lease_id,
    max_age_ms: RUNTIME_RECEIPT_MAX_AGE_MS,
    now: input.now,
    profile_key: input.profileKey,
    run_id: input.runId,
    surface_id: input.lease.surface_id,
    surface_subject_id: input.lease.surface_subject_id ?? input.connectionId,
  };
}

function lifecycleEventForLease(
  event: SpineEventRecord,
  lease: BrowserSurfaceLease,
  connectorId: string,
  context: ReturnType<typeof receiptContext>
): RuntimeLifecycleEvent | null {
  if (event.event_type === "run.browser_surface_ready" && browserSurfaceEventMatchesLease(event, lease, connectorId)) {
    return { ...context, event_type: "run.browser_surface_ready", occurred_at: event.occurred_at };
  }
  if (isSucceededRunCompletionEvent(event, context)) {
    return { ...context, event_type: "run.completed", occurred_at: event.occurred_at, succeeded: true };
  }
  if (
    event.event_type === "run.browser_surface_released" &&
    browserSurfaceEventMatchesLease(event, lease, connectorId)
  ) {
    return { ...context, event_type: "run.browser_surface_released", occurred_at: event.occurred_at };
  }
  return null;
}

function receiptLifecycleEvents(
  events: readonly SpineEventRecord[],
  lease: BrowserSurfaceLease,
  connectorId: string,
  context: ReturnType<typeof receiptContext>
): RuntimeLifecycleEvent[] {
  const lifecycle: RuntimeLifecycleEvent[] = [];
  for (const event of events) {
    const lifecycleEvent = lifecycleEventForLease(event, lease, connectorId, context);
    if (lifecycleEvent) {
      lifecycle.push(lifecycleEvent);
    }
  }
  return lifecycle;
}

/** Reads bounded spine evidence; an absent or malformed chain is simply no receipt. */
export async function readLastSuccessfulRuntimeReceipt(input: {
  readonly connectionId: string;
  readonly connectorId: string;
  readonly lastSuccessfulRun: LastSuccessfulRunLike | null;
  readonly now: string;
  readonly profileKey: string;
  readonly reader: BrowserSurfaceHealthSummaryReader;
}): Promise<LastSuccessfulRuntimeReceipt | null> {
  const runId = input.lastSuccessfulRun?.run_id;
  if (!runId) {
    return null;
  }
  try {
    return await readRuntimeReceiptForRun(input, runId);
  } catch {
    return null;
  }
}

async function readRuntimeReceiptForRun(
  input: Omit<Parameters<typeof readLastSuccessfulRuntimeReceipt>[0], "lastSuccessfulRun">,
  runId: string
): Promise<LastSuccessfulRuntimeReceipt | null> {
  const lease = receiptLeaseForConnection({
    connectionId: input.connectionId,
    connectorId: input.connectorId,
    leases: await input.reader.listLeases(),
    profileKey: input.profileKey,
    runId,
  });
  if (!hasSurfaceId(lease)) {
    return null;
  }
  const page = listSpineEventsPage("run", runId, { limit: RUNTIME_RECEIPT_EVENT_LIMIT });
  if (page.truncated) {
    return null;
  }
  const context = receiptContext({ ...input, lease, runId });
  return buildLastSuccessfulRuntimeReceipt(
    receiptLifecycleEvents(page.events, lease, input.connectorId, context),
    context
  ).receipt;
}

/** One full-refresh inventory read; failure becomes absent runtime evidence, never a thrown list request. */
export function readBrowserSurfaceRuntimeInventory(
  controller: BrowserSurfaceRuntimeManagementReader | null | undefined
): Promise<BrowserSurfaceRuntimeInventorySnapshot | null> {
  if (!controller?.observeBrowserSurfaceRuntimeInventory) {
    return Promise.resolve(null);
  }
  return controller.observeBrowserSurfaceRuntimeInventory().catch(() => null);
}

/**
 * Scoped runtime counterpart for bounded summary/detail maintenance. It never
 * falls back to the global allocator inventory diagnostic.
 */
export function readBrowserSurfaceRuntimeSurfaces(
  controller: BrowserSurfaceRuntimeManagementReader | null | undefined,
  surfaceIds: readonly string[]
): Promise<BrowserSurfaceRuntimeSurfaceObservation | null> {
  if (!controller?.observeBrowserSurfaceRuntimeSurfaces) {
    return Promise.resolve(null);
  }
  return controller.observeBrowserSurfaceRuntimeSurfaces(surfaceIds).catch(() => null);
}

function runtimeDemand(
  activeRun: unknown | null,
  remoteSurface: ConnectionRemoteSurfaceEvidence | null
): "active" | "none" {
  if (activeRun !== null) {
    return "active";
  }
  return remoteSurface?.axis === "failed" || remoteSurface?.axis === "leased" || remoteSurface?.axis === "waiting"
    ? "active"
    : "none";
}

function activeLeaseHealth(
  surfaceHealth: ConnectionRemoteSurfaceEvidence["surfaceHealth"]
): ActiveLeaseExecution["health"] {
  switch (surfaceHealth) {
    case "ready":
    case "unhealthy":
    case "stopping":
    case "starting":
      return surfaceHealth;
    default:
      return "missing";
  }
}

export function currentRuntimeLease(input: {
  readonly activeRun: unknown | null;
  readonly remoteSurface: ConnectionRemoteSurfaceEvidence | null;
}): RuntimeLeaseFacts {
  const demand = runtimeDemand(input.activeRun, input.remoteSurface);
  const remote = input.remoteSurface;
  if (demand === "none" || !remote?.leaseId || !remote.surfaceId) {
    return { active_lease: null, demand };
  }
  return {
    active_lease: {
      health: activeLeaseHealth(remote.surfaceHealth),
      lease_id: remote.leaseId,
      surface_id: remote.surfaceId,
    },
    demand,
  };
}

function staticSurfaceStatus(remoteSurface: ConnectionRemoteSurfaceEvidence | null): "absent" | "ready" | "unhealthy" {
  if (remoteSurface?.axis === "failed") {
    return "unhealthy";
  }
  return remoteSurface?.surfaceHealth === "ready" ? "ready" : "absent";
}

function compatibleIdleSurfaceCount(
  inventory: BrowserSurfaceRuntimeInventorySnapshot | null,
  connectorId: string,
  profileKey: string
): number {
  return (inventory?.surfaces ?? []).filter(
    (surface) =>
      surface.connector_id === connectorId &&
      surface.profile_key === profileKey &&
      surface.health === "ready" &&
      !surface.active_lease_id
  ).length;
}

function nonManagedConnectionKind(input: {
  readonly instance: RuntimeSummaryInstance;
  readonly browserSessionBound: boolean;
}): EphemeralBrowserConnectionKind {
  if (input.instance.sourceKind === "local_device") {
    return "local-device";
  }
  return input.browserSessionBound ? "unmanaged-browser" : "non-browser";
}

/**
 * Adapts one full-refresh allocator snapshot and bounded receipt evidence into
 * the exact runtime field used by the connection-health projection.
 */
export function projectConnectorEphemeralBrowserRuntime(input: {
  readonly activeRun: unknown | null;
  readonly connectionId: string;
  readonly connectorId: string;
  readonly instance: RuntimeSummaryInstance;
  readonly inventory: BrowserSurfaceRuntimeInventorySnapshot | null;
  readonly lastSuccessfulRuntimeReceipt: LastSuccessfulRuntimeReceipt | null;
  readonly management: BrowserSurfaceRuntimeManagement | null;
  readonly now: string;
  readonly profileKey: string;
  readonly remoteSurface: ConnectionRemoteSurfaceEvidence | null;
  readonly browserSessionBound: boolean;
}): EphemeralBrowserRuntimeProjection | null {
  if (!input.management) {
    return null;
  }
  if (!input.management.managed) {
    return projectEphemeralBrowserSurfaceHealth({
      connection_id: input.connectionId,
      connection_kind: nonManagedConnectionKind(input),
      surface_mode: "none",
    });
  }
  return managedRuntimeProjection(input, currentRuntimeLease(input));
}

/**
 * Complete summary adapter boundary: it reads the current management mode,
 * reads the last-successful-run receipt for a managed runtime, and assembles
 * the health projection. Callers only supply request-scoped facts; they do not
 * reinterpret lifecycle history.
 */
export async function projectConnectorHealthSummaryRuntime(input: {
  readonly activeRun: unknown | null;
  readonly connectionId: string;
  readonly connectorId: string;
  readonly controller: BrowserSurfaceRuntimeManagementReader | null | undefined;
  readonly instance: RuntimeSummaryInstance;
  readonly inventory: BrowserSurfaceRuntimeInventorySnapshot | null;
  readonly lastSuccessfulRun: LastSuccessfulRunLike | null;
  readonly now: string;
  readonly profileKey: string;
  readonly reader: BrowserSurfaceHealthSummaryReader;
  readonly remoteSurface: ConnectionRemoteSurfaceEvidence | null;
  readonly browserSessionBound: boolean;
}): Promise<EphemeralBrowserRuntimeProjection | null> {
  const management = input.controller?.getBrowserSurfaceRuntimeManagement?.(input.connectorId) ?? null;
  const lastSuccessfulRuntimeReceipt = management?.managed
    ? await readLastSuccessfulRuntimeReceipt({
        connectionId: input.connectionId,
        connectorId: input.connectorId,
        lastSuccessfulRun: input.lastSuccessfulRun,
        now: input.now,
        profileKey: input.profileKey,
        reader: input.reader,
      })
    : null;
  return projectConnectorEphemeralBrowserRuntime({
    activeRun: input.activeRun,
    browserSessionBound: input.browserSessionBound,
    connectionId: input.connectionId,
    connectorId: input.connectorId,
    instance: input.instance,
    inventory: input.inventory,
    lastSuccessfulRuntimeReceipt,
    management,
    now: input.now,
    profileKey: input.profileKey,
    remoteSurface: input.remoteSurface,
  });
}

/**
 * A dynamic runtime with no demand intentionally has no remote lease. This
 * adapter supplies the exact non-required surface fact and suppresses only the
 * corresponding store-unreliable marker; all other remote evidence is passed
 * through unchanged.
 */
export function connectionHealthRemoteSurface(input: {
  readonly remoteSurface: BrowserSurfaceHealthRemoteProjection;
  readonly runtime: EphemeralBrowserRuntimeProjection | null;
}): BrowserSurfaceHealthRemoteProjection {
  if (!isIdleDynamicRuntime(input.runtime)) {
    return input.remoteSurface;
  }
  return {
    evidence: {
      axis: "none",
      leaseId: null,
      leaseStatus: null,
      profileKey: null,
      surfaceHealth: null,
      surfaceId: null,
      waitReason: null,
    },
    unreliable: false,
  };
}

function isIdleDynamicRuntime(runtime: EphemeralBrowserRuntimeProjection | null): boolean {
  return runtime?.surface_mode === "dynamic-managed" && runtime.demand === "none" && runtime.active_lease === null;
}

function managedRuntimeProjection(
  input: Parameters<typeof projectConnectorEphemeralBrowserRuntime>[0],
  execution: RuntimeLeaseFacts
): EphemeralBrowserRuntimeProjection {
  if (input.management?.surface_mode === "static-managed") {
    return staticRuntimeProjection(input, execution);
  }
  return dynamicRuntimeProjection(input, execution);
}

function staticRuntimeProjection(
  input: Parameters<typeof projectConnectorEphemeralBrowserRuntime>[0],
  execution: RuntimeLeaseFacts
): EphemeralBrowserRuntimeProjection {
  return projectEphemeralBrowserSurfaceHealth({
    active_lease: execution.active_lease,
    connection_id: input.connectionId,
    connection_kind: "browser-runtime",
    demand: execution.demand,
    surface_mode: "static-managed",
    last_successful_runtime_receipt: input.lastSuccessfulRuntimeReceipt,
    static_surface: {
      readable: input.remoteSurface?.axis !== "unknown",
      status: staticSurfaceStatus(input.remoteSurface),
    },
  });
}

function dynamicRuntimeProjection(
  input: Parameters<typeof projectConnectorEphemeralBrowserRuntime>[0],
  execution: RuntimeLeaseFacts
): EphemeralBrowserRuntimeProjection {
  return projectEphemeralBrowserSurfaceHealth({
    active_lease: execution.active_lease,
    allocator_observation: input.inventory?.allocator_observation ?? { reason: "not_observed", status: "unknown" },
    connection_id: input.connectionId,
    connection_kind: "browser-runtime",
    current_compatible_idle_surfaces: compatibleIdleSurfaceCount(input.inventory, input.connectorId, input.profileKey),
    demand: execution.demand,
    surface_mode: "dynamic-managed",
    last_successful_runtime_receipt: input.lastSuccessfulRuntimeReceipt,
    now: input.now,
  });
}
