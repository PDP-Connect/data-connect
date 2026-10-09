// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Who is acting on an owner control route, for the two route families that
// mount one shared handler:
//
//   - owner_session: `/_ref/...`, owner cookie (`requireOwnerSession`)
//   - owner_bearer:  `/v1/owner/...`, owner bearer (`requireToken` +
//                    `requireOwner`)
//
// The surface decides only the actor. A shared handler uses the actor for the
// audit event and for credential-state attribution; validation, the mutation,
// errors, and the response body do not depend on it.

import type { TraceContext } from "./_route-contract.ts";

export type OwnerSurface = "owner_session" | "owner_bearer";

export interface OwnerActorRequest {
  readonly ownerSession?: { readonly sub?: string | null } | null;
  readonly tokenInfo?: {
    readonly client_id?: string | null;
    readonly client_name?: string | null;
    readonly pdpp_token_kind?: string | null;
    readonly scenario_id?: string | null;
    readonly subject_id?: string | null;
  } | null;
}

export interface OwnerActor {
  readonly actorId: string;
  // `owner_agent` for an owner bearer. A guard that audits a rejected
  // non-owner bearer resolves the actor too, so the bearer kinds appear here.
  readonly actorKind: "owner_session" | "owner_agent" | "client" | "mcp_package" | "unknown";
  readonly authTokenKind: string | null;
  readonly clientId: string | null;
  readonly clientName: string | null;
  readonly ownerSubjectId: string;
  readonly scenarioId: string | null;
}

function bearerActorKind(tokenKind: string | null): OwnerActor["actorKind"] {
  if (tokenKind === "owner") {
    return "owner_agent";
  }
  if (tokenKind === "client" || tokenKind === "mcp_package") {
    return tokenKind;
  }
  return "unknown";
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

// `ownerSubjectId` is the owner the route already resolved for this request
// (session subject or token subject, each with its own default).
export function resolveOwnerActor(surface: OwnerSurface, req: OwnerActorRequest, ownerSubjectId: string): OwnerActor {
  if (surface === "owner_session") {
    return {
      actorId: ownerSubjectId,
      actorKind: "owner_session",
      authTokenKind: null,
      clientId: null,
      clientName: null,
      ownerSubjectId,
      scenarioId: null,
    };
  }
  const clientId = nonEmptyString(req.tokenInfo?.client_id);
  const authTokenKind = nonEmptyString(req.tokenInfo?.pdpp_token_kind);
  return {
    actorId: clientId ?? ownerSubjectId,
    actorKind: bearerActorKind(authTokenKind),
    authTokenKind,
    clientId,
    clientName: nonEmptyString(req.tokenInfo?.client_name),
    ownerSubjectId,
    scenarioId: nonEmptyString(req.tokenInfo?.scenario_id),
  };
}

// The actor fields every owner control audit event carries in `data`.
export function ownerActorAuditData(actor: OwnerActor): Record<string, string | null> {
  return {
    actor_kind: actor.actorKind,
    auth_token_kind: actor.authTokenKind,
    client_id: actor.clientId,
    client_name: actor.clientName,
  };
}

export interface OwnerAuditTraceContext<Response> {
  createTraceContext: (input?: { scenarioId?: string }) => TraceContext;
  ensureRequestId: (res: Response) => string;
  setReferenceTraceId: (res: Response, traceId: string) => void;
}

// Opens the audit trace for one request and stamps the response with its
// request id and trace id.
export function startOwnerAuditTrace<Response>(
  ctx: OwnerAuditTraceContext<Response>,
  actor: OwnerActor,
  res: Response
): TraceContext {
  const trace = actor.scenarioId ? ctx.createTraceContext({ scenarioId: actor.scenarioId }) : ctx.createTraceContext();
  const requestId = ctx.ensureRequestId(res);
  ctx.setReferenceTraceId(res, trace.trace_id);
  return { request_id: requestId, scenario_id: trace.scenario_id, trace_id: trace.trace_id };
}
