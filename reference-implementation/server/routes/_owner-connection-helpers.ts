// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Shared helpers for the owner-connection route-family adapters.
//
// All five functions in this file are behavior-identical copies extracted
// verbatim from the six mutation files (owner-connection-{run,revoke,
// diagnostics,delete,reactivate,schedule}.ts) and owner-connections.ts.
// They are pure utility functions with no side effects beyond the ctx
// calls they delegate; each caller file drops its local copy and imports
// from here. No logic or operator changes are made.
//
// Structural ctx types are intentionally narrow — each helper declares
// only the ctx fields it actually reads, so any caller whose concrete ctx
// object satisfies the structural constraint (all six do) is accepted by
// TypeScript without additional coupling.

import { type OwnerActor, type OwnerSurface, ownerActorAuditData } from "./_owner-actor.ts";
import type { TraceContext, WireConnection } from "./_route-contract.ts";
import { codeToStatus } from "./ref-error-status.ts";

// Minimal request slice all helpers need (tokenInfo only).
interface TokenInfoRequest {
  readonly tokenInfo?: {
    readonly pdpp_token_kind?: string | null;
    readonly scenario_id?: string | null;
  } | null;
}

// ---- auditActorKind --------------------------------------------------------

// Returns the actor-kind label to record in spine events.  Reads only the
// `pdpp_token_kind` field on `req.tokenInfo`.
export function auditActorKind(req: TokenInfoRequest): "owner_agent" | "client" | "mcp_package" | "unknown" {
  const kind = req.tokenInfo?.pdpp_token_kind;
  if (kind === "owner") {
    return "owner_agent";
  }
  if (kind === "client" || kind === "mcp_package") {
    return kind;
  }
  return "unknown";
}

// ---- buildAuditTrace -------------------------------------------------------

// Minimal ctx slice buildAuditTrace needs.
interface AuditTraceCtx<Response> {
  createTraceContext: (input?: { scenarioId?: string }) => TraceContext;
  ensureRequestId: (res: Response) => string;
  setReferenceTraceId: (res: Response, traceId: string) => void;
}

// Builds and attaches a trace context for the current request.  Sets the
// `X-Reference-Trace-Id` response header via ctx.setReferenceTraceId and
// returns the { request_id, scenario_id, trace_id } triple for embedding in
// spine events.
export function buildAuditTrace<Response>(
  ctx: AuditTraceCtx<Response>,
  req: TokenInfoRequest,
  res: Response
): TraceContext {
  const scenarioId = typeof req.tokenInfo?.scenario_id === "string" ? req.tokenInfo.scenario_id : undefined;
  const trace = scenarioId ? ctx.createTraceContext({ scenarioId }) : ctx.createTraceContext();
  const requestId = ctx.ensureRequestId(res);
  ctx.setReferenceTraceId(res, trace.trace_id);
  return {
    request_id: requestId,
    scenario_id: trace.scenario_id,
    trace_id: trace.trace_id,
  };
}

// ---- readConnectionTarget --------------------------------------------------

// Minimal ctx slice readConnectionTarget needs.
interface ConnectionTargetCtx {
  canonicalConnectorKey: (value: string | null | undefined) => string | null;
}

// Minimal request slice readConnectionTarget needs.
interface ConnectionTargetRequest {
  readonly params: Readonly<Record<string, string>>;
}

// Reads the addressed target from the request path for audit labelling.
// For a connection-scoped route this is the `connection_id`; for a
// connector-scoped route it is the canonical connector key.
export function readConnectionTarget(
  ctx: ConnectionTargetCtx,
  req: ConnectionTargetRequest,
  selector: "connection_id" | "connector_id"
): { connectionId: string | null; connectorKey: string | null } {
  if (selector === "connection_id") {
    const connectionId = req.params.connectionId ? decodeURIComponent(req.params.connectionId) : null;
    return { connectionId, connectorKey: null };
  }
  const raw = req.params.connectorId ? decodeURIComponent(req.params.connectorId) : null;
  const connectorKey = raw ? (ctx.canonicalConnectorKey(raw) ?? raw) : null;
  return { connectionId: null, connectorKey };
}

// ---- rethrowAsAmbiguousConnection ------------------------------------------

// Minimal ctx slice rethrowAsAmbiguousConnection needs.
interface AmbiguousConnectionCtx {
  AmbiguousConnectionError: new (message: string, availableConnections: WireConnection[]) => Error;
  listActiveBindingsForGrant: (input: {
    ownerSubjectId: string;
    connectorId: string;
  }) =>
    | Promise<{ connectorId?: string | null; connectorInstanceId: string; displayName?: string | null }[]>
    | { connectorId?: string | null; connectorInstanceId: string; displayName?: string | null }[];
  projectBindingForWire: (instance: {
    connectorId?: string | null;
    connectorInstanceId: string;
    displayName?: string | null;
  }) => WireConnection | null;
}

// Maps the store's connector-only ambiguity (`ambiguous_connector_instance`)
// to the public, typed `ambiguous_connection` (409) error carrying the
// available `connection_id` values + owner-meaningful labels and
// `retry_with: connection_id`. Any other resolver error is rethrown unchanged.
export async function rethrowAsAmbiguousConnection(
  ctx: AmbiguousConnectionCtx,
  err: unknown,
  ownerSubjectId: string,
  connectorKey: string
): Promise<never> {
  // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
  if ((err as { code?: unknown })?.code !== "ambiguous_connector_instance") {
    throw err;
  }
  const active = await Promise.resolve(ctx.listActiveBindingsForGrant({ connectorId: connectorKey, ownerSubjectId }));
  const available = active
    .map((binding) => ctx.projectBindingForWire(binding))
    .filter((row): row is WireConnection => row !== null);
  throw new ctx.AmbiguousConnectionError(
    `Connector '${connectorKey}' has multiple active connections. Retry with a specific connection_id.`,
    available
  );
}

