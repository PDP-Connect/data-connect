// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// HTTP adapter for the bearer-authed owner-agent connection-revoke control
// routes:
//
//   POST /v1/owner/connections/:connectionId/revoke
//   POST /v1/owner/connectors/:connectorId/revoke
//
// They and the owner-session `POST /_ref/connections/:connectorInstanceId/revoke`
// route (`ref-connectors.ts`) mount ONE handler, `buildConnectionRevokeHandler`,
// built on the connector-instance store soft-flip primitive
// (`connectorInstanceStore.updateStatus(id, { status: 'revoked' })`). The
// routes differ only in their auth adapter (`requireToken` + `requireOwner`
// bearer vs `requireOwnerSession` cookie), in how the target is addressed
// (the cookie route takes a connection id only), and in the audit actor.
// `/mcp` owner-bearer rejection (`requireClientOrMcpPackage`) is untouched.
//
// What revoke is (and is NOT):
//   - Revoke stops a connection's FUTURE collection: it flips exactly one
//     `connector_instance_id` (== `connection_id`) to status `revoked`. Routine
//     ingest already refuses a non-active instance (the resolver's active-status
//     gate), so no new run/ingest lands for the connection.
//   - Revoke also revokes this connection's stored credential. Already-collected
//     records, dataset projections, spine evidence, device rows, and SIBLING
//     connections are untouched. Records stay readable; revoke is not delete.
//   - It is durable: implicit default-account materialization no longer
//     resurrects a revoked row (the durability guard in
//     `ensureDefaultAccountConnection` + the resolver's non-active fail-closed),
//     so the revoke survives every owner-console read and grant/polyfill scope
//     resolution. A revoked connection is reversible only by an explicit owner
//     re-initiate, never silently.
//
// Ownership + scoping:
//   - the `:connectionId` route resolves the namespace by a single
//     `connection_id` via `resolveOwnerConnectorNamespace(..., allowDefaultAccount:
//     false)`. The resolver verifies `instance.ownerSubjectId === ownerSubjectId`
//     (foreign id → connector_instance_not_found 404) BEFORE any mutation, so a
//     foreign or unknown `connection_id` can never be revoked. The store
//     `updateStatus` itself takes no owner argument, so this resolver guard is
//     the ownership boundary.
//   - the `:connectorId` route is addressed by connector type only; the resolver
//     auto-selects the connector's single active connection, or rejects with a
//     typed `ambiguous_connection` (409) carrying the available `connection_id`
//     values (+ owner-meaningful labels) and `retry_with: connection_id`.
//   - a repeat revoke is repeat-safe-by-typed-error: the active-status gate
//     returns `connector_instance_inactive` (400) for an already-revoked
//     connection, so a second revoke is a clean typed 4xx, not a crash or a
//     silent no-op.
//
// Every revoke attempt (success and failure) emits non-secret
// `owner_agent.connection.revoke` spine evidence: actor kind, client id/name,
// target connection/connector, operation, outcome, request id. Bearer tokens
// and provider secrets are never logged.
//
// Spec: openspec/changes/add-owner-agent-control-surface/specs/
//       reference-owner-agent-control-surface/spec.md
//       (#"Owner-agent control SHALL advertise and enforce per-connection
//         actions";
//        #"Owner-agent control mutations SHALL be auditable and secret-safe")
//       design.md "Deferred: connection-revoke durability" → Unit 2.

import type { BrowserProfilePurger } from "../browser-profile-purge.ts";
import type { CredentialStateChange } from "../stores/connector-instance-credential-store.ts";
import { resolveOwnerActor, startOwnerAuditTrace } from "./_owner-actor.ts";
import {
  type ConnectionControlBinding,
  emitOwnerConnectionAudit,
  ownerBearerConnectionBinding,
  readConnectionTarget,
  requireConnectorAddressing,
  rethrowAsAmbiguousConnection,
} from "./_owner-connection-helpers.ts";
import type {
  ActiveBinding,
  AmbiguousConnectionErrorLike,
  ConnectorNamespace,
  MiddlewareHandler,
  PdppErrorFn,
  RouteArg,
  TraceContext,
  WireConnection,
} from "./_route-contract.ts";

