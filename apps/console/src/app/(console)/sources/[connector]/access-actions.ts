"use server";
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";
import {
  acknowledgmentSchema,
  BindingAccessHttpError,
  type BindingAccessState,
  decideBindingAccess,
  decisionSchema,
  getBindingAccessState,
} from "../../lib/binding-access-client.ts";
import { requireDashboardAccess } from "../../lib/dashboard-access.ts";

const inputSchema = z
  .object({
    connectionId: z.string().min(1).max(256),
    proposalId: z.string().min(1).max(256),
    decision: z.enum(["confirm", "reject", "withdraw"]),
    ...decisionSchema.shape,
    acknowledgments: z.array(acknowledgmentSchema).optional(),
  })
  .strict();
export type AccessActionInput = z.infer<typeof inputSchema>;
export type AccessActionResult = { ok: true } | { ok: false; stale: boolean; message: string };

export async function refreshAccessAction(connectionId: string): Promise<BindingAccessState | null> {
  await requireDashboardAccess("/sources");
  if (typeof connectionId !== "string" || !connectionId || connectionId.length > 256) {
    return null;
  }
  try {
    return await getBindingAccessState(connectionId);
  } catch {
    return null;
  }
}
export async function decideAccessAction(input: AccessActionInput): Promise<AccessActionResult> {
  await requireDashboardAccess("/sources");
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, stale: false, message: "Invalid access decision. Refresh and review again." };
  }
  const { connectionId, proposalId, decision, revision, baseEpoch, snapshotDigest, acknowledgments } = parsed.data;
  try {
    // Echo only reviewed facts. Never fetch a fresh epoch/digest to retry a refused write.
    await decideBindingAccess(
      connectionId,
      proposalId,
      decision,
      { revision, baseEpoch, snapshotDigest },
      acknowledgments
    );
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      stale: error instanceof BindingAccessHttpError && error.stale,
      message:
        error instanceof BindingAccessHttpError
          ? error.message
          : "Access decision unavailable. Refresh before retrying.",
    };
  }
}
