// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// HTTP adapter for the reference-only run-interaction control surface and
// developer stream playground.
//
// Behaviour-preserving extraction from `server/index.js` per the OpenSpec
// change `split-reference-server-by-route-family` (§5.1). Owner-session
// posture, response envelopes, status codes, error codes, and contract
// metadata are unchanged.
//
// Two routes:
//   POST /_ref/runs/:runId/interaction   — owner-only, answers the current
//     pending interaction for a live controller-managed run. This is NOT a
//     public PDPP protocol endpoint. Submitted data is not written to any
//     spine event payload, .env.local, or persistent config.
//     `buildRunInteractionHandler` is also mounted at
//     `POST /v1/owner/runs/:runId/interaction` behind the owner bearer
//     (`owner-runs.ts`), so both surfaces share one implementation.
//   POST /_ref/dev/playground/session    — developer/testing surface,
//     gated at the call site on NODE_ENV !== 'production' or
//     PDPP_ENABLE_STREAM_PLAYGROUND=1. Owner-session required when
//     owner-auth is enabled.

import { isNullish } from "../../lib/nullish.ts";
import type { MiddlewareHandler, PdppErrorFn, RouteArg } from "./_route-contract.ts";
import {
  decodeRunIdParam,
  emitRunControlAuditSafely,
  type RunControlAuditContext,
  type RunControlRejection,
  type RunControlRequest,
  type RunControlSurface,
  resolveRunControlActor,
} from "./_run-control.ts";

// Express-shaped surface, structurally typed to avoid pulling in transport
// ambient types. Config objects (e.g. `{ contract: 'opId' }`) may appear
// in the args list alongside middlewares and the final handler, matching
// transport.js's registration convention.

interface RouteRequest extends RunControlRequest {
  readonly body?: unknown;
  readonly params: Readonly<Record<string, string>>;
  readonly query?: Readonly<Record<string, unknown>>;
}

interface RouteResponse {
  json: (body: unknown) => unknown;
  status: (code: number) => RouteResponse;
}

type RouteHandler = (req: RouteRequest, res: RouteResponse) => unknown | Promise<unknown>;

interface AppLike {
  post: (path: string, ...args: RouteArg<RouteHandler>[]) => AppLike;
}

export interface RunInteractionController {
  // The run's admitted owner while it is active, or null when the controller
  // does not track one (not active, or not owner-admitted).
  getActiveRunOwnerSubjectId?: (runId: string) => string | null;
  respondToInteraction: (
    runId: string,
    input: {
      readonly interaction_id: string;
      readonly status: string;
      readonly data?: Record<string, unknown> | null | undefined;
    }
  ) => { readonly status: string } | Promise<{ readonly status: string }>;
}

// Everything the shared interaction-answer handler needs, on either surface.
export interface RunInteractionContext extends RunControlAuditContext<RouteResponse> {
  readonly controller: RunInteractionController | null | undefined;
  handleError: (res: unknown, err: unknown) => void;
  pdppError: PdppErrorFn;
}

export interface MountRefRunInteractionContext extends RunInteractionContext {
  requireOwnerSession: MiddlewareHandler;
}

interface InteractionRejection extends RunControlRejection {
  readonly message: string;
  readonly param?: string;
}

interface InteractionAnswer {
  readonly data: Record<string, unknown> | null | undefined;
  readonly interaction_id: string;
  readonly status: "success" | "cancelled";
}

// Validates the answer body. Returns the typed rejection for the first
// failing field, or the answer.
function readInteractionAnswer(rawBody: unknown): InteractionAnswer | InteractionRejection {
  const body =
    rawBody !== null && typeof rawBody === "object"
      ? (rawBody as Record<string, unknown>)
      : ({} as Record<string, unknown>);
  if (typeof body.interaction_id !== "string" || !body.interaction_id.trim()) {
    return {
      code: "invalid_request",
      http_status: 400,
      message: "interaction_id is required",
      param: "interaction_id",
    };
  }
  if (body.status !== "success" && body.status !== "cancelled") {
    return {
      code: "invalid_status",
      http_status: 400,
      message: 'status must be "success" or "cancelled"',
      param: "status",
    };
  }
  if (!isNullish(body.data) && (typeof body.data !== "object" || Array.isArray(body.data))) {
    return { code: "invalid_request", http_status: 400, message: "data must be an object if provided", param: "data" };
  }
  return {
    data: body.data as Record<string, unknown> | null | undefined,
    interaction_id: body.interaction_id,
    status: body.status,
  };
}

function isRejection(value: InteractionAnswer | InteractionRejection): value is InteractionRejection {
  return "code" in value;
}

// The run's admitted owner must be the requesting owner, the same rule
// `cancelRun` enforces: a bare run id is never enough to answer another
// owner's interaction. Runs the controller does not track an owner for are
// left to `respondToInteraction`'s own typed errors.
function ownerMismatchRejection(
  controller: RunInteractionController,
  runId: string,
  ownerSubjectId: string
): InteractionRejection | null {
  const admittedOwner = controller.getActiveRunOwnerSubjectId?.(runId) ?? null;
  if (admittedOwner === null || admittedOwner === ownerSubjectId) {
    return null;
  }
  return {
    code: "run_owner_mismatch",
    http_status: 403,
    message: `Run ${runId} does not belong to owner '${ownerSubjectId}'.`,
  };
}