// ---- httpStatusForOperationError -------------------------------------------

// Maps a domain error `code` to its HTTP status via the shared codeToStatus
// table, defaulting to 500 for unknown codes.  Used by all mutation adapters
// except owner-connection-diagnostics (which has a divergent hand-coded map).
export function httpStatusForOperationError(err: unknown): number {
  // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
  const code = (err as { code?: unknown })?.code;
  return typeof code === "string" ? (codeToStatus[code] ?? 500) : 500;
}

// ---- shared connection controls across both route families -----------------

// How one route mounts a shared connection-control handler: the auth surface,
// how the target is addressed, the route param that carries it, and how the
// route resolves the requesting owner. The cookie `/_ref/connections/:id/...`
// routes and the bearer `/v1/owner/{connections,connectors}/:id/...` routes
// mount the same handler with different bindings.
export interface ConnectionControlBinding {
  readonly ownerSubjectId: (req: unknown) => string;
  readonly param: "connectionId" | "connectorId" | "connectorInstanceId";
  readonly selector: "connection_id" | "connector_id";
  readonly surface: OwnerSurface;
}

export function ownerSessionConnectionBinding(getOwnerSubjectId: (req: unknown) => string): ConnectionControlBinding {
  return {
    ownerSubjectId: getOwnerSubjectId,
    param: "connectorInstanceId",
    selector: "connection_id",
    surface: "owner_session",
  };
}

export function ownerBearerConnectionBinding(
  getOwnerTokenSubjectId: (req: unknown) => string,
  selector: "connection_id" | "connector_id"
): ConnectionControlBinding {
  return {
    ownerSubjectId: getOwnerTokenSubjectId,
    param: selector === "connection_id" ? "connectionId" : "connectorId",
    selector,
    surface: "owner_bearer",
  };
}

// A typed rejection a handler answered itself (as opposed to an error it
// passed to `handleError`), for the audit's `error` block.
export interface ConnectionControlRejection {
  readonly code: string;
  readonly http_status: number;
}

function connectionAuditError(error: unknown): Record<string, unknown> {
  if (!error) {
    return {};
  }
  const { code, http_status: httpStatus } = error as { code?: unknown; http_status?: unknown };
  return {
    error: {
      code: typeof code === "string" ? code : "api_error",
      http_status: typeof httpStatus === "number" ? httpStatus : httpStatusForOperationError(error),
    },
  };
}

export interface OwnerConnectionAuditContext {
  emitSpineEvent: (event: Record<string, unknown>) => Promise<unknown>;
}

export interface OwnerConnectionAuditArgs {
  readonly connectionId: string | null;
  readonly connectorKey: string | null;
  readonly error?: unknown;
  /** Operation-specific, non-secret audit facts (e.g. `profile_purge`, `label_status`). */
  readonly facts?: Readonly<Record<string, unknown>>;
  readonly operation: "revoke" | "reactivate" | "rename_connection";
  readonly outcome: "succeeded" | "failed";
  readonly selector: "connection_id" | "connector_id";
  readonly trace: TraceContext;
}

const OWNER_CONNECTION_AUDIT_EVENT_TYPE: Record<OwnerConnectionAuditArgs["operation"], string> = {
  reactivate: "owner_agent.connection.reactivate",
  rename_connection: "owner_agent.connection.rename",
  revoke: "owner_agent.connection.revoke",
};

// Emits one non-secret audit event for a shared connection control, on either
// surface. The event type is the same on both; `actor_type` and the actor
// fields in `data` name the surface. Never carries a bearer token, a session
// credential, or a provider secret.
export async function emitOwnerConnectionAudit(
  ctx: OwnerConnectionAuditContext,
  actor: OwnerActor,
  args: OwnerConnectionAuditArgs
): Promise<void> {
  await ctx.emitSpineEvent({
    actor_id: actor.actorId,
    actor_type: actor.actorKind,
    client_id: actor.clientId,
    data: {
      ...ownerActorAuditData(actor),
      connection_id: args.connectionId,
      connector_key: args.connectorKey,
      operation: args.operation,
      outcome: args.outcome,
      selector: args.selector,
      target_resource: "connection",
      ...args.facts,
      ...connectionAuditError(args.error),
    },
    event_type: OWNER_CONNECTION_AUDIT_EVENT_TYPE[args.operation],
    object_id: args.connectionId || args.connectorKey || "unknown_connection",
    object_type: "connection",
    request_id: args.trace.request_id,
    scenario_id: args.trace.scenario_id,
    status: args.outcome,
    subject_id: actor.ownerSubjectId,
    subject_type: "subject",
    trace_id: args.trace.trace_id,
  });
}

// Narrows a shared handler context to one that can address a connection by
// connector type. Only the bearer `/v1/owner/connectors/:connectorId/...`
// bindings take that path, and their mounts always pass these fields; the
// cookie routes address a connection id only and do not wire them.
export function requireConnectorAddressing<T extends object, K extends keyof T>(
  ctx: T,
  keys: readonly K[]
): T & Required<Pick<T, K>> {
  for (const key of keys) {
    if (ctx[key] === undefined) {
      throw new Error(`connector_id addressing requires ${String(key)} on the route context`);
    }
  }
  return ctx as T & Required<Pick<T, K>>;
}
