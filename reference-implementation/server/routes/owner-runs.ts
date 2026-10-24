// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// HTTP adapter for the owner-bearer run reads:
//
//   GET /v1/owner/runs/:runId           — run status, terminal reason, and
//                                          bounded failure summary
//   GET /v1/owner/runs/:runId/timeline  — paginated, redacted run events
//
// These are the `/v1/owner/*` siblings of `GET /_ref/runs/:runId` and
// `GET /_ref/runs/:runId/timeline`. They mount the SAME handlers
// (`buildRunStatusHandler`, `buildTimelineHandler`) behind the owner-bearer
// guards (`requireToken` + `requireOwner`) instead of the cookie owner
// session, so the body, redaction, pagination, and error envelopes are
// identical on both surfaces. Only `links` differ: they point into the
// route family the caller used.
//
// Without these routes an owner agent could start a run
// (`POST /v1/owner/connections/:id/run` returns a run_id) but could not see
// how it ended or why it failed.

import { OWNER_RUN_LINK_BASE } from "../run-status-read-model.ts";
import type { MiddlewareHandler } from "./_route-contract.ts";
import { buildRunStatusHandler, type RunStatusHandlerContext } from "./ref-run-status.ts";
import { buildTimelineHandler, type TimelineHandlerContext } from "./ref-spine-timelines.ts";

type RouteHandler = ReturnType<typeof buildRunStatusHandler> | ReturnType<typeof buildTimelineHandler>;

interface AppLike {
  get: (path: string, ...handlers: (MiddlewareHandler | RouteHandler)[]) => AppLike;
}

export interface MountOwnerRunsContext extends RunStatusHandlerContext, TimelineHandlerContext {
  requireOwner: MiddlewareHandler;
  requireToken: MiddlewareHandler;
}

export function mountOwnerRuns(app: AppLike, ctx: MountOwnerRunsContext): void {
  app.get("/v1/owner/runs/:runId", ctx.requireToken, ctx.requireOwner, buildRunStatusHandler(ctx, OWNER_RUN_LINK_BASE));
  app.get(
    "/v1/owner/runs/:runId/timeline",
    ctx.requireToken,
    ctx.requireOwner,
    buildTimelineHandler(ctx, "run", "runId", "Run timeline not found")
  );
}
