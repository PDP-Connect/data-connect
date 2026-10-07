// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// HTTP adapter for the owner-bearer run routes:
//
//   GET  /v1/owner/runs                      — list runs (filters, cursor)
//   GET  /v1/owner/runs/:runId               — run status, terminal reason,
//                                              and bounded failure summary
//   GET  /v1/owner/runs/:runId/timeline      — paginated, redacted run events
//   POST /v1/owner/runs/:runId/cancel        — cancel one active run
//   POST /v1/owner/runs/:runId/interaction   — answer the run's pending
//                                              interaction
//
// These are the `/v1/owner/*` siblings of the cookie `/_ref/runs` routes. They
// mount the SAME handlers behind the owner-bearer guards (`requireToken` +
// `requireOwner`) instead of the cookie owner session, so validation, bodies,
// redaction, pagination, audit, and error envelopes are identical on both
// surfaces. Two things follow the surface: run-status `links` point into the
// route family the caller used, and the audit actor of a cancel or an answer
// is the owner agent instead of the owner session.
//
// Without these routes an owner agent could start a run
// (`POST /v1/owner/connections/:id/run` returns a run_id) but could not see
// how it ended, stop it, or answer the OTP prompt that blocks it.

import { OWNER_RUN_LINK_BASE } from "../run-status-read-model.ts";
import type { MiddlewareHandler } from "./_route-contract.ts";
import { buildRunStatusHandler, type RunStatusHandlerContext } from "./ref-run-status.ts";
import { buildSpineCorrelationListHandler, type MountRefSpineCorrelationsContext } from "./ref-spine-correlations.ts";
import { buildTimelineHandler, type TimelineHandlerContext } from "./ref-spine-timelines.ts";
import { buildRunCancelHandler, type RunCancelContext } from "./run-cancel.ts";
import { buildRunInteractionHandler, type RunInteractionContext } from "./run-interaction.ts";

type RouteHandler =
  | ReturnType<typeof buildRunStatusHandler>
  | ReturnType<typeof buildTimelineHandler>
  | ReturnType<typeof buildSpineCorrelationListHandler>
  | ReturnType<typeof buildRunCancelHandler>
  | ReturnType<typeof buildRunInteractionHandler>;

interface AppLike {
  get: (path: string, ...handlers: (MiddlewareHandler | RouteHandler)[]) => AppLike;
  post: (path: string, ...handlers: (MiddlewareHandler | RouteHandler)[]) => AppLike;
}

export interface MountOwnerRunsContext
  extends RunStatusHandlerContext,
    TimelineHandlerContext,
    Pick<MountRefSpineCorrelationsContext, "canonicalConnectorKey" | "listSpineCorrelations">,
    RunCancelContext,
    RunInteractionContext {
  // Each handler context declares the controller slice it reads; the host
  // passes the one controller that serves all of them.
  readonly controller:
    | (NonNullable<RunStatusHandlerContext["controller"]> &
        NonNullable<RunCancelContext["controller"]> &
        NonNullable<RunInteractionContext["controller"]>)
    | null
    | undefined;
  requireOwner: MiddlewareHandler;
  requireToken: MiddlewareHandler;
}

export function mountOwnerRuns(app: AppLike, ctx: MountOwnerRunsContext): void {
  app.get("/v1/owner/runs", ctx.requireToken, ctx.requireOwner, buildSpineCorrelationListHandler(ctx, "run"));
  app.get("/v1/owner/runs/:runId", ctx.requireToken, ctx.requireOwner, buildRunStatusHandler(ctx, OWNER_RUN_LINK_BASE));
  app.get(
    "/v1/owner/runs/:runId/timeline",
    ctx.requireToken,
    ctx.requireOwner,
    buildTimelineHandler(ctx, "run", "runId", "Run timeline not found")
  );
  app.post(
    "/v1/owner/runs/:runId/cancel",
    ctx.requireToken,
    ctx.requireOwner,
    buildRunCancelHandler(ctx, "owner_bearer")
  );
  app.post(
    "/v1/owner/runs/:runId/interaction",
    ctx.requireToken,
    ctx.requireOwner,
    buildRunInteractionHandler(ctx, "owner_bearer")
  );
}
