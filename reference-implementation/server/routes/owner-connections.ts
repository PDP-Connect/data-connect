// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// HTTP adapter for the bearer-authed owner-agent control surface routes
// `GET /v1/owner/connections` and `PATCH /v1/owner/connections/:connectionId`
// (rename).
//
// This is the owner-agent (bearer) sibling of the cookie-authed
// `GET /_ref/connections` listing and `PATCH /_ref/connections/:id` rename in
// `server/routes/ref-connectors.ts`; both families mount the handlers built
// here (`buildConnectionsListHandler`, `buildConnectionRenameHandler`). Per the
// owner-agent control-surface audit (Lane B) it lives in the `/v1/owner/*`
// route family so it reuses the existing owner-bearer guards
// (`requireToken` + `requireOwner`) without teaching `requireOwnerSession`
// (cookie) a second identity source. `/mcp` owner-bearer rejection
// (`requireClientOrMcpPackage`) is untouched.
//
// The route reuses the connector-instance store, the connector-key
// canonicalizer, and the public-read display-name projection so the
// owner-agent surface agrees with public read on `connection_id`,
// `display_name`, and the fallback/label-needed distinction.
//
// Spec: openspec/changes/add-owner-agent-control-surface/specs/
//       reference-owner-agent-control-surface/spec.md
//       (#"Owner-agent control SHALL distinguish connector templates from
//         connection instances")
//       openspec/changes/add-owner-agent-control-surface/specs/
//       reference-connector-instances/spec.md
//       (#"Owner control surfaces SHALL expose connection identity before
//         instance operations")

import type { OwnerAgentControlAction } from "../metadata.ts";
import { resolveOwnerActor, startOwnerAuditTrace } from "./_owner-actor.ts";
import {
  type ConnectionControlBinding,
  emitOwnerConnectionAudit,
  ownerBearerConnectionBinding,
} from "./_owner-connection-helpers.ts";
import type { MiddlewareHandler, PdppErrorFn, RouteArg, TraceContext } from "./_route-contract.ts";

// Express-shaped surface, structurally typed to avoid pulling in the
// transport's `.js` ambient types. Matches the pattern established in
// `server/routes/ref-connectors.ts` and `server/routes/rs-mutation.ts`.

interface RouteRequest {
  readonly body?: unknown;
  readonly ownerSession?: { readonly sub?: string | null } | null;
  readonly params: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, unknown>>;
  readonly tokenInfo?: {
    readonly client_id?: string | null;
    readonly client_name?: string | null;
    readonly pdpp_token_kind?: string | null;
    readonly scenario_id?: string | null;
    readonly subject_id?: string | null;
  } | null;
}

interface RouteResponse {
  end: () => unknown;
  getHeader: (name: string) => string | number | string[] | undefined;
  json: (body: unknown) => unknown;
  setHeader: (name: string, value: string) => void;
  status: (code: number) => RouteResponse;
}

type RouteHandler = (req: RouteRequest, res: RouteResponse) => unknown | Promise<unknown>;
type NextFn = () => unknown | Promise<unknown>;

interface AppLike {
  get: (path: string, ...args: RouteArg<RouteHandler>[]) => AppLike;
  patch: (path: string, ...args: RouteArg<RouteHandler>[]) => AppLike;
}

// Minimal connector-instance shape this adapter projects. The substrate
// store carries additional fields; these are the ones the projection reads.
interface ConnectorInstanceRow {
  readonly connectorId: string;
  readonly connectorInstanceId: string;
  readonly createdAt?: string | null;
  readonly displayName?: string | null;
  readonly revokedAt?: string | null;
  readonly sourceBinding?: unknown;
  readonly sourceKind?: string | null;
  readonly status?: string | null;
  readonly updatedAt?: string | null;
}

interface ScheduleRow {
  readonly connector_instance_id?: string | null;
}

interface ConnectorInstanceStore {
  get: (connectorInstanceId: string) => Promise<ConnectorInstanceRow | null> | ConnectorInstanceRow | null;
  listByOwner: (ownerSubjectId: string) => Promise<ConnectorInstanceRow[]> | ConnectorInstanceRow[];
  setDisplayName: (
    connectorInstanceId: string,
    options: { ownerSubjectId: string; displayName: string; updatedAt: string }
  ) => Promise<ConnectorInstanceRow>;
}