// The one interaction-answer handler. `surface` decides only who the
// requesting owner is; validation, the owner check, the controller call, the
// 202 body, and the `owner.run.interaction_answer` audit are the same on both
// route families.
//
// Answer `data` can carry secrets (passwords, OTP codes). It goes only to
// `respondToInteraction`, which hands it to the waiting connector. It is never
// written to the audit event, the spine, a log line, or the response.
export function buildRunInteractionHandler(ctx: RunInteractionContext, surface: RunControlSurface): RouteHandler {
  return async (req: RouteRequest, res: RouteResponse) => {
    const runId = decodeRunIdParam(req.params.runId as string);
    const actor = resolveRunControlActor(surface, req, ctx.ownerSubjectId);
    let facts: Record<string, string | boolean | null> = {};
    const reject = async (rejection: InteractionRejection) => {
      await emitRunControlAuditSafely(ctx, actor, res, {
        error: rejection,
        facts,
        operation: "answer_interaction",
        outcome: "failed",
        runId,
      });
      return ctx.pdppError(res, rejection.http_status, rejection.code, rejection.message, rejection.param);
    };
    try {
      const { controller } = ctx;
      if (!controller || typeof controller.respondToInteraction !== "function") {
        return await reject({
          code: "not_found",
          http_status: 404,
          message: "Controller is not configured on this server",
        });
      }
      const answer = readInteractionAnswer(req.body);
      if (isRejection(answer)) {
        return await reject(answer);
      }
      facts = {
        has_data: !isNullish(answer.data),
        interaction_id: answer.interaction_id,
        interaction_status: answer.status,
      };
      const mismatch = ownerMismatchRejection(controller, runId, actor.ownerSubjectId);
      if (mismatch) {
        return await reject(mismatch);
      }
      const resolved = await controller.respondToInteraction(runId, {
        data: answer.data,
        interaction_id: answer.interaction_id,
        status: answer.status,
      });
      await emitRunControlAuditSafely(ctx, actor, res, {
        facts,
        operation: "answer_interaction",
        outcome: "succeeded",
        runId,
      });
      return res.status(202).json({
        interaction_id: answer.interaction_id,
        object: "run_interaction_ack",
        run_id: runId,
        status: resolved.status,
      });
    } catch (err) {
      await emitRunControlAuditSafely(ctx, actor, res, {
        error: err,
        facts,
        operation: "answer_interaction",
        outcome: "failed",
        runId,
      });
      return ctx.handleError(res, err);
    }
  };
}

export function mountRefRunInteraction(app: AppLike, ctx: MountRefRunInteractionContext): void {
  app.post(
    "/_ref/runs/:runId/interaction",
    { contract: "refRunInteraction" },
    ctx.requireOwnerSession,
    buildRunInteractionHandler(ctx, "owner_session")
  );
}

export interface PlaygroundSession {
  readonly backend: string;
  readonly interactionId: string;
  readonly runId: string;
}

export interface PlaygroundLike {
  getOrCreatePlaygroundSession: (opts: {
    assistance?: boolean | undefined;
    backend?: string | undefined;
    fresh?: boolean | undefined;
    registerTarget?: boolean | undefined;
    streamDebug?: string | undefined;
  }) => Promise<PlaygroundSession> | PlaygroundSession;
}

interface LoggerLike {
  warn?: (obj: Record<string, unknown>, msg: string) => void;
}

export interface MountRefDevPlaygroundSessionContext {
  logger?: LoggerLike | null | undefined;
  pdppError: PdppErrorFn;
  playground: PlaygroundLike;
  requireOwnerSession: MiddlewareHandler;
}

export function mountRefDevPlaygroundSession(app: AppLike, ctx: MountRefDevPlaygroundSessionContext): void {
  app.post("/_ref/dev/playground/session", ctx.requireOwnerSession, async (req: RouteRequest, res: RouteResponse) => {
    try {
      const body = req.body !== null && typeof req.body === "object" ? (req.body as Record<string, unknown>) : null;
      let backend: string | undefined;
      if (typeof req.query?.backend === "string") {
        // biome-ignore lint/style/useDestructuring: Explicit property or positional access documents this compatibility boundary.
        backend = req.query.backend;
      } else if (body && typeof body.backend === "string") {
        // biome-ignore lint/style/useDestructuring: Explicit property or positional access documents this compatibility boundary.
        backend = body.backend;
      }
      const assistance =
        req.query?.assistance === "1" ||
        req.query?.assistance === "true" ||
        body?.assistance === true ||
        body?.assistance === "1" ||
        body?.assistance === "true";
      const fresh =
        req.query?.fresh === "1" ||
        req.query?.fresh === "true" ||
        body?.fresh === true ||
        body?.fresh === "1" ||
        body?.fresh === "true";
      const registerTarget = !(
        req.query?.register === "0" ||
        req.query?.register === "false" ||
        body?.register_target === false ||
        body?.register_target === "0" ||
        body?.register_target === "false"
      );
      let streamDebug: string | undefined;
      if (typeof req.query?.stream_debug === "string") {
        streamDebug = req.query.stream_debug;
      } else if (body && typeof body.stream_debug === "string") {
        streamDebug = body.stream_debug;
      }
      const session = await ctx.playground.getOrCreatePlaygroundSession({
        assistance,
        backend,
        fresh,
        registerTarget,
        streamDebug,
      });
      return res.status(200).json({
        backend: session.backend,
        interaction_id: session.interactionId,
        object: "stream_playground_session",
        run_id: session.runId,
      });
    } catch (err) {
      const message = (err as { message?: string } | null)?.message ?? "playground session failed";
      ctx.logger?.warn?.({ err: message }, "stream_playground_session_failed");
      return ctx.pdppError(res, 500, "playground_failed", message);
    }
  });
}
