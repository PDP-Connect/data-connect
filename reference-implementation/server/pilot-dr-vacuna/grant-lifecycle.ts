// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Pilot-only grant lifecycle answer for parent-approved grants, in the wire
// shape of the draft PDPP PR #401 lifecycle operation that the reminder
// service already speaks (scripts/demo-dr-vacuna/reminder-service/lib/status.ts):
//
//   POST /pilot/vacuna/grant-lifecycle   (confidential client auth, form body)
//     grant_id=…&grant_id=…   -> 200 { grants: [ { grant_id, assessed_at, read_state,
//                                ended_at?, held_data: permitted|erase, erasure? } |
//                                { grant_id, error } ] }
//     grant_id, instruction_id, report=received|completed, reported_at
//                             -> 200 { recorded: true }   (spine event only)
//
// It exists so the parent's keep-or-delete choice (recorded on
// pilot_rep_grants at revocation) reaches the service holding the data. It
// answers only for grants issued to the authenticated client; anything else
// is `invalid_grant`, indistinguishable from an unknown id.

import { emitSpineEvent } from "../../lib/spine.ts";
import { getRepresentativeGrant, type RepresentativeGrantRow } from "./store.ts";

export const STOP_USE_WITHIN_MS = 48 * 60 * 60 * 1000;

export type LifecycleEntry =
  | {
      assessed_at: string;
      ended_at?: string;
      erasure?: { accepted_at: string; effective_at: string; instruction_id: string; stop_use_by: string };
      grant_id: string;
      held_data: "permitted" | "erase";
      read_state: "active" | "expired" | "revoked";
    }
  | { error: "invalid_grant"; grant_id: string };

/** Pure: the lifecycle answer for one pilot grant row as seen by `clientId`. */
export function assessGrant(
  grantId: string,
  row: RepresentativeGrantRow | null,
  clientId: string,
  now: number
): LifecycleEntry {
  if (!row || row.client_id !== clientId) {
    return { error: "invalid_grant", grant_id: grantId };
  }
  const assessedAt = new Date(now).toISOString();
  const expired = row.grant_status === "expired" || (row.expires_at !== null && Date.parse(row.expires_at) <= now);
  const revoked = row.revoked_at !== null || row.grant_status === "revoked";
  if (!(revoked || expired)) {
    return { assessed_at: assessedAt, grant_id: grantId, held_data: "permitted", read_state: "active" };
  }
  const endedAt = (revoked ? row.revoked_at : row.expires_at) ?? assessedAt;
  const entry: LifecycleEntry = {
    assessed_at: assessedAt,
    ended_at: endedAt,
    grant_id: grantId,
    held_data: "permitted",
    read_state: revoked ? "revoked" : "expired",
  };
  if (revoked && row.disposition === "delete") {
    entry.held_data = "erase";
    entry.erasure = {
      accepted_at: endedAt,
      effective_at: endedAt,
      instruction_id: `ers_${grantId}`,
      stop_use_by: new Date(Date.parse(endedAt) + STOP_USE_WITHIN_MS).toISOString(),
    };
  }
  return entry;
}

function asList(value: unknown): string[] {
  const list = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  return list.filter((v): v is string => typeof v === "string" && v.length > 0);
}

export const MAX_GRANTS_PER_QUERY = 100;

export async function answerLifecycleQuery(clientId: string, body: Record<string, unknown>, now = Date.now()) {
  const grantIds = asList(body.grant_id);
  if (typeof body.report === "string") {
    const report = body.report;
    const instructionId = typeof body.instruction_id === "string" ? body.instruction_id : "";
    const grantId = grantIds[0] ?? "";
    if (!(grantId && instructionId && (report === "received" || report === "completed"))) {
      return { body: { error: "invalid_request", error_description: "report needs grant_id, instruction_id, report" }, status: 400 };
    }
    const row = await getRepresentativeGrant(grantId);
    if (!row || row.client_id !== clientId || instructionId !== `ers_${grantId}`) {
      return { body: { error: "invalid_grant" }, status: 400 };
    }
    await emitSpineEvent({
      actor_id: clientId,
      actor_type: "client",
      client_id: clientId,
      data: { instruction_id: instructionId, report, reported_at: body.reported_at ?? null },
      event_type: `representative.erasure_${report}`,
      grant_id: grantId,
      object_id: grantId,
      object_type: "grant",
      status: "succeeded",
      subject_id: row.child_id,
      subject_type: "subject",
    });
    return { body: { recorded: true }, status: 200 };
  }
  if (grantIds.length === 0 || grantIds.length > MAX_GRANTS_PER_QUERY) {
    return {
      body: { error: "invalid_request", error_description: `send 1..${MAX_GRANTS_PER_QUERY} grant_id values` },
      status: 400,
    };
  }
  const grants: LifecycleEntry[] = [];
  for (const grantId of grantIds) {
    grants.push(assessGrant(grantId, await getRepresentativeGrant(grantId), clientId, now));
  }
  return { body: { grants }, status: 200 };
}
