// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

export type RunStartResponse =
  | { status: "surface_pending"; run_id: string; trace_id: string }
  | { status: "started"; run_id: string; trace_id: string }
  | {
      status: "owner_action_required";
      owner_action: { kind: "confirm_browser_access"; connectionId: string; proposalId: string };
    }
  | {
      status: "placement_refused";
      placement_failure: {
        code: "unsupported_binding" | "binding_unavailable" | "binding_cleanup_unverified";
        instanceKey: string;
      };
    };

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 1024;
}

function sameConnection(body: Record<string, unknown>, connectionId?: string | null): boolean {
  return (
    (body.connectionId === undefined || body.connectionId === connectionId) &&
    (body.connection_id === undefined || body.connection_id === connectionId)
  );
}

/** HTTP success is not admission success. Accept only known, scoped outcomes. */
export function parseRunStartResponse(body: unknown, connectionId?: string | null): RunStartResponse {
  if (
    !(object(body) && sameConnection(body, connectionId)) ||
    (object(body.owner_action) && !sameConnection(body.owner_action, connectionId)) ||
    (object(body.placement_failure) && !sameConnection(body.placement_failure, connectionId))
  ) {
    throw new Error("The server returned an invalid sync result. Refresh this connection before retrying.");
  }
  if (body.status === "owner_action_required") {
    const action = body.owner_action;
    if (
      object(action) &&
      action.kind === "confirm_browser_access" &&
      connectionId &&
      action.connectionId === connectionId &&
      text(action.proposalId)
    ) {
      return {
        status: "owner_action_required",
        owner_action: { kind: action.kind, connectionId, proposalId: action.proposalId },
      };
    }
  } else if (body.status === "placement_refused") {
    const failure = body.placement_failure;
    if (
      object(failure) &&
      (failure.code === "unsupported_binding" ||
        failure.code === "binding_unavailable" ||
        failure.code === "binding_cleanup_unverified") &&
      text(failure.instanceKey)
    ) {
      return {
        status: "placement_refused",
        placement_failure: { code: failure.code, instanceKey: failure.instanceKey },
      };
    }
  } else if (
    ["waiting_for_browser_surface", "starting_surface", "deferred"].includes(String(body.status)) &&
    text(body.run_id) &&
    text(body.trace_id)
  ) {
    return { status: "surface_pending", run_id: body.run_id, trace_id: body.trace_id };
  } else if (
    (body.status === undefined || body.status === "started") &&
    body.owner_action === undefined &&
    body.placement_failure === undefined &&
    text(body.run_id) &&
    (body.trace_id === undefined || text(body.trace_id))
  ) {
    return { status: "started", run_id: body.run_id, trace_id: body.trace_id ?? body.run_id };
  }
  throw new Error("The server did not report a started sync. Refresh this connection before retrying.");
}
