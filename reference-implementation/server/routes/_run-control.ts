// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Shared owner resolution and audit for the run-scoped owner controls (cancel a
// run, answer a run's pending interaction). Each control is ONE handler mounted
// behind two auth adapters:
//
//   - owner_session: `/_ref/runs/:runId/...`, owner cookie (`requireOwnerSession`)
//   - owner_bearer:  `/v1/owner/runs/:runId/...`, owner bearer
//                    (`requireToken` + `requireOwner`)
//
// The surface decides only who the actor is (`_owner-actor.ts`). Validation, the controller call,
// the error taxonomy, the response body, and the audit event are the same on
// both surfaces.
//
// The audit event never carries the bearer token, interaction answer data, or
// connector free text. It is keyed on the run (`object_type: "run"`) but does
// not set the `run_id` correlation column, so the run's own timeline stays the
// runtime's lifecycle record.

import {
  type OwnerActor,
  type OwnerActorRequest,
  type OwnerAuditTraceContext,
  type OwnerSurface,
  ownerActorAuditData,
  resolveOwnerActor,
  startOwnerAuditTrace,
} from "./_owner-actor.ts";
import { httpStatusForOperationError } from "./_owner-connection-helpers.ts";

// Decodes the `:runId` path segment; a malformed escape is kept verbatim so it
// reaches the controller as an unknown id instead of throwing outside the
// handler's error path.
export function decodeRunIdParam(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export type RunControlSurface = OwnerSurface;
export type RunControlRequest = OwnerActorRequest;

export interface RunControlAuditContext<Response> extends OwnerAuditTraceContext<Response> {
  emitSpineEvent: (event: Record<string, unknown>) => Promise<unknown>;
  /** Owner subject for a request that carries none (owner auth disabled, or a bearer without `subject_id`). */
  readonly ownerSubjectId: string;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

// The requesting owner is the session subject (cookie) or the token subject
// (bearer); either falls back to the configured owner.
export function resolveRunControlActor(
  surface: RunControlSurface,
  req: RunControlRequest,
  fallbackOwnerSubjectId: string
): OwnerActor {
  const subject = surface === "owner_session" ? req.ownerSession?.sub : req.tokenInfo?.subject_id;
  return resolveOwnerActor(surface, req, nonEmptyString(subject) ?? fallbackOwnerSubjectId);
}

export interface RunControlAuditArgs {
  /** A `RunControlRejection`, or the error passed to `handleError`. */
  readonly error?: unknown;
  /** Non-secret operation facts (ids and statuses only; never answer data). */
  readonly facts?: Readonly<Record<string, string | boolean | null>>;
  readonly operation: "cancel_run" | "answer_interaction";
  readonly outcome: "succeeded" | "failed";
  readonly runId: string;
}

const AUDIT_EVENT_TYPE: Record<RunControlAuditArgs["operation"], string> = {
  answer_interaction: "owner.run.interaction_answer",
  cancel_run: "owner.run.cancel",
};

// A typed rejection the handler answered itself (validation, typed 404/409),
// as opposed to an error it passed to `handleError`.
export interface RunControlRejection {
  readonly code: string;
  readonly http_status: number;
}

function auditError(error: unknown): Record<string, unknown> {
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

// Emits one non-secret audit event for a run control attempt and stamps the
// response with its trace id.
export async function emitRunControlAudit<Response>(
  ctx: RunControlAuditContext<Response>,
  actor: OwnerActor,
  res: Response,
  args: RunControlAuditArgs
): Promise<void> {
  const trace = startOwnerAuditTrace(ctx, actor, res);
  await ctx.emitSpineEvent({
    actor_id: actor.actorId,
    actor_type: actor.actorKind,
    client_id: actor.clientId,
    data: {
      ...ownerActorAuditData(actor),
      operation: args.operation,
      outcome: args.outcome,
      run_id: args.runId,
      target_resource: "run",
      ...args.facts,
      ...auditError(args.error),
    },
    event_type: AUDIT_EVENT_TYPE[args.operation],
    object_id: args.runId,
    object_type: "run",
    request_id: trace.request_id,
    scenario_id: trace.scenario_id,
    status: args.outcome,
    subject_id: actor.ownerSubjectId,
    subject_type: "subject",
    trace_id: trace.trace_id,
  });
}
