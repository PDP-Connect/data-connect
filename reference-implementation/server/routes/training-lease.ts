// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * HTTP adapter for the experimental AI-training lease prototype (draft AI
 * Training Profile, lease note L3, L5, L9). Mounted only when the runtime is
 * installed.
 *
 *   POST /oauth/processing-lease          lease endpoint (L5)
 *   GET  /oauth/processing-lease/jwks     lease signing keys (L9)
 *   GET  /v1/owner/grants/:grantId/training            owner-visible stop time (L3)
 *   POST /v1/owner/grants/:grantId/training/withdraw   training withdrawal (L0, L4)
 *
 * Lease endpoint authentication, in order:
 *   1. `client_assertion` (private_key_jwt): a confidential client, as at the
 *      token endpoint. Returns a lease.
 *   2. `lease_credential` + `DPoP`: a public client's per-grant credential.
 *      Returns a lease and the successor credential.
 *   3. `Authorization: Bearer <access token for the grant>` + `DPoP`:
 *      bootstrap of a public client's credential chain. The RI's token
 *      response schema is closed, so the credential is not "issued with the
 *      grant" as L5 says; it is minted on first use of the grant's token.
 *
 * Every failure after client authentication is the same 400 `no_lease`
 * answer: unknown grant, another client's grant, revoked, withdrawn, expired,
 * bad credential or bad proof are indistinguishable.
 *
 * PROTOTYPE: not for merge until the AI Training Profile is agreed.
 */

import { checkDpopProof } from "../../lib/training-lease/dpop.ts";
import type { TrainingLeaseRuntime } from "../training-lease/runtime.ts";

interface RouteRequest {
  readonly body?: Record<string, unknown> | null;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly ip?: string;
  readonly params: Readonly<Record<string, string>>;
}

interface RouteResponse {
  json: (body: unknown) => unknown;
  setHeader: (name: string, value: string) => unknown;
  status: (code: number) => RouteResponse;
}

type Handler = (
  req: RouteRequest,
  res: RouteResponse,
) => Promise<unknown> | unknown;

interface AppLike {
  get: (path: string, handler: Handler) => unknown;
  post: (path: string, handler: Handler) => unknown;
}

interface IntrospectInfo {
  readonly active?: boolean;
  readonly client_id?: string;
  readonly grant_id?: string;
  readonly pdpp_token_kind?: string;
  readonly subject_id?: string;
  readonly sub?: string;
}

export interface MountTrainingLeaseContext {
  authenticateOAuthTokenClient: (input: {
    baseUrl: string;
    clientAssertion: unknown;
    clientAssertionType: unknown;
    clientId: unknown;
    tokenEndpoint: string;
  }) => Promise<string | null>;
  endProcessingAuthorityForGrant: (
    grantId: string,
    reason: string,
  ) => Promise<void>;
  introspect: (token: string) => Promise<IntrospectInfo>;
  readGrantForProcessing: (grantId: string) => Promise<{
    client_id: string;
    expires_at: string | null;
    status: string;
    subject_id: string;
  } | null>;
  resolveBaseUrl: (req: unknown) => string;
  runtime: () => TrainingLeaseRuntime | null;
}

const NO_LEASE = {
  error: "no_lease",
  error_description: "No processing lease is available for this request.",
};

