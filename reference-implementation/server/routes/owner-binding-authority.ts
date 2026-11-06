// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { iterateDynamicSqlAcknowledged } from "../../lib/db.ts";
import { isPostgresStorageBackend, postgresQuery } from "../postgres-storage.ts";
import {
  type ConnectorBindingAuthorityStore,
  createConnectorBindingAuthorityStore,
} from "../stores/connector-binding-authority-store.ts";
import type { MiddlewareHandler, PdppErrorFn, RouteArg } from "./_route-contract.ts";

interface RouteRequest {
  readonly params: { readonly connectionId: string; readonly runId: string };
  readonly tokenInfo?: { readonly subject_id?: string | null } | null;
}
interface RouteResponse {
  json: (body: unknown) => unknown;
  setHeader: (name: string, value: string) => unknown;
}
type Handler = (req: RouteRequest, res: RouteResponse) => unknown | Promise<unknown>;
interface AppLike {
  get: (path: string, ...handlers: RouteArg<Handler>[]) => AppLike;
}
interface Context {
  pdppError: PdppErrorFn;
  requireOwner: MiddlewareHandler;
  requireToken: MiddlewareHandler;
  store?: Pick<ConnectorBindingAuthorityStore, "get">;
}

/** Runtime-local read surface. No public writer and no authority production. */
export function mountOwnerBindingAuthority(app: AppLike, ctx: Context): void {
  const noStore: MiddlewareHandler = (_req, res, next) => {
    (res as RouteResponse).setHeader("Cache-Control", "no-store");
    return (next as () => unknown)();
  };
  app.get(
    "/v1/owner/connections/:connectionId/runs/:runId/binding-authority",
    noStore,
    ctx.requireToken,
    ctx.requireOwner,
    async (req: RouteRequest, res: RouteResponse) => {
      // Authenticated subject only, with no default-owner or default-account fallback.
      const ownerId = req.tokenInfo?.subject_id;
      if (typeof ownerId !== "string" || ownerId.trim().length === 0) {
        return ctx.pdppError(res, 403, "permission_error", "Owner subject required");
      }
      try {
        const key = { connectionId: req.params.connectionId, ownerId, runId: req.params.runId };
        // The store gates live ownership before loading the payload, in the same transaction.
        const stored = await (ctx.store ?? createConnectorBindingAuthorityStore()).get(key);
        if (stored === null) {
          return ctx.pdppError(res, 404, "not_found", "Binding authority record not found");
        }
        return res.json({
          connection_id: stored.connectionId,
          object: "binding_authority_record",
          policy_identity: stored.policyIdentity,
          record: stored.record,
          record_version: stored.recordVersion,
          recorded_at: stored.recordedAt,
          run_id: stored.runId,
        });
      } catch {
        // Never pass database errors or persisted data to the generic error logger.
        return ctx.pdppError(res, 500, "binding_authority_unavailable", "Binding authority record unavailable");
      }
    }
  );
  app.get(
    "/v1/owner/connections/:connectionId/runs/:runId/binding-lifecycle",
    noStore,
    ctx.requireToken,
    ctx.requireOwner,
    async (req: RouteRequest, res: RouteResponse) => {
      const ownerId = req.tokenInfo?.subject_id;
      if (typeof ownerId !== "string" || !ownerId.trim()) {
        return ctx.pdppError(res, 403, "permission_error", "Owner subject required");
      }
      try {
        // One statement gates current AND admitted ownership. Same run IDs in
        // another connection cannot import that connection's lifecycle facts.
        const sql = `SELECT e.event_seq, e.status FROM spine_events e
          JOIN connector_binding_authority_runs a ON a.run_id = e.run_id
          JOIN connector_instances c ON c.connector_instance_id = a.connection_id
          WHERE a.connection_id = ? AND a.run_id = ? AND a.owner_id = ? AND c.owner_subject_id = ?
          AND e.event_type = 'run.browser_binding_cleanup'
          AND json_extract(e.data_json, '$.connection_id') = a.connection_id
          ORDER BY e.event_seq DESC LIMIT 100`;
        const values = [req.params.connectionId, req.params.runId, ownerId, ownerId];
        const rows = isPostgresStorageBackend()
          ? (
              await postgresQuery<{ event_seq: number; status: string }>(
                sql
                  .replace("json_extract(e.data_json, '$.connection_id')", "e.data_json::jsonb->>'connection_id'")
                  .replace(
                    /\?/g,
                    (() => {
                      let n = 0;
                      return () => {
                        n += 1;
                        return `$${n}`;
                      };
                    })()
                  ),
                values
              )
            ).rows
          : [...iterateDynamicSqlAcknowledged<{ event_seq: number; status: string }>(sql, values)];
        const stored = await (ctx.store ?? createConnectorBindingAuthorityStore()).get({
          connectionId: req.params.connectionId,
          ownerId,
          runId: req.params.runId,
        });
        if (!stored) {
          return ctx.pdppError(res, 404, "not_found", "Binding lifecycle not found");
        }
        const allowed = new Set(["cleanup_requested", "cleanup_unverified", "stopped", "not_acquired"]);
        const events = rows
          .reverse()
          .filter((row) => allowed.has(row.status))
          .map((row) => ({ event_seq: Number(row.event_seq), lifecycle: row.status }));
        return res.json({
          connection_id: req.params.connectionId,
          events,
          lifecycle: events.at(-1)?.lifecycle ?? null,
          object: "binding_lifecycle",
          run_id: req.params.runId,
        });
      } catch {
        return ctx.pdppError(res, 500, "binding_lifecycle_unavailable", "Binding lifecycle unavailable");
      }
    }
  );
}