// Express-shaped surface, structurally typed to avoid pulling in the
// transport's `.js` ambient types. Matches the pattern established in
// `server/routes/owner-connection-run.ts`.

interface RouteRequest {
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
  post: (path: string, ...args: RouteArg<RouteHandler>[]) => AppLike;
}

interface RevokedInstance {
  readonly connectorInstanceId?: string | null;
  readonly revokedAt?: string | null;
  readonly status?: string | null;
}

export interface MountOwnerConnectionRevokeContext {
  // Constructs the typed `ambiguous_connection` error from the available
  // connection rows. Injected (rather than imported) so this adapter stays
  // decoupled from the host's error module, matching the wider route-family
  // pattern.
  AmbiguousConnectionError: new (
    message: string,
    availableConnections: WireConnection[]
  ) => AmbiguousConnectionErrorLike;
  canonicalConnectorKey: (value: string | null | undefined) => string | null;
  createTraceContext: (input?: { scenarioId?: string }) => TraceContext;
  emitSpineEvent: (event: Record<string, unknown>) => Promise<unknown>;
  ensureRequestId: (res: RouteResponse) => string;
  getOwnerTokenSubjectId: (req: unknown) => string;
  handleError: (res: unknown, err: unknown) => void;
  invalidateConnectorSummariesCache?: () => void;
  // Lists the owner's active connection bindings for a connector. Used to
  // populate `available_connections` on the typed ambiguity error.
  listActiveBindingsForGrant: (input: {
    ownerSubjectId: string;
    connectorId: string;
  }) => Promise<ActiveBinding[]> | ActiveBinding[];
  // Marks the maintained connector-summary read-model evidence for exactly this
  // connection dirty after the revoke mutation commits. Injected (not imported)
  // to match the route-family decoupling pattern and the optional
  // `invalidateConnectorSummariesCache` above. Awaited at the call site so
  // ordering is explicit rather than hidden in a fire-and-forget promise;
  // best-effort and a no-op until the read model is warmed.
  markConnectorSummaryEvidenceDirty?: (input: { connectorInstanceId: string; reason?: string }) => Promise<void> | void;
  // Wall-clock stamp for the `updated_at` / `revoked_at` recorded on the soft
  // flip. Injected so the route stays deterministic under test and so this
  // module does not import a clock. Defaults to `new Date().toISOString()`.
  now?: () => string;
  pdppError: PdppErrorFn;
  // Projects one active binding to the wire `{ connection_id, display_name? }`
  // shape used in `available_connections` (placeholder labels suppressed).
  projectBindingForWire: (instance: ActiveBinding) => WireConnection | null;
  // Post-commit browser-profile purge (server/browser-profile-purge.ts). Never
  // throws; its result is reported in the response and the audit event.
  purgeBrowserProfile?: BrowserProfilePurger;
  requireOwner: MiddlewareHandler;
  requireToken: MiddlewareHandler;
  // Owner-scoped connector-instance namespace resolution. Verifies owner
  // ownership + active status BEFORE the mutation; throws
  // `ConnectorInstanceResolutionError` with `connector_instance_not_found`
  // (foreign/unknown id → 404), `connector_instance_inactive` (already revoked
  // → 400), or `ambiguous_connector_instance` (connector-only, >1 active).
  resolveOwnerConnectorNamespace: (
    req: unknown,
    connectorId: string | null,
    options?: {
      readonly allowDefaultAccount?: boolean;
      readonly connectorInstanceId?: string | null;
      readonly ownerSubjectId?: string;
    }
  ) => Promise<ConnectorNamespace>;
  setReferenceTraceId: (res: RouteResponse, traceId: string) => void;
  // Connection-scoped soft-flip primitive. Owner-scoped because the namespace
  // was already resolved + ownership-verified owner-side; flips exactly one
  // connector_instance and its stored credential to status `revoked`. Returns
  // the updated row. The SAME store primitive the device-collected and
  // default-account classes share — no new destructive semantic is introduced
  // here.
  updateConnectorInstanceStatus: (
    connectorInstanceId: string,
    options: {
      status: "revoked";
      updatedAt: string;
      revokedAt: string;
      sourceBindingPatch: { revocation_reason: "owner_revoked" };
      credentialStateChange: CredentialStateChange;
    }
  ) => Promise<RevokedInstance> | RevokedInstance;
}