export interface MountOwnerConnectionsContext {
  // Projects the instance-scoped subset of the owner-agent control catalog for
  // one connection, from the same single source of truth `GET /v1/owner/control`
  // reads, so a row's `supported_actions` can never disagree with the control
  // document. Supported instance actions carry the connection's concrete URL.
  buildOwnerConnectionSupportedActions: (input: {
    connectionId: string;
    resource: string;
  }) => OwnerAgentControlAction[];
  canonicalConnectorKey: (value: string | null | undefined) => string | null;
  createRequestConnectorInstanceStore: () => ConnectorInstanceStore;
  createTraceContext: (input?: { scenarioId?: string }) => TraceContext;
  emitSpineEvent: (event: Record<string, unknown>) => Promise<unknown>;
  ensureRequestId: (res: RouteResponse) => string;
  getOwnerTokenSubjectId: (req: unknown) => string;
  handleError: (res: unknown, err: unknown) => void;
  invalidateConnectorSummariesCache?: () => void;
  listSchedules: () => Promise<ScheduleRow[]> | ScheduleRow[];
  // Marks the maintained connector-summary read-model evidence for exactly this
  // connection dirty after the rename commits (display_name is durable summary
  // evidence). Injected (not imported) to match the optional
  // `invalidateConnectorSummariesCache` above; awaited, best-effort, and a no-op
  // until the read model is warmed.
  markConnectorSummaryEvidenceDirty?: (input: { connectorInstanceId: string; reason?: string }) => Promise<void> | void;
  // Wall-clock stamp for the `updated_at` recorded on rename. Injected so the
  // route stays deterministic under test and so this module does not import a
  // clock. Defaults to `new Date().toISOString()` at the call site.
  now?: () => string;
  pdppError: PdppErrorFn;
  // Filters a stored `display_name` to an owner-meaningful label, or `null`
  // when the value is a storage-layer placeholder / connector-type fallback.
  // Reused from `server/connection-id-request.js` so this surface agrees
  // with public read on what counts as "label-needed".
  projectStorageDisplayName: (
    displayName: string | null | undefined,
    options: { connectorId?: string | null; connectorInstanceId?: string | null }
  ) => string | null;
  requireOwner: MiddlewareHandler;
  requireToken: MiddlewareHandler;
  // Resolves the caller-visible trusted RS public base for this request (same
  // forwarded-origin handling as the control entrypoint), so a row's
  // `supported_actions` URLs name the advertised resource exactly.
  resolveResource: (req: unknown) => string;
  resolveSingleConnectorIdQueryValue: (raw: unknown) => string | null;
  setReferenceTraceId: (res: RouteResponse, traceId: string) => void;
}

// The context the shared list and rename handlers need on either surface.
// `buildOwnerConnectionSupportedActions` and `resolveResource` are read only
// on the bearer surface (see `projectOwnerConnection`).
export type ConnectionsContext = Omit<
  MountOwnerConnectionsContext,
  | "buildOwnerConnectionSupportedActions"
  | "getOwnerTokenSubjectId"
  | "requireOwner"
  | "requireToken"
  | "resolveResource"
> &
  Partial<Pick<MountOwnerConnectionsContext, "buildOwnerConnectionSupportedActions" | "resolveResource">>;

// Owner projection of a connector instance: one row shape for a connection on
// every owner surface (the cookie `/_ref/connections` routes and the bearer
// `/v1/owner/connections` routes). Standardizes on `connection_id` as the
// stable selector and keeps `connector_instance_id` as a deprecated alias for
// compatibility with older clients. Emits both `connector_id` and
// `connector_key` (canonicalized) so a caller can match the connector type
// regardless of which identifier it persisted. Surfaces `label_status` so a
// caller can tell an owner-chosen label (`owner_set`) from a storage-layer
// fallback (`fallback`, i.e. label-needed) without re-deriving the
// placeholder rules.
export function projectOwnerConnectionRow(
  ctx: Pick<ConnectionsContext, "canonicalConnectorKey" | "projectStorageDisplayName">,
  instance: ConnectorInstanceRow,
  schedulesByInstanceId: ReadonlyMap<string, unknown>
): Record<string, unknown> {
  const connectorKey = ctx.canonicalConnectorKey(instance.connectorId) ?? instance.connectorId;
  const ownerMeaningfulName = ctx.projectStorageDisplayName(instance.displayName, {
    connectorId: connectorKey,
    connectorInstanceId: instance.connectorInstanceId,
  });
  return {
    connection_id: instance.connectorInstanceId,
    connector_id: connectorKey,
    // Deprecated alias for the stable `connection_id` selector. Kept for
    // compatibility; callers SHOULD persist `connection_id`.
    connector_instance_id: instance.connectorInstanceId,
    connector_key: connectorKey,
    created_at: instance.createdAt,
    // The raw stored display name (may be a fallback). `label_status`
    // tells the caller whether this is owner-meaningful or label-needed.
    display_name: instance.displayName,
    label_status: ownerMeaningfulName ? "owner_set" : "fallback",
    object: "owner_connection",
    revoked_at: instance.revokedAt,
    schedule: schedulesByInstanceId.get(instance.connectorInstanceId) || null,
    source_binding: instance.sourceBinding,
    source_kind: instance.sourceKind,
    status: instance.status,
    updated_at: instance.updatedAt,
  };
}

