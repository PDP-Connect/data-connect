// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// HTTP adapter for the owner run-status read.
//
//   GET /_ref/runs/:runId — owner session (cookie). The owner-bearer sibling
//     `GET /v1/owner/runs/:runId` (server/routes/owner-runs.ts) mounts the
//     same handler behind `requireToken` + `requireOwner`.
//
// The projection lives in server/run-status-read-model.ts (`readRunStatus`);
// this adapter owns only URL decoding and error-to-HTTP mapping, so every
// surface returns the same body and the same typed `not_found` 404 (never
// Express's default 404).
//
// This closes the "202 then 404" contract break from the vanished-run
// diagnosis (tmp/workstreams/vanished-run-diagnosis-2026-06-10.md): the
// `controller_active_runs` table is flight state only, so a fast-failing
// run was unresolvable seconds after its 202 unless the caller already knew
// the timeline envelope.
//
// See openspec/changes/surface-run-handle-resolvability.

import { REF_RUN_LINK_BASE, type RunLinkBase, type RunStatusReader, readRunStatus } from "../run-status-read-model.ts";
import type { MiddlewareHandler, PdppErrorFn } from "./_route-contract.ts";

export interface RunStatusRouteRequest {
  readonly params: Readonly<Record<string, string>>;
}

export interface RunStatusRouteResponse {
  json: (body: unknown) => unknown;
}

type RouteHandler = (req: RunStatusRouteRequest, res: RunStatusRouteResponse) => unknown | Promise<unknown>;

interface AppLike {
  get: (path: string, ...handlers: (MiddlewareHandler | RouteHandler)[]) => AppLike;
}

export interface RunStatusHandlerContext extends RunStatusReader {
  handleError: (res: unknown, err: unknown) => void;
  pdppError: PdppErrorFn;
}

export interface MountRefRunStatusContext extends RunStatusHandlerContext {
  requireOwnerSession: MiddlewareHandler;
}

/** The run-status handler every owner surface mounts behind its own auth guard. */
export function buildRunStatusHandler(ctx: RunStatusHandlerContext, linkBase: RunLinkBase): RouteHandler {
  return async (req: RunStatusRouteRequest, res: RunStatusRouteResponse) => {
    try {
      const runId = decodeURIComponent(req.params.runId as string);
      const body = await readRunStatus(ctx, runId, linkBase);
      if (body) {
        return res.json(body);
      }
      return ctx.pdppError(res, 404, "not_found", `Run not found: ${runId}`, "run_id");
    } catch (err) {
      return ctx.handleError(res, err);
    }
  };
}

export function mountRefRunStatus(app: AppLike, ctx: MountRefRunStatusContext): void {
  app.get("/_ref/runs/:runId", ctx.requireOwnerSession, buildRunStatusHandler(ctx, REF_RUN_LINK_BASE));
}
