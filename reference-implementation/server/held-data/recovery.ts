// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Lifecycle recovery (Core: Lifecycle recovery). An authorization request with
 * one `authorization_details` element of type
 * `https://pdpp.dev/grant-lifecycle` and `grant_ids`. The owner approves; the
 * token response is a lifecycle-only access token for exactly the approved
 * grants: no refresh token, no read or processing authority, introspection
 * `active: false`, and not a positive assessment.
 *
 * Owner review is a JSON owner route (server/routes/held-data.ts): Core
 * defines no UI locator for owner controls. Pending requests and
 * authorization codes live in memory; a restart drops them and the owner
 * approves again. The approval itself is retained as journal evidence.
 *
 * PROTOTYPE: experimental held-data lifecycle work, off by default.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { AuthorityUnavailableError } from "../../lib/held-data/authority.ts";
import type { HeldDataRuntime } from "./runtime.ts";

export const LIFECYCLE_DETAIL_TYPE = "https://pdpp.dev/grant-lifecycle";
const REQUEST_TTL_MS = 10 * 60 * 1000;
const CODE_TTL_MS = 5 * 60 * 1000;

export interface GrantShown {
  grant_id: string;
  source: string | null;
  purpose: string | null;
  issued_at: string | null;
}

interface RecoveryRequest {
  id: string;
  clientId: string;
  subjectId: string;
  redirectUri: string;
  state: string | null;
  codeChallenge: string;
  grantIds: readonly string[];
  shown: readonly GrantShown[];
  expiresAt: number;
  decision: "pending" | "approved" | "denied";
}

/** In-memory recovery requests and authorization codes of one runtime. */
export class RecoveryRequests {
  readonly requests = new Map<string, RecoveryRequest>();
  readonly codes = new Map<string, { requestId: string; approvalId: string; expiresAt: number }>();
}

export type RecoveryDetails =
  | { kind: "none" }
  | { kind: "invalid" }
  | { kind: "ok"; grantIds: string[] };

/**
 * Classify the elements of an authorization request. A request that carries a
 * lifecycle element must carry only it, with only `type` and `grant_ids`.
 */
export function parseRecoveryDetails(details: readonly unknown[]): RecoveryDetails {
  const isLifecycle = (d: unknown) =>
    typeof d === "object" && d !== null && (d as { type?: unknown }).type === LIFECYCLE_DETAIL_TYPE;
  if (!details.some(isLifecycle)) return { kind: "none" };
  if (details.length !== 1) return { kind: "invalid" };
  const d = details[0] as Record<string, unknown>;
  const ids = d.grant_ids;
  if (
    Object.keys(d).some((k) => k !== "type" && k !== "grant_ids") ||
    !Array.isArray(ids) ||
    ids.length === 0 ||
    ids.some((x) => typeof x !== "string" || x.length === 0) ||
    new Set(ids).size !== ids.length
  ) {
    return { kind: "invalid" };
  }
  return { kind: "ok", grantIds: ids as string[] };
}

export type StartResult =
  | { ok: true; requestId: string; reviewPath: string }
  | { ok: false; status: number; error: string; message: string };

const INVALID_DETAILS: StartResult = {
  ok: false,
  status: 400,
  error: "invalid_authorization_details",
  message: "The lifecycle recovery request is malformed or names a grant that cannot be recovered",
};

/**
 * Validate and park a recovery request for the authenticated owner. A grant
 * that is unknown, belongs to another client or owner, or cannot be checked
 * fails the whole element with the same error, naming none of them.
 */
export async function startLifecycleRecovery(
  rt: HeldDataRuntime,
  deps: {
    ensureGrant: (grantId: string) => Promise<boolean>;
    describeGrant: (grantId: string) => Promise<Omit<GrantShown, "grant_id">>;
  },
  input: {
    details: readonly unknown[];
    clientId: string;
    redirectUri: string;
    state: string | null;
    codeChallenge: string;
    ownerSubjectId: string;
  },
): Promise<StartResult | null> {
  const parsed = parseRecoveryDetails(input.details);
  if (parsed.kind === "none") return null;
  if (parsed.kind === "invalid") return INVALID_DETAILS;
  if (rt.authority.lost) {
    return { ok: false, status: 503, error: "temporarily_unavailable", message: "Lifecycle history is unavailable" };
  }
  for (const id of parsed.grantIds) await deps.ensureGrant(id);
  const issuedToClient = (id: string) =>
    rt.authority.grantClient(id) === input.clientId && rt.authority.grantSubject(id) === input.ownerSubjectId;
  if (!parsed.grantIds.every(issuedToClient)) return INVALID_DETAILS;
  const shown: GrantShown[] = [];
  for (const id of parsed.grantIds) shown.push({ grant_id: id, ...(await deps.describeGrant(id)) });
  const id = `rec_${randomUUID()}`;
  rt.recovery.requests.set(id, {
    id,
    clientId: input.clientId,
    subjectId: input.ownerSubjectId,
    redirectUri: input.redirectUri,
    state: input.state,
    codeChallenge: input.codeChallenge,
    grantIds: Object.freeze([...parsed.grantIds]),
    shown: Object.freeze(shown),
    expiresAt: rt.now() + REQUEST_TTL_MS,
    decision: "pending",
  });
  return { ok: true, requestId: id, reviewPath: `/v1/owner/lifecycle-recovery/${id}` };
}

