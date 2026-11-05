// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Owner-only diagnostic read of one run's OBSERVATION record (Collection
// Profile 0.2.0 Sections 5.10 and 5.11).
//
//   GET /_ref/runs/:runId/observations?connector_id=...&connector_instance_id=...
//
// The record is keyed by connector, connector instance and run. A run id that
// exists under another connector or instance is absent, so it returns a typed
// `not_found` 404. This route exports nothing: it returns the stored record to
// the owner session that asked, and nothing else reads it.

import type { ConnectorObservationRunStore } from "../stores/connector-observation-store.ts";
import { getDefaultConnectorObservationStore } from "../stores/connector-observation-store.ts";
import type { MiddlewareHandler, PdppErrorFn } from "./_route-contract.ts";

interface RouteRequest {
  readonly params: Readonly<Record<string, string>>;
  readonly query?: Readonly<Record<string, unknown>>;
}

interface RouteResponse {
  json: (body: unknown) => unknown;
  setHeader: (name: string, value: string) => unknown;
}

type RouteHandler = (req: RouteRequest, res: RouteResponse) => unknown | Promise<unknown>;

interface AppLike {
  get: (path: string, ...handlers: (MiddlewareHandler | RouteHandler)[]) => AppLike;
}

export interface MountRefRunObservationsContext {
  handleError: (res: unknown, err: unknown) => void;
  pdppError: PdppErrorFn;
  requireOwnerSession: MiddlewareHandler;
  /** Injectable for tests. Defaults to the process store for the active backend. */
  store?: ConnectorObservationRunStore;
}

function requiredQueryString(query: RouteRequest["query"], key: string): string | null {
  const value = query?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function mountRefRunObservations(app: AppLike, ctx: MountRefRunObservationsContext): void {
  app.get("/_ref/runs/:runId/observations", ctx.requireOwnerSession, async (req: RouteRequest, res: RouteResponse) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      const runId = decodeURIComponent(req.params.runId as string);
      const connectorId = requiredQueryString(req.query, "connector_id");
      const connectorInstanceId = requiredQueryString(req.query, "connector_instance_id");
      if (connectorId === null) {
        return ctx.pdppError(res, 400, "invalid_request", "connector_id is required", "connector_id");
      }
      if (connectorInstanceId === null) {
        return ctx.pdppError(res, 400, "invalid_request", "connector_instance_id is required", "connector_instance_id");
      }

      const store = ctx.store ?? getDefaultConnectorObservationStore();
      const record = await store.get({ connectorId, connectorInstanceId, runId });
      if (record === null) {
        return ctx.pdppError(res, 404, "not_found", `Run observations not found: ${runId}`, "run_id");
      }
      return res.json({
        connector_id: record.connectorId,
        connector_instance_id: record.connectorInstanceId,
        diagnosis: record.diagnosis,
        object: "run_observations",
        recorded_at: record.recordedAt,
        run_id: record.runId,
        snapshot: record.snapshot,
      });
    } catch (err) {
      return ctx.handleError(res, err);
    }
  });
}