// On the bearer surface each row also carries `supported_actions`: the
// instance-scoped owner-agent control actions for this exact connection,
// projected from the same catalog `GET /v1/owner/control` reads. Their URLs
// point into the bearer route family, so the cookie surface omits them, the
// same way run-status `links` follow the caller's route family.
function projectOwnerConnection(
  ctx: ConnectionsContext,
  binding: ConnectionControlBinding,
  req: RouteRequest,
  instance: ConnectorInstanceRow,
  schedulesByInstanceId: ReadonlyMap<string, unknown>
): Record<string, unknown> {
  const row = projectOwnerConnectionRow(ctx, instance, schedulesByInstanceId);
  if (binding.surface !== "owner_bearer" || !ctx.buildOwnerConnectionSupportedActions || !ctx.resolveResource) {
    return row;
  }
  return {
    ...row,
    supported_actions: ctx.buildOwnerConnectionSupportedActions({
      connectionId: instance.connectorInstanceId,
      resource: ctx.resolveResource(req),
    }),
  };
}

function connectorIdMatchesFilter(
  ctx: ConnectionsContext,
  instance: ConnectorInstanceRow,
  connectorId: string | null
): boolean {
  if (!connectorId) {
    return true;
  }
  return (ctx.canonicalConnectorKey(instance.connectorId) ?? instance.connectorId) === connectorId;
}