// The context the shared revoke handler needs on either surface. The
// connector-only fields (`AmbiguousConnectionError`,
// `listActiveBindingsForGrant`, `projectBindingForWire`) are read only by the
// bearer `/v1/owner/connectors/:connectorId/revoke` binding.
type ConnectorAddressingKey = "AmbiguousConnectionError" | "listActiveBindingsForGrant" | "projectBindingForWire";
const CONNECTOR_ADDRESSING_KEYS: readonly ConnectorAddressingKey[] = [
  "AmbiguousConnectionError",
  "listActiveBindingsForGrant",
  "projectBindingForWire",
];

export type ConnectionRevokeContext = Omit<
  MountOwnerConnectionRevokeContext,
  ConnectorAddressingKey | "getOwnerTokenSubjectId" | "requireOwner" | "requireToken"
> &
  Partial<Pick<MountOwnerConnectionRevokeContext, ConnectorAddressingKey>>;

// Resolves the connection to revoke. `connection_id` addressing verifies owner
// ownership and active status (foreign/unknown → connector_instance_not_found
// 404; already revoked → connector_instance_inactive 400). `connector_id`
// addressing auto-selects the single active connection or throws the typed
// `ambiguous_connection` (409). `allowDefaultAccount: false` so an
// unmaterialized default account is never created just to revoke it.
async function resolveRevokeNamespace(
  ctx: ConnectionRevokeContext,
  req: RouteRequest,
  binding: ConnectionControlBinding,
  ownerSubjectId: string,
  target: { connectionId: string | null; connectorKey: string | null }
): Promise<ConnectorNamespace> {
  const addressed = decodeURIComponent(req.params[binding.param] as string);
  if (binding.selector === "connection_id") {
    target.connectionId = addressed;
    return await ctx.resolveOwnerConnectorNamespace(req, null, {
      allowDefaultAccount: false,
      connectorInstanceId: addressed,
      ownerSubjectId,
    });
  }
  target.connectorKey = ctx.canonicalConnectorKey(addressed) ?? addressed;
  try {
    return await ctx.resolveOwnerConnectorNamespace(req, addressed, {
      allowDefaultAccount: false,
      ownerSubjectId,
    });
  } catch (resolveErr) {
    return await rethrowAsAmbiguousConnection(
      requireConnectorAddressing(ctx, CONNECTOR_ADDRESSING_KEYS),
      resolveErr,
      ownerSubjectId,
      target.connectorKey
    );
  }
}