function live(rt: HeldDataRuntime, id: string): RecoveryRequest | null {
  const r = rt.recovery.requests.get(id);
  return r && rt.now() < r.expiresAt ? r : null;
}

/** What the owner sees before approving (Core: Lifecycle recovery). */
export function reviewRecovery(rt: HeldDataRuntime, id: string) {
  const r = live(rt, id);
  if (!r) return null;
  return {
    request_id: r.id,
    decision: r.decision,
    client: { client_id: r.clientId },
    grants: r.shown,
    statement:
      "Approving lets this app run lifecycle queries, report receipt and completion of erasure, and convey erasure requests for these grants. It gives the app no read access and no processing authority, and it reopens no read window.",
  };
}

const redirectWith = (r: RecoveryRequest, params: Record<string, string>): string => {
  const u = new URL(r.redirectUri);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  if (r.state !== null) u.searchParams.set("state", r.state);
  return u.toString();
};

/**
 * The owner's decision. Approval re-checks the binding, retains the approval
 * as consent evidence, and returns the redirect that carries the code.
 */
export function decideRecovery(rt: HeldDataRuntime, id: string, decision: "approve" | "deny") {
  const r = live(rt, id);
  if (!r || r.decision !== "pending") return null;
  if (decision === "deny") {
    r.decision = "denied";
    return { decision: "denied", redirect_url: redirectWith(r, { error: "access_denied" }) };
  }
  for (const g of r.grantIds) {
    if (rt.authority.grantClient(g) !== r.clientId || rt.authority.grantSubject(g) !== r.subjectId) {
      throw new AuthorityUnavailableError("the named grants can no longer be checked");
    }
  }
  const approvalId = rt.authority.recordRecoveryApproval({
    clientId: r.clientId,
    subjectId: r.subjectId,
    grantIds: r.grantIds,
    shown: [...r.shown],
  });
  r.decision = "approved";
  const code = `hdac_${randomBytes(24).toString("base64url")}`;
  rt.recovery.codes.set(code, { requestId: r.id, approvalId, expiresAt: rt.now() + CODE_TTL_MS });
  return { decision: "approved", approval_id: approvalId, redirect_url: redirectWith(r, { code }) };
}

export interface RecoveryTokenResponse {
  access_token: string;
  token_type: "Bearer";
  authorization_details: { type: typeof LIFECYCLE_DETAIL_TYPE; grant_ids: string[] }[];
  access_token_expires_at?: string;
}

/**
 * Redeem a recovery authorization code. Null when the code is not a recovery
 * code, so the ordinary exchange takes over. A recovery code is single use,
 * bound to its client, redirect URI and PKCE verifier. No refresh token is
 * ever returned.
 */
export function redeemRecoveryCode(
  rt: HeldDataRuntime,
  input: { code: unknown; clientId: unknown; redirectUri: unknown; codeVerifier: unknown },
): RecoveryTokenResponse | null | "invalid_grant" {
  if (typeof input.code !== "string") return null;
  const entry = rt.recovery.codes.get(input.code);
  if (!entry) return null;
  rt.recovery.codes.delete(input.code); // single use, whatever follows
  const r = rt.recovery.requests.get(entry.requestId);
  if (
    !r ||
    rt.now() >= entry.expiresAt ||
    input.clientId !== r.clientId ||
    input.redirectUri !== r.redirectUri ||
    typeof input.codeVerifier !== "string" ||
    createHash("sha256").update(input.codeVerifier).digest("base64url") !== r.codeChallenge
  ) {
    return "invalid_grant";
  }
  const expiresAtMs = rt.now() + rt.recoveryTokenTtlMs;
  const issued = rt.authority.issueRecoveryToken(entry.approvalId, expiresAtMs);
  return {
    access_token: issued.token,
    token_type: "Bearer",
    authorization_details: [{ type: LIFECYCLE_DETAIL_TYPE, grant_ids: issued.grantIds }],
    access_token_expires_at: new Date(expiresAtMs).toISOString(),
  };
}
