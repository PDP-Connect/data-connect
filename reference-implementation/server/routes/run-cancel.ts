// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// HTTP adapter for the reference-only owner run-cancellation control surface.
//
// One route:
//   POST /_ref/runs/:runId/cancel — owner-only, requests cooperative
//     cancellation of a single active controller-managed run. This is NOT a
//     public PDPP protocol endpoint; it is reference/operator control. It
//     stops only the targeted run, preserves already-collected records, and
//     does not affect sibling runs, schedules, grants, or connections.
//
// `buildRunCancelHandler` is also mounted at `POST /v1/owner/runs/:runId/cancel`
// behind the owner bearer (`owner-runs.ts`), so both surfaces share one
// cancel implementation.
//
// The controller aborts only the targeted run's cancel signal; the runtime
// emits `run.cancel_requested` and terminates that connector child, then
// records a terminal `run.cancelled` event when the child exits. The route
// acknowledges the request asynchronously (the run ends on the spine
// timeline), mirroring how run-now returns before a run completes.
//
// See openspec/changes/add-owner-run-cancellation-control.

import type { MiddlewareHandler, PdppErrorFn } from "./_route-contract.ts";
import {
  decodeRunIdParam,
  emitRunControlAudit,
  type RunControlAuditContext,
  type RunControlRejection,
  type RunControlRequest,
  type RunControlSurface,
  resolveRunControlActor,
} from "./_run-control.ts";

interface RouteRequest extends RunControlRequest {
  readonly params: Readonly<Record<string, string>>;
}

interface RouteResponse {
  json: (body: unknown) => unknown;
  status: (code: number) => RouteResponse;
}

type RouteHandler = (req: RouteRequest, res: RouteResponse) => unknown | Promise<unknown>;

interface AppLike {
  post: (path: string, ...args: (MiddlewareHandler | RouteHandler)[]) => AppLike;
}

export interface RunCancelResult {
  readonly run_id: string;
  readonly status: string;
}

export interface RunCancelController {
  cancelRun: (runId: string, requestingOwnerSubjectId: string) => Promise<RunCancelResult> | RunCancelResult;
}

// Everything the shared cancel handler needs, on either surface.
export interface RunCancelContext extends RunControlAuditContext<RouteResponse> {
  cancelRun?: (runId: string, requestingOwnerSubjectId: string) => Promise<RunCancelResult> | RunCancelResult;
  readonly controller: RunCancelController | null | undefined;
  handleError: (res: unknown, err: unknown) => void;
  pdppError: PdppErrorFn;
}

export interface MountRefRunCancelContext extends RunCancelContext {
  requireOwnerSession: MiddlewareHandler;
}

interface CancelRejection extends RunControlRejection {
  readonly message: string;
}

// Maps a controller cancel-run outcome onto a typed rejection, or null when the
// cancellation was accepted.
function cancelOutcomeRejection(runId: string, result: RunCancelResult): CancelRejection | null {
  if (result.status === "no_active_run") {
    return { code: "no_active_run", http_status: 404, message: `No active run with id: ${runId}` };
  }
  if (result.status === "already_terminal") {
    return {
      code: "run_already_terminal",
      http_status: 409,
      message: `Run ${runId} has already reached a terminal state`,
    };
  }
  return null;
}

// Requests cancellation for one run, preferring the route-level `cancelRun`
// override (used by callers that need to reach a scheduler-owned run the
// controller itself does not track) over the controller's own cancelRun.
function requestRunCancellation(
  ctx: Pick<RunCancelContext, "cancelRun" | "controller">,
  runId: string,
  requestingOwnerSubjectId: string
): Promise<RunCancelResult> | RunCancelResult {
  if (ctx.cancelRun) {
    return ctx.cancelRun(runId, requestingOwnerSubjectId);
  }
  // Guarded by the caller: ctx.controller.cancelRun is confirmed callable
  // before requestRunCancellation is invoked.
  return (ctx.controller as RunCancelController).cancelRun(runId, requestingOwnerSubjectId);
}

// True when a controller is wired up and exposes a callable cancelRun.
function hasCallableCancelRunController(ctx: Pick<RunCancelContext, "controller">): boolean {
  return Boolean(ctx.controller) && typeof ctx.controller?.cancelRun === "function";
}

// The one cancel-run handler. `surface` decides only who the requesting owner
// is; the controller call, the typed outcomes, the 202 body, and the
// `owner.run.cancel` audit are the same on both route families.
export function buildRunCancelHandler(ctx: RunCancelContext, surface: RunControlSurface): RouteHandler {
  return async (req: RouteRequest, res: RouteResponse) => {
    const runId = decodeRunIdParam(req.params.runId as string);
    const actor = resolveRunControlActor(surface, req, ctx.ownerSubjectId);
    const reject = async (rejection: CancelRejection, param?: string) => {
      await emitRunControlAudit(ctx, actor, res, {
        error: rejection,
        operation: "cancel_run",
        outcome: "failed",
        runId,
      });
      return ctx.pdppError(res, rejection.http_status, rejection.code, rejection.message, param);
    };
    try {
      if (!hasCallableCancelRunController(ctx)) {
        return await reject({
          code: "not_found",
          http_status: 404,
          message: "Controller is not configured on this server",
        });
      }
      const result = await requestRunCancellation(ctx, runId, actor.ownerSubjectId);
      const rejection = cancelOutcomeRejection(runId, result);
      if (rejection) {
        return await reject(rejection, "run_id");
      }
      await emitRunControlAudit(ctx, actor, res, {
        facts: { cancel_status: result.status },
        operation: "cancel_run",
        outcome: "succeeded",
        runId,
      });
      return res.status(202).json({
        object: "run_cancel_ack",
        run_id: runId,
        status: result.status,
      });
    } catch (err) {
      await emitRunControlAudit(ctx, actor, res, { error: err, operation: "cancel_run", outcome: "failed", runId });
      return ctx.handleError(res, err);
    }
  };
}

export function mountRefRunCancel(app: AppLike, ctx: MountRefRunCancelContext): void {
  app.post("/_ref/runs/:runId/cancel", ctx.requireOwnerSession, buildRunCancelHandler(ctx, "owner_session"));
}
