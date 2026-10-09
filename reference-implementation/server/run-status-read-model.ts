// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Run-status read model: the one projection of a run identifier to its
// owner-visible status for the run's whole lifecycle.
//
// Every owner surface that describes a run reads it through
// `readRunStatus`:
//   - `GET /_ref/runs/:runId` (cookie owner session, server/routes/ref-run-status.ts);
//   - `GET /v1/owner/runs/:runId` (owner bearer, server/routes/owner-runs.ts);
//   - `last_run` in `GET /v1/owner/connections/:id/diagnostics`
//     (server/ref-control.ts `getOwnerConnectionDiagnostics`).
// So the status vocabulary, failure summary, and redaction posture cannot
// drift between surfaces. The only per-surface difference is the route
// family `links` point into.
//
// Resolution order (durable truth first):
//   - terminal: the run's most-recent terminal spine event
//     (`run.completed` / `run.failed` / `run.cancelled` / `run.abandoned`),
//     window-independent and durable;
//   - active: the controller's in-process active-run bookkeeping;
//   - started-but-unresolved: a `run.started` event with no terminal event
//     and no in-process owner, reported as `active`;
//   - browser-surface lifecycle: a run that never got past browser-surface
//     acquisition;
//   - otherwise `null` (callers map it to a typed `not_found`).
//
// Failure fields are the typed, bounded values the runtime stamped on the
// terminal event (reason, failure origin, bounded messages). No raw
// connector stderr, secrets, or tokens are added.
//
// See openspec/changes/surface-run-handle-resolvability.

import { getRunStartedEvent, getRunTerminalEvent, listSpineEventsPage } from "../lib/spine.ts";

/** Structural slice of the controller's `ActiveRun` projection. */
export interface RunStatusActiveRun {
  readonly connector_id: string;
  readonly connector_instance_id: string;
  readonly run_id: string;
  readonly started_at: string;
  readonly trace_id: string;
}

export interface RunStatusController {
  findActiveRunByRunId: (runId: string) => RunStatusActiveRun | null;
}

/** Structural slice of `lib/spine.ts` `RunLifecycleEventSummary`. */
export interface RunStatusLifecycleEvent {
  readonly actor_id: string | null;
  readonly data: Readonly<Record<string, unknown>> | null;
  readonly event_type: string;
  readonly occurred_at: string | null;
  readonly status?: string | null;
  readonly trace_id: string | null;
}

export type RunStatusTerminalEvent = RunStatusLifecycleEvent & {
  readonly status: "completed" | "failed" | "cancelled" | "abandoned";
};

export type BrowserSurfaceRunStatus =
  | "cancelled"
  | "deferred"
  | "expired"
  | "leased"
  | "released"
  | "starting_surface"
  | "surface_failed"
  | "waiting_for_browser_surface";

export interface RunStatusFailureSummary {
  readonly connector_error_message: string | null;
  readonly message: string | null;
  readonly origin: string | null;
  readonly recovery_hint?: { readonly action: "refresh_credentials"; readonly retryable: false } | null;
  readonly reason: string | null;
}

function isConnectorAuthFailure(code: string | null): boolean {
  return code !== null && /(?:^|[_-])auth(?:entication)?[_-](?:failed|failure)$/.test(code);
}

export interface RunStatusBody {
  readonly completed_at: string | null;
  readonly connector_id: string | null;
  readonly connector_instance_id: string | null;
  readonly failure: RunStatusFailureSummary | null;
  /**
   * Passthrough of the terminal event's raw `known_gaps` / `known_gaps_summary`
   * payload — same fields the timeline route serves off the same event, but
   * resolved here via the window-independent `LIMIT 1` terminal-event query.
   * Absent when the run has no terminal event yet. The console normalizes
   * these via `run-gaps.ts#extractKnownGapsFromEventData`.
   */
  readonly known_gaps?: unknown;
  readonly known_gaps_summary?: unknown;
  readonly links: { readonly timeline: string };
  readonly object: "run_status";
  readonly run_id: string;
  readonly started_at: string | null;
  readonly status: "active" | "completed" | "failed" | "cancelled" | "abandoned" | BrowserSurfaceRunStatus;
  readonly terminal_reason: string | null;
  readonly trace_id: string | null;
}

/**
 * Route family a run-status body links into. The cookie owner-session
 * surface serves `/_ref/runs/*`; the owner-bearer surface serves
 * `/v1/owner/runs/*`. The body is otherwise identical on both surfaces.
 */
export type RunLinkBase = "/_ref/runs" | "/v1/owner/runs";

export const REF_RUN_LINK_BASE: RunLinkBase = "/_ref/runs";
export const OWNER_RUN_LINK_BASE: RunLinkBase = "/v1/owner/runs";

/**
 * Owner-bearer links for one run: its status and its timeline. The run-now
 * 202 and diagnostics `last_run` both hand an owner agent these links.
 */
