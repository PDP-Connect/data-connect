// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";
import { getAsInternalUrl, getOwnerToken } from "./owner-token.ts";
import { verifyDashboardSession } from "./verify-session.ts";

const identity = z.string().min(1).max(1024);
export const acknowledgmentSchema = z
  .object({
    instanceKey: identity,
    channel: identity,
    coverage: z.enum(["recorded", "not_observable"]),
    accessIdentity: identity,
    accessRevision: identity,
  })
  .strict();
export type AccessAcknowledgment = z.infer<typeof acknowledgmentSchema>;
export const decisionSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    baseEpoch: z.number().int().nonnegative(),
    snapshotDigest: identity,
  })
  .strict();
export type AccessDecision = z.infer<typeof decisionSchema>;
const proposalSchema = z.object({
  proposalId: identity,
  revision: z.number().int().nonnegative(),
  baseEpoch: z.number().int().nonnegative(),
  snapshotDigest: identity,
  status: z.enum(["proposed", "confirmed", "rejected", "superseded", "withdrawn"]),
  snapshot: z.object({
    connectionId: identity,
    phase: z.literal("PREPARED"),
    policyIdentity: identity,
    expiresAt: z.number().min(0).max(8_640_000_000_000_000),
    instances: z
      .array(
        z.object({
          instanceKey: identity,
          kind: identity,
          availability: z.enum(["prepared", "unsupported", "unavailable", "denied"]),
          accessIdentity: identity,
          accessRevision: identity,
          effectiveReach: z.record(z.string(), z.unknown()),
          effectiveConstraints: z.record(z.string(), z.unknown()),
          requestedDeclaration: z.record(z.string(), z.unknown()),
          mechanism: identity,
          mechanismVersion: identity,
          purpose: identity,
          consequentialActions: z.array(z.string()),
          remainingAmbientAccess: z.array(z.string()),
          channels: z
            .array(z.object({ name: identity, coverage: z.enum(["enforced", "recorded", "not_observable"]) }))
            .min(1),
        })
      )
      .min(1),
  }),
});
const stateSchema = z.object({
  active: proposalSchema.nullable(),
  proposal: proposalSchema.nullable(),
  epoch: z.number().int().nonnegative(),
  revision: z.number().int().nonnegative(),
});
export type AccessProposal = z.infer<typeof proposalSchema>;
export type BindingAccessState = z.infer<typeof stateSchema>;
export type AccessDecisionKind = "confirm" | "reject" | "withdraw";
export class BindingAccessHttpError extends Error {
  readonly stale: boolean;
  constructor(stale = false, options?: ErrorOptions) {
    super(
      stale
        ? "Access has changed or expired. Refresh and review it again."
        : "Access review is unavailable. Try again explicitly.",
      options
    );
    this.stale = stale;
  }
}
function path(connectionId: string, proposalId?: string): string {
  return `/v1/owner/connections/${encodeURIComponent(connectionId)}/binding-access-policy${proposalId === undefined ? "" : `/proposals/${encodeURIComponent(proposalId)}`}`;
}
async function request(pathname: string, init: RequestInit = {}): Promise<unknown> {
  await verifyDashboardSession();
  const token = await getOwnerToken();
  let response: Response;
  try {
    response = await fetch(`${getAsInternalUrl()}${pathname}`, {
      ...init,
      cache: "no-store",
      redirect: "error",
      headers: { Authorization: `Bearer ${token}`, ...(init.body ? { "Content-Type": "application/json" } : {}) },
    });
  } catch (error) {
    throw new BindingAccessHttpError(false, { cause: error });
  }
  if (!response.ok) {
    // Never forward backend error text, credentials, or unexpected envelope fields.
    throw new BindingAccessHttpError(response.status === 409);
  }
  try {
    return await response.json();
  } catch (error) {
    throw new BindingAccessHttpError(false, { cause: error });
  }
}
function scoped(proposal: AccessProposal | null, connectionId: string): void {
  if (proposal && proposal.snapshot.connectionId !== connectionId) {
    throw new BindingAccessHttpError();
  }
}
export async function getBindingAccessState(connectionId: string, proposalId?: string): Promise<BindingAccessState> {
  const parsed = stateSchema.safeParse(await request(path(connectionId, proposalId)));
  if (!parsed.success) {
    throw new BindingAccessHttpError();
  }
  scoped(parsed.data.active, connectionId);
  scoped(parsed.data.proposal, connectionId);
  if (proposalId !== undefined && parsed.data.proposal?.proposalId !== proposalId) {
    throw new BindingAccessHttpError();
  }
  return parsed.data;
}
export async function decideBindingAccess(
  connectionId: string,
  proposalId: string,
  decision: AccessDecisionKind,
  input: AccessDecision,
  acknowledgments: readonly AccessAcknowledgment[] = []
): Promise<AccessProposal> {
  const base = decisionSchema.parse(input);
  const body =
    decision === "confirm" ? { ...base, acknowledgments: z.array(acknowledgmentSchema).parse(acknowledgments) } : base;
  const parsed = proposalSchema.safeParse(
    await request(`${path(connectionId, proposalId)}/${decision}`, {
      method: "POST",
      body: JSON.stringify(body),
    })
  );
  if (!parsed.success) {
    throw new BindingAccessHttpError();
  }
  const proposal = parsed.data;
  scoped(proposal, connectionId);
  if (
    proposal.proposalId !== proposalId ||
    proposal.revision !== base.revision ||
    proposal.snapshotDigest !== base.snapshotDigest ||
    proposal.status !== ({ confirm: "confirmed", reject: "rejected", withdraw: "withdrawn" } as const)[decision]
  ) {
    throw new BindingAccessHttpError();
  }
  return proposal;
}