// The one revoke handler. The cookie `POST /_ref/connections/:id/revoke` route
// and both bearer revoke routes mount it; `binding` decides only how the
// target is addressed and who the actor is. Resolution, the soft flip (which
// also revokes the stored credential), the browser-profile purge, the
// `owner_agent.connection.revoke` audit, the typed errors, and the 200
// `owner_connection_revoke` body are the same on every route.
export function buildConnectionRevokeHandler(
  ctx: ConnectionRevokeContext,
  binding: ConnectionControlBinding
): RouteHandler {
  return async (req: RouteRequest, res: RouteResponse) => {
    const ownerSubjectId = binding.ownerSubjectId(req);
    const actor = resolveOwnerActor(binding.surface, req, ownerSubjectId);
    const trace = startOwnerAuditTrace(ctx, actor, res);
    const target: { connectionId: string | null; connectorKey: string | null } = {
      connectionId: null,
      connectorKey: null,
    };
    const audit = (outcome: "succeeded" | "failed", extra: { error?: unknown; facts?: Record<string, unknown> }) =>
      emitOwnerConnectionAudit(ctx, actor, {
        ...target,
        ...extra,
        operation: "revoke",
        outcome,
        selector: binding.selector,
        trace,
      });
    try {
      const namespace = await resolveRevokeNamespace(ctx, req, binding, ownerSubjectId, target);
      target.connectionId = namespace.connectorInstanceId;
      target.connectorKey = ctx.canonicalConnectorKey(namespace.connectorId) ?? namespace.connectorId;

      const stamp = ctx.now ? ctx.now() : new Date().toISOString();
      const revoked = await Promise.resolve(
        ctx.updateConnectorInstanceStatus(namespace.connectorInstanceId, {
          credentialStateChange: {
            actorId: actor.actorId,
            actorType: actor.actorKind,
            cause: "owner_revoked",
            requestId: trace.request_id,
            traceId: trace.trace_id,
          },
          revokedAt: stamp,
          sourceBindingPatch: { revocation_reason: "owner_revoked" },
          status: "revoked",
          updatedAt: stamp,
        })
      );
      ctx.invalidateConnectorSummariesCache?.();
      // `updateConnectorInstanceStatus` (-> `store.updateStatus`) marks summary
      // evidence dirty in the SAME transaction as the status write — a separate
      // post-hoc call here would be redundant, not additive.
      // Revoke stops future collection, so the source's logged-in browser
      // session goes too. A failure is reported, never a failed revoke.
      const profilePurge = ctx.purgeBrowserProfile
        ? await ctx.purgeBrowserProfile({
            connectorInstanceId: target.connectionId,
            connectorKey: target.connectorKey,
            ownerSubjectId,
          })
        : null;
      await audit("succeeded", profilePurge ? { facts: { profile_purge: profilePurge } } : {});
      res.status(200).json({
        connection_id: target.connectionId,
        connector_id: target.connectorKey,
        connector_key: target.connectorKey,
        object: "owner_connection_revoke",
        ...(profilePurge ? { profile_purge: profilePurge } : {}),
        revoked_at: revoked.revokedAt ?? stamp,
        status: revoked.status ?? "revoked",
      });
    } catch (err) {
      await audit("failed", { error: err });
      ctx.handleError(res, err);
    }
  };
}

// Separate owner guard that emits a failed-authorization audit event before
// rejecting a non-owner bearer, mirroring the run/schedule routes. Keeps the
// audit trail complete for client/mcp_package bearers that reach the route.
function buildRevokeRequireOwner(
  ctx: MountOwnerConnectionRevokeContext,
  selector: "connection_id" | "connector_id"
): MiddlewareHandler {
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
      ...readConnectionTarget(ctx, req, selector),
      error: err,
      operation: "revoke",
      outcome: "failed",
      selector,
      trace: startOwnerAuditTrace(ctx, actor, res),
    });
    ctx.pdppError(res, 403, "permission_error", "Owner token required");
  };
}

export function mountOwnerConnectionRevoke(app: AppLike, ctx: MountOwnerConnectionRevokeContext): void {
  app.post(
    "/v1/owner/connections/:connectionId/revoke",
    { contract: "ownerRevokeConnection" },
    ctx.requireToken,
    buildRevokeRequireOwner(ctx, "connection_id"),
    buildConnectionRevokeHandler(ctx, ownerBearerConnectionBinding(ctx.getOwnerTokenSubjectId, "connection_id"))
  );
  app.post(
    "/v1/owner/connectors/:connectorId/revoke",
    { contract: "ownerRevokeConnector" },
    ctx.requireToken,
    buildRevokeRequireOwner(ctx, "connector_id"),
    buildConnectionRevokeHandler(ctx, ownerBearerConnectionBinding(ctx.getOwnerTokenSubjectId, "connector_id"))
  );
}