export function ownerRunLinks(runId: string): { readonly run: string; readonly timeline: string } {
  return {
    run: `${OWNER_RUN_LINK_BASE}/${encodeURIComponent(runId)}`,
    ...timelineLink(runId, OWNER_RUN_LINK_BASE),
  };
}

function timelineLink(runId: string, linkBase: RunLinkBase): { timeline: string } {
  return { timeline: `${linkBase}/${encodeURIComponent(runId)}/timeline` };
}

function readString(data: Readonly<Record<string, unknown>> | null, key: string): string | null {
  const value = data?.[key];
  return typeof value === "string" && value ? value : null;
}

function browserSurfaceProjection(event: RunStatusLifecycleEvent | null): Readonly<Record<string, unknown>> | null {
  const value = event?.data?.browser_surface;
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function readBrowserSurfaceStatus(event: RunStatusLifecycleEvent | null): BrowserSurfaceRunStatus | null {
  const value = browserSurfaceProjection(event)?.browser_surface_status;
  return typeof value === "string" && value ? (value as BrowserSurfaceRunStatus) : null;
}

function readBrowserSurfaceReason(event: RunStatusLifecycleEvent | null): string | null {
  const value = browserSurfaceProjection(event)?.browser_surface_wait_reason;
  return typeof value === "string" && value ? value : null;
}

function readBrowserSurfaceConnectionId(event: RunStatusLifecycleEvent | null): string | null {
  const profileKey = browserSurfaceProjection(event)?.browser_surface_profile_key;
  if (typeof profileKey !== "string" || !profileKey) {
    return null;
  }
  const suffix = profileKey.split(":").at(-1);
  return suffix?.startsWith("cin_") ? suffix : null;
}

// Connector identity on spine-resolved runs: run lifecycle events stamp the
// connector id as `actor_id` and as `data.source.id` ({ kind: "connector" }).
function readConnectorId(event: RunStatusLifecycleEvent | null): string | null {
  if (!event) {
    return null;
  }
  if (event.actor_id) {
    return event.actor_id;
  }
  const source = event.data?.source;
  if (source && typeof source === "object" && !Array.isArray(source)) {
    // biome-ignore lint/style/useDestructuring: Explicit property or positional access documents this compatibility boundary.
    const id = (source as Record<string, unknown>).id;
    if (typeof id === "string" && id) {
      return id;
    }
  }
  return null;
}

// Typed failure summary for failed/abandoned terminals. Values are the
// runtime-authored, bounded fields already persisted on the terminal spine
// event (`buildRunTerminalData` / the controller's launch-failure emit) —
// no new secret surface beyond what the timeline route serves.
function buildFailureSummary(terminal: RunStatusTerminalEvent): RunStatusFailureSummary | null {
  if (terminal.status !== "failed" && terminal.status !== "abandoned") {
    return null;
  }
  const connectorError = readString(terminal.data, "connector_error_message");
  const authFailure = isConnectorAuthFailure(connectorError);
  return {
    connector_error_message: connectorError,
    message:
      readString(terminal.data, "failure_message") ??
      readString(terminal.data, "message") ??
      (authFailure ? "Your saved sign-in is no longer accepted. Reconnect this source to sync again." : null),
    origin: readString(terminal.data, "failure_origin"),
    ...(authFailure ? { recovery_hint: { action: "refresh_credentials" as const, retryable: false as const } } : {}),
    reason: readString(terminal.data, "reason") ?? readString(terminal.data, "failure_reason"),
  };
}

export function buildTerminalRunStatusBody(
  runId: string,
  terminal: RunStatusTerminalEvent,
  started: RunStatusLifecycleEvent | null,
  linkBase: RunLinkBase = REF_RUN_LINK_BASE
): RunStatusBody {
  return {
    completed_at: terminal.occurred_at,
    connector_id: readConnectorId(started) ?? readConnectorId(terminal),
    // The spine does not carry the connection (connector-instance) id;
    // it is only known while the controller's flight state owns the run.
    connector_instance_id: null,
    failure: buildFailureSummary(terminal),
    known_gaps: terminal.data?.known_gaps,
    known_gaps_summary: terminal.data?.known_gaps_summary,
    links: timelineLink(runId, linkBase),
    object: "run_status",
    run_id: runId,
    started_at: started?.occurred_at ?? null,
    status: terminal.status,
    terminal_reason: readString(terminal.data, "reason") ?? readString(terminal.data, "failure_reason"),
    trace_id: started?.trace_id ?? terminal.trace_id,
  };
}

export function buildActiveRunStatusBody(
  active: RunStatusActiveRun,
  linkBase: RunLinkBase = REF_RUN_LINK_BASE
): RunStatusBody {
  return {
    completed_at: null,
    connector_id: active.connector_id,
    connector_instance_id: active.connector_instance_id,
    failure: null,
    links: timelineLink(active.run_id, linkBase),
    object: "run_status",
    run_id: active.run_id,
    started_at: active.started_at,
    status: "active",
    terminal_reason: null,
    trace_id: active.trace_id,
  };
}

function buildStartedOnlyRunStatusBody(
  runId: string,
  started: RunStatusLifecycleEvent,
  linkBase: RunLinkBase
): RunStatusBody {
  // `run.started` exists but no terminal event and no in-process owner —
  // the honest projection is "no terminal recorded yet"; boot reconciliation
  // will convert orphans to a terminal `run.failed` on the next start.
  return {
    completed_at: null,
    connector_id: readConnectorId(started),
    connector_instance_id: null,
    failure: null,
    links: timelineLink(runId, linkBase),
    object: "run_status",
    run_id: runId,
    started_at: started.occurred_at,
    status: "active",
    terminal_reason: null,
    trace_id: started.trace_id,
  };
}

function buildBrowserSurfaceRunStatusBody(
  runId: string,
  event: RunStatusLifecycleEvent,
  linkBase: RunLinkBase
): RunStatusBody | null {
  if (!event.event_type.startsWith("run.browser_surface_")) {
    return null;
  }
  const fallbackStatus =
    typeof event.status === "string" && event.status ? (event.status as BrowserSurfaceRunStatus) : null;
  const surfaceStatus = readBrowserSurfaceStatus(event) ?? fallbackStatus;
  if (!surfaceStatus) {
    return null;
  }
  const terminal =
    surfaceStatus === "cancelled" ||
    surfaceStatus === "deferred" ||
    surfaceStatus === "expired" ||
    surfaceStatus === "released" ||
    surfaceStatus === "surface_failed";
  const reason = readBrowserSurfaceReason(event);
  return {
    completed_at: terminal ? event.occurred_at : null,
    connector_id: readConnectorId(event),
    connector_instance_id: readBrowserSurfaceConnectionId(event),
    failure:
      surfaceStatus === "surface_failed"
        ? {
            connector_error_message: null,
            message: null,
            origin: "browser_surface",
            reason,
          }
        : null,
    links: timelineLink(runId, linkBase),
    object: "run_status",
    run_id: runId,
    started_at: null,
    status: surfaceStatus,
    terminal_reason: terminal ? reason : null,
    trace_id: event.trace_id,
  };
}

/** Reads the run-status projection needs. */
export interface RunStatusReader {
  readonly controller: RunStatusController | null | undefined;
  getLatestRunEvent?: (runId: string) => Promise<RunStatusLifecycleEvent | null> | RunStatusLifecycleEvent | null;
  getRunStartedEvent: (runId: string) => Promise<RunStatusLifecycleEvent | null> | RunStatusLifecycleEvent | null;
  getRunTerminalEvent: (runId: string) => Promise<RunStatusTerminalEvent | null> | RunStatusTerminalEvent | null;
}

/**
 * Resolves a run id to its status body, or `null` when no surface knows the
 * run. Shared by every owner surface (see the module header).
 */
export async function readRunStatus(
  reader: RunStatusReader,
  runId: string,
  linkBase: RunLinkBase
): Promise<RunStatusBody | null> {
  // Durable truth first: once a terminal event exists it wins over any
  // not-yet-finalized in-memory flight state.
  const terminal = await reader.getRunTerminalEvent(runId);
  if (terminal) {
    const browserSurfaceStatus = buildBrowserSurfaceRunStatusBody(runId, terminal, linkBase);
    if (browserSurfaceStatus) {
      return browserSurfaceStatus;
    }
    const started = await reader.getRunStartedEvent(runId);
    return buildTerminalRunStatusBody(runId, terminal, started, linkBase);
  }

  // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
  const active = reader.controller?.findActiveRunByRunId?.(runId) ?? null;
  if (active) {
    return buildActiveRunStatusBody(active, linkBase);
  }

  const started = await reader.getRunStartedEvent(runId);
  if (started) {
    return buildStartedOnlyRunStatusBody(runId, started, linkBase);
  }

  const latest = (await reader.getLatestRunEvent?.(runId)) ?? null;
  return latest ? buildBrowserSurfaceRunStatusBody(runId, latest, linkBase) : null;
}

/** The production reader: spine lookups plus the controller's flight state. */
export function createSpineRunStatusReader(controller: RunStatusController | null | undefined): RunStatusReader {
  return {
    controller,
    getLatestRunEvent: async (runId: string) => {
      const page = await listSpineEventsPage("run", runId, { limit: 20 });
      return (page.events.at(-1) ?? null) as RunStatusLifecycleEvent | null;
    },
    getRunStartedEvent: (runId: string) => getRunStartedEvent(runId),
    getRunTerminalEvent: (runId: string) => getRunTerminalEvent(runId),
  };
}