function header(req: RouteRequest, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

class RateLimiter {
  readonly #windows = new Map<string, { start: number; count: number }>();
  allow(key: string, limit: number, now: number): boolean {
    const w = this.#windows.get(key);
    if (!w || now - w.start >= 60_000) {
      this.#windows.set(key, { start: now, count: 1 });
      return true;
    }
    w.count += 1;
    return w.count <= limit;
  }
}

export function ownerTrainingMessage(
  status: ReturnType<TrainingLeaseRuntime["store"]["status"]>,
): string {
  switch (status.state) {
    case "withdrawn":
    case "expired":
      return `Training stops by ${new Date(status.stopsByMs).toISOString()} for apps that follow PDPP.`;
    case "active":
      return "Training is allowed.";
    default:
      return "No training authority.";
  }
}

export function mountTrainingLease(
  app: AppLike,
  ctx: MountTrainingLeaseContext,
): void {
  const limiter = new RateLimiter();

  /**
   * Both stores must agree that the grant is live. If the main database says
   * the grant ended but the authority record is still active (the
   * withdrawal-first write failed), finish the withdrawal now.
   */
  async function issueIfLive(
    rt: TrainingLeaseRuntime,
    grantId: string,
    clientId: string,
  ) {
    const grant = await ctx.readGrantForProcessing(grantId);
    if (grant && grant.status === "revoked") {
      await ctx.endProcessingAuthorityForGrant(grantId, "grant_revoked");
      return null;
    }
    if (!grant || grant.client_id !== clientId) {
      return null;
    }
    const out = rt.store.issueLease({ clientId, grantId });
    return out.ok ? out : null;
  }

  function leaseBody(
    out: { lease: string; claims: { exp: number } },
    rt: TrainingLeaseRuntime,
  ) {
    return {
      expires_in: Math.max(0, out.claims.exp - Math.floor(rt.now() / 1000)),
      lease: out.lease,
      token_type: "pdpp_processing_lease",
    };
  }

  app.post("/oauth/processing-lease", async (req, res) => {
    const rt = ctx.runtime();
    if (!rt) {
      return res.status(404).json({ error: "not_found" });
    }
    res.setHeader("Cache-Control", "no-store");
    const body = req.body ?? {};
    const baseUrl = ctx.resolveBaseUrl(req).replace(/\/+$/, "");
    const endpoint = `${baseUrl}/oauth/processing-lease`;
    const grantId = str(body.grant_id);
    const rateKey = str(body.client_id) ?? req.ip ?? "anonymous";
    if (!limiter.allow(rateKey, rt.rateLimitPerMinute, rt.now())) {
      return res.status(429).json({ error: "slow_down" });
    }
    if (!grantId) {
      return res.status(400).json(NO_LEASE);
    }

    // 1. Confidential client.
    if (body.client_assertion !== undefined) {
      let clientId: string | null;
      try {
        clientId = await ctx.authenticateOAuthTokenClient({
          baseUrl,
          clientAssertion: body.client_assertion,
          clientAssertionType: body.client_assertion_type,
          clientId: body.client_id,
          tokenEndpoint: endpoint,
        });
      } catch {
        return res.status(401).json({ error: "invalid_client" });
      }
      if (!clientId) {
        return res.status(401).json({ error: "invalid_client" });
      }
      const out = await issueIfLive(rt, grantId, clientId);
      return out
        ? res.status(200).json(leaseBody(out, rt))
        : res.status(400).json(NO_LEASE);
    }

    const dpop = checkDpopProof({
      method: "POST",
      nowS: Math.floor(rt.now() / 1000),
      proof: header(req, "dpop"),
      url: endpoint,
    });

    // 2. Public client renewal with its per-grant credential.
    const credential = str(body.lease_credential);
    if (credential) {
      if (!dpop.ok) {
        return res.status(400).json(NO_LEASE);
      }
      const renewed = rt.credentials.renew({
        credential,
        jkt: dpop.jkt,
        proofJti: dpop.jti,
      });
      if (!renewed.ok || renewed.grantId !== grantId) {
        return res.status(400).json(NO_LEASE);
      }
      const out = await issueIfLive(rt, grantId, renewed.clientId);
      if (!out) {
        return res.status(400).json(NO_LEASE);
      }
      return res
        .status(200)
        .json({ ...leaseBody(out, rt), lease_credential: renewed.successor });
    }

    // 3. Public client bootstrap with the grant's access token.
    const auth = header(req, "authorization");
    if (auth?.startsWith("Bearer ") && dpop.ok) {
      let info: IntrospectInfo;
      try {
        info = await ctx.introspect(auth.slice(7));
      } catch {
        return res.status(400).json(NO_LEASE);
      }
      if (
        info.active !== true ||
        info.pdpp_token_kind !== "client" ||
        info.grant_id !== grantId ||
        !info.client_id
      ) {
        return res.status(400).json(NO_LEASE);
      }
      const out = await issueIfLive(rt, grantId, info.client_id);
      if (!out) {
        return res.status(400).json(NO_LEASE);
      }
      const leaseCredential = rt.credentials.bootstrap({
        clientId: info.client_id,
        grantId,
        jkt: dpop.jkt,
      });
      return res
        .status(200)
        .json({ ...leaseBody(out, rt), lease_credential: leaseCredential });
    }
    return res.status(400).json(NO_LEASE);
  });

  app.get("/oauth/processing-lease/jwks", (_req, res) => {
    const rt = ctx.runtime();
    if (!rt) {
      return res.status(404).json({ error: "not_found" });
    }
    // Short cache: an emergency key revocation (L9) must reach workers soon.
    res.setHeader("Cache-Control", "max-age=60");
    return res.status(200).json(rt.store.jwks());
  });

  async function requireOwner(
    req: RouteRequest,
    res: RouteResponse,
  ): Promise<IntrospectInfo | null> {
    const auth = header(req, "authorization");
    if (!auth?.startsWith("Bearer ")) {
      res.status(401).json({ error: "authentication_error" });
      return null;
    }
    try {
      const info = await ctx.introspect(auth.slice(7));
      if (info.active === true && info.pdpp_token_kind === "owner") {
        return info;
      }
    } catch {
      // fall through
    }
    res.status(401).json({ error: "authentication_error" });
    return null;
  }

  async function ownerStatus(rt: TrainingLeaseRuntime, grantId: string) {
    const grant = await ctx.readGrantForProcessing(grantId);
    let status = rt.store.status(grantId);
    if (grant?.status === "revoked" && status.state === "active") {
      // The withdrawal-first write failed during revocation. Retry it now.
      await ctx.endProcessingAuthorityForGrant(grantId, "grant_revoked");
      status = rt.store.status(grantId);
    }
    const pending = grant?.status === "revoked" && status.state === "active";
    return {
      credential_chains: rt.credentials.chains(grantId),
      grant_id: grantId,
      owner_message: pending
        ? "Training withdrawal is pending."
        : ownerTrainingMessage(status),
      state: pending ? "pending" : status.state,
      training_stops_by:
        !pending && (status.state === "withdrawn" || status.state === "expired")
          ? new Date(status.stopsByMs).toISOString()
          : null,
    };
  }

  app.get("/v1/owner/grants/:grantId/training", async (req, res) => {
    const rt = ctx.runtime();
    if (!rt) {
      return res.status(404).json({ error: "not_found" });
    }
    if (!(await requireOwner(req, res))) {
      return;
    }
    const grantId = req.params.grantId as string;
    if (rt.store.status(grantId).state === "unknown") {
      return res.status(404).json({ error: "not_found" });
    }
    return res.status(200).json(await ownerStatus(rt, grantId));
  });

  app.post("/v1/owner/grants/:grantId/training/withdraw", async (req, res) => {
    const rt = ctx.runtime();
    if (!rt) {
      return res.status(404).json({ error: "not_found" });
    }
    if (!(await requireOwner(req, res))) {
      return;
    }
    const grantId = req.params.grantId as string;
    try {
      const out = rt.store.withdraw({ grantId, reason: "training_withdrawn" });
      if (out.state === "unknown_grant") {
        return res.status(404).json({ error: "not_found" });
      }
    } catch {
      return res.status(202).json({
        grant_id: grantId,
        owner_message: "Training withdrawal is pending.",
        state: "pending",
        training_stops_by: null,
      });
    }
    return res.status(200).json(await ownerStatus(rt, grantId));
  });
}