async function schedulesByConnection(ctx: ConnectionsContext): Promise<Map<string, unknown>> {
  const schedules = await ctx.listSchedules();
  return new Map<string, unknown>(
    schedules
      .filter((schedule) => schedule?.connector_instance_id)
      .map((schedule) => [schedule.connector_instance_id as string, schedule])
  );
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

// The one connection-list handler, mounted by `GET /_ref/connections` and
// `GET /v1/owner/connections`. Lists every configured connection the owner
// has, filtered by `connector_id` (canonicalized, so a URL-shaped registry id
// matches the canonical key instances are stored under) and `status`.
export function buildConnectionsListHandler(ctx: ConnectionsContext, binding: ConnectionControlBinding): RouteHandler {
  return async (req: RouteRequest, res: RouteResponse) => {
    try {
      const ownerSubjectId = binding.ownerSubjectId(req);
      const rawConnectorId = ctx.resolveSingleConnectorIdQueryValue(req.query.connector_id);
      const connectorId = rawConnectorId
        ? (ctx.canonicalConnectorKey(rawConnectorId) ?? rawConnectorId)
        : rawConnectorId;
      const status = ctx.resolveSingleConnectorIdQueryValue(req.query.status);
      const store = ctx.createRequestConnectorInstanceStore();
      const instances = await store.listByOwner(ownerSubjectId);
      const schedules = await schedulesByConnection(ctx);
      const data = instances
        .filter((instance) => connectorIdMatchesFilter(ctx, instance, connectorId))
        .filter((instance) => !status || instance.status === status)
        .map((instance) => projectOwnerConnection(ctx, binding, req, instance, schedules));
      res.json({ data, object: "list" });
    } catch (err) {
      ctx.handleError(res, err);
    }
  };
}

// The one rename handler, mounted by `PATCH /_ref/connections/:id` and
// `PATCH /v1/owner/connections/:connectionId`. It validates `display_name`
// at the boundary (a typed 400 before the store is touched), then renames
// through `store.setDisplayName`, whose update is owner-scoped: a connection
// id that belongs to another owner, or to no one, matches zero rows and
// surfaces as `connector_instance_not_found` (404). Any owned connection can
// be renamed whatever its status. Every attempt emits
// `owner_agent.connection.rename`; the response is the renamed row.
export function buildConnectionRenameHandler(ctx: ConnectionsContext, binding: ConnectionControlBinding): RouteHandler {
  return async (req: RouteRequest, res: RouteResponse) => {
    const ownerSubjectId = binding.ownerSubjectId(req);
    const actor = resolveOwnerActor(binding.surface, req, ownerSubjectId);
    const trace = startOwnerAuditTrace(ctx, actor, res);
    const connectionId = decodeURIComponent(req.params[binding.param] as string);
    const body = (req.body as Record<string, unknown> | null) || {};
    const audit = (
      outcome: "succeeded" | "failed",
      args: { connectorKey?: string | null; error?: unknown; facts: Record<string, unknown> }
    ) =>
      emitOwnerConnectionAudit(ctx, actor, {
        connectionId,
        connectorKey: args.connectorKey ?? null,
        ...(args.error ? { error: args.error } : {}),
        facts: args.facts,
        operation: "rename_connection",
        outcome,
        selector: binding.selector,
        trace,
      });
    const failedFacts = { display_name_supplied: Object.hasOwn(body, "display_name"), label_status: null };
    try {
      const displayName = body.display_name;
      if (typeof displayName !== "string" || !displayName.trim()) {
        await audit("failed", { error: { code: "invalid_request", http_status: 400 }, facts: failedFacts });
        ctx.pdppError(res, 400, "invalid_request", "display_name must be a non-empty string", "display_name");
        return;
      }
      const store = ctx.createRequestConnectorInstanceStore();
      const updated = await store.setDisplayName(connectionId, {
        displayName: displayName.trim(),
        ownerSubjectId,
        updatedAt: ctx.now ? ctx.now() : new Date().toISOString(),
      });
      ctx.invalidateConnectorSummariesCache?.();
      // `store.setDisplayName` marks summary evidence dirty in the SAME
      // transaction as the display_name write — a separate post-hoc call here
      // would be redundant, not additive.
      const projected = projectOwnerConnection(ctx, binding, req, updated, await schedulesByConnection(ctx));
      await audit("succeeded", {
        connectorKey: stringOrNull(projected.connector_key),
        facts: { display_name_supplied: true, label_status: stringOrNull(projected.label_status) },
      });
      res.json(projected);
    } catch (err) {
      await audit("failed", { error: err, facts: failedFacts });
      ctx.handleError(res, err);
    }
  };
}

function buildOwnerConnectionRenameRequireOwner(ctx: MountOwnerConnectionsContext): MiddlewareHandler {
  return async (...args: unknown[]) => {
    const [req, res, next] = args as [RouteRequest, RouteResponse, NextFn];
    if (req.tokenInfo?.pdpp_token_kind === "owner") {
      await next();
      return;
    }
    const err = new Error("Owner token required") as Error & { code: string };
    err.code = "permission_error";
    const actor = resolveOwnerActor("owner_bearer", req, ctx.getOwnerTokenSubjectId(req));
    await emitOwnerConnectionAudit(ctx, actor, {
      connectionId: decodeURIComponent(req.params.connectionId as string),
      connectorKey: null,
      error: err,
      facts: { display_name_supplied: true, label_status: null },
      operation: "rename_connection",
      outcome: "failed",
      selector: "connection_id",
      trace: startOwnerAuditTrace(ctx, actor, res),
    });
    ctx.pdppError(res, 403, "permission_error", "Owner token required");
  };
}

// GET /v1/owner/connections — bearer-authed owner-agent listing of every
// configured connection instance for the authenticated owner. Same handler as
// the cookie-authed `GET /_ref/connections`.
export function mountOwnerConnectionsList(app: AppLike, ctx: MountOwnerConnectionsContext): void {
  app.get(
    "/v1/owner/connections",
    { contract: "ownerListConnections" },
    ctx.requireToken,
    ctx.requireOwner,
    buildConnectionsListHandler(ctx, ownerBearerConnectionBinding(ctx.getOwnerTokenSubjectId, "connection_id"))
  );
}

// PATCH /v1/owner/connections/:connectionId — bearer-authed owner-agent rename
// of a connection's owner-meaningful `display_name`. Same handler as the
// cookie-authed `PATCH /_ref/connections/:id` route; the two auth adapters
// (`requireToken` + `requireOwner` vs `requireOwnerSession`) stay separate.
//
// On success the row is re-projected through `projectOwnerConnection`, so an
// owner-set rename reports `label_status: "owner_set"`.
//
// Auth: owner bearer (`pdpp_token_kind: "owner"`). Client and `mcp_package`
// bearers are rejected with 403 (after a failed-authorization audit); a
// missing bearer is rejected with 401 by `requireToken`. `/mcp` owner-bearer
// rejection is untouched.
//
// Spec: openspec/changes/add-owner-agent-control-surface/specs/
//       reference-owner-agent-control-surface/spec.md
//       (#"Owner-agent control mutations SHALL be auditable and secret-safe"
//         → "Owner agent renames a connection")
export function mountOwnerConnectionRename(app: AppLike, ctx: MountOwnerConnectionsContext): void {
  app.patch(
    "/v1/owner/connections/:connectionId",
    { contract: "ownerSetConnectionDisplayName" },
    ctx.requireToken,
    buildOwnerConnectionRenameRequireOwner(ctx),
    buildConnectionRenameHandler(ctx, ownerBearerConnectionBinding(ctx.getOwnerTokenSubjectId, "connection_id"))
  );
}
