// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * HTTP adapter for the experimental held-data lifecycle prototype
 * (integration-v2 K2, K3, K4). Every handler answers 404 while no runtime is
 * installed.
 *
 *   POST /oauth/grant-lifecycle            status read (K3)
 *   POST /oauth/grant-lifecycle/report     receipt / completion (client write)
 *   POST /oauth/grant-lifecycle/recover    replace lifecycle authentication
 *   GET  /v1/owner/grants/:grantId/lifecycle             owner record
 *   POST /v1/owner/grants/:grantId/lifecycle/erase       later erase / election
 *   POST /v1/owner/grants/:grantId/lifecycle/recovery-code
 *
 * Status read authentication: `Authorization: Bearer|DPoP <token>` with any
 * access or refresh token the AS issued for the grant, active or not (the AS
 * keeps digests), plus a DPoP proof when the token was bound; or
 * `client_assertion` for a confidential client, which may then batch.
 * Writes need current authentication: an active access token for the grant,
 * or a client assertion. A status-only credential never authenticates a write.
 *
 * Member names are the prototype's own; Core text did not exist yet. The name
 * is not `pdpp_grant_status`, which already means read activity (K7).
 *
 * PROTOTYPE: not for merge until the Core held-data text is final.
 */
import type { StatusResult } from "../../lib/held-data/authority.ts";
import { AuthorityUnavailableError } from "../../lib/held-data/authority.ts";
import { checkDpopProof } from "../../lib/training-lease/dpop.ts";
import type { HeldDataRuntime } from "../held-data/runtime.ts";

interface RouteRequest {
  readonly body?: Record<string, unknown> | null;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly params: Readonly<Record<string, string>>;
}

interface RouteResponse {
  json: (body: unknown) => unknown;
  setHeader: (name: string, value: string) => unknown;
  status: (code: number) => RouteResponse;
}

type Handler = (req: RouteRequest, res: RouteResponse) => Promise<unknown> | unknown;

interface AppLike {
  get: (path: string, handler: Handler) => unknown;
  post: (path: string, handler: Handler) => unknown;
}

interface IntrospectInfo {
  readonly active?: boolean;
  readonly client_id?: string;
  readonly grant_id?: string;
  readonly pdpp_token_kind?: string;
}

export interface MountHeldDataContext {
  authenticateOAuthTokenClient: (input: {
    baseUrl: string;
    clientAssertion: unknown;
    clientAssertionType: unknown;
    clientId: unknown;
    tokenEndpoint: string;
  }) => Promise<string | null>;
  /** Register a grant from the main database if the journal has not seen it (lazy registration). */
  ensureGrant: (grantId: string) => Promise<boolean>;
  introspect: (token: string) => Promise<IntrospectInfo>;
  /** Record the digest of a token the journal has not seen yet (lazy registration from the main database). */
  prepareStatusToken: (token: string) => Promise<void>;
  resolveBaseUrl: (req: unknown) => string;
  runtime: () => HeldDataRuntime | null;
}

function header(req: RouteRequest, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function iso(ms: number | null | undefined): string | null {
  return typeof ms === "number" ? new Date(ms).toISOString() : null;
}

/** Wire form of one status result: times as RFC 3339 strings. */
export function statusWire(r: StatusResult): Record<string, unknown> {
  if ("error" in r) {
    return r;
  }
  return {
    ...r,
    assessed_at: iso(r.assessed_at),
    ending: r.ending ? { ...r.ending, ended_at: iso(r.ending.ended_at) } : null,
    erasures: r.erasures.map((e) => ({
      ...e,
      accepted_at: iso(e.accepted_at),
    })),
  };
}

function tokenFrom(req: RouteRequest): { token: string; scheme: "Bearer" | "DPoP" } | null {
  const auth = header(req, "authorization");
  if (auth?.startsWith("Bearer ")) {
    return { token: auth.slice(7), scheme: "Bearer" };
  }
  if (auth?.startsWith("DPoP ")) {
    return { token: auth.slice(5), scheme: "DPoP" };
  }
  return null;
}

export function mountHeldData(app: AppLike, ctx: MountHeldDataContext): void {
  function endpoint(req: RouteRequest, path: string): { baseUrl: string; url: string } {
    const baseUrl = ctx.resolveBaseUrl(req).replace(/\/+$/, "");
    return { baseUrl, url: `${baseUrl}${path}` };
  }

  async function clientFromAssertion(req: RouteRequest, path: string): Promise<string | null> {
    const body = req.body ?? {};
    if (body.client_assertion === undefined) {
      return null;
    }
    const { baseUrl, url } = endpoint(req, path);
    try {
      return await ctx.authenticateOAuthTokenClient({
        baseUrl,
        clientAssertion: body.client_assertion,
        clientAssertionType: body.client_assertion_type,
        clientId: body.client_id,
        tokenEndpoint: url,
      });
    } catch {
      return null;
    }
  }

  function dpopJkt(req: RouteRequest, rt: HeldDataRuntime, url: string): string | null {
    const proof = header(req, "dpop");
    if (!proof) {
      return null;
    }
    const c = checkDpopProof({
      method: "POST",
      nowS: Math.floor(rt.now() / 1000),
      proof,
      url,
    });
    return c.ok ? c.jkt : null;
  }

  app.post("/oauth/grant-lifecycle", async (req, res) => {
    const rt = ctx.runtime();
    if (!rt) {
      return res.status(404).json({ error: "not_found" });
    }
    res.setHeader("Cache-Control", "no-store");
    const body = req.body ?? {};
    const path = "/oauth/grant-lifecycle";
    const { url } = endpoint(req, path);
    const clientId = await clientFromAssertion(req, path);
    if (body.client_assertion !== undefined && !clientId) {
      return res.status(401).json({ error: "invalid_client" });
    }
    const presented = tokenFrom(req);
    if (presented) {
      await ctx.prepareStatusToken(presented.token);
    }
    const principal = rt.authority.authenticateRead({
      token: presented?.token ?? null,
      dpopJkt: dpopJkt(req, rt, url),
      clientId,
    });
    if (!principal) {
      return res.status(401).json({ error: "invalid_token" });
    }
    const ids = Array.isArray(body.grant_ids)
      ? body.grant_ids.filter((x): x is string => typeof x === "string")
      : [str(body.grant_id)].filter((x): x is string => x !== null);
    if (ids.length === 0) {
      return res.status(400).json({ error: "invalid_request" });
    }
    try {
      const results = rt.authority.status(principal, ids);
      return res.status(200).json({ grants: results.map(statusWire) });
    } catch (err) {
      if (err instanceof AuthorityUnavailableError) {
        res.setHeader("Retry-After", "60");
        return res.status(503).json({ error: "temporarily_unavailable" });
      }
      throw err;
    }
  });

  app.post("/oauth/grant-lifecycle/report", async (req, res) => {
    const rt = ctx.runtime();
    if (!rt) {
      return res.status(404).json({ error: "not_found" });
    }
    res.setHeader("Cache-Control", "no-store");
    const body = req.body ?? {};
    const grantId = str(body.grant_id);
    const operationId = str(body.operation_id);
    const kind = body.kind === "receipt" || body.kind === "completion" ? body.kind : null;
    if (!(grantId && operationId && kind)) {
      return res.status(400).json({ error: "invalid_request" });
    }
    // Current client authentication only (K3): an old token never authenticates a write.
    let clientId = await clientFromAssertion(req, "/oauth/grant-lifecycle/report");
    const presented = tokenFrom(req);
    if (!clientId && presented) {
      try {
        const info = await ctx.introspect(presented.token);
        if (info.active === true && info.pdpp_token_kind === "client" && info.grant_id === grantId && info.client_id) {
          clientId = info.client_id;
        }
      } catch {
        clientId = null;
      }
    }
    if (!clientId) {
      return res.status(401).json({ error: "invalid_token" });
    }
    const ok = rt.authority.report({
      clientId,
      grantId,
      operationId,
      kind,
      ...(body.outcome === "exception" ? { outcome: "exception" as const } : {}),
      ...(typeof body.detail === "string" ? { detail: body.detail } : {}),
    });
    return ok ? res.status(200).json({ recorded: true }) : res.status(400).json({ error: "invalid_grant" });
  });

  app.post("/oauth/grant-lifecycle/recover", async (req, res) => {
    const rt = ctx.runtime();
    if (!rt) {
      return res.status(404).json({ error: "not_found" });
    }
    res.setHeader("Cache-Control", "no-store");
    const body = req.body ?? {};
    const path = "/oauth/grant-lifecycle/recover";
    const grantId = str(body.grant_id);
    if (!grantId) {
      return res.status(400).json({ error: "invalid_request" });
    }
    const credential = rt.authority.replaceStatusCredential({
      grantId,
      jkt: dpopJkt(req, rt, endpoint(req, path).url),
      clientId: await clientFromAssertion(req, path),
      recoveryCode: str(body.recovery_code),
    });
    if (!credential) {
      return res.status(400).json({ error: "invalid_grant" });
    }
    return res.status(200).json({
      status_credential: credential,
      token_type: "pdpp_lifecycle_status",
    });
  });

  async function requireOwner(req: RouteRequest, res: RouteResponse): Promise<boolean> {
    const auth = header(req, "authorization");
    if (auth?.startsWith("Bearer ")) {
      try {
        const info = await ctx.introspect(auth.slice(7));
        if (info.active === true && info.pdpp_token_kind === "owner") {
          return true;
        }
      } catch {
        // fall through
      }
    }
    res.status(401).json({ error: "authentication_error" });
    return false;
  }

  function ownerRecord(rt: HeldDataRuntime, grantId: string) {
    const v = rt.authority.ownerView(grantId, rt.deletionPeriodMs);
    if (!v) {
      return null;
    }
    return {
      grant_id: grantId,
      grant_state: v.grant_state,
      ending: v.ending ? { ...v.ending, ended_at: iso(v.ending.ended_at) } : null,
      erasures: v.erasures.map((e) => ({
        operation_id: e.operation_id,
        scope: e.scope,
        accepted_at: iso(e.accepted_at),
        delivered_at: iso(e.delivered_at),
        receipt_at: iso(e.receipt_at),
        delete_by: iso(e.delete_by),
        // B1: the only bound that holds without delivery.
        use_stops_by: iso(e.accepted_at + rt.pauseThresholdMs),
        completion: e.completion ? { ...e.completion, at: iso(e.completion.at) } : null,
        owner_message: ownerMessage(e, rt.pauseThresholdMs),
      })),
    };
  }

  app.get("/v1/owner/grants/:grantId/lifecycle", async (req, res) => {
    const rt = ctx.runtime();
    if (!rt) {
      return res.status(404).json({ error: "not_found" });
    }
    if (!(await requireOwner(req, res))) {
      return;
    }
    await ctx.ensureGrant(req.params.grantId as string);
    const record = ownerRecord(rt, req.params.grantId as string);
    return record ? res.status(200).json(record) : res.status(404).json({ error: "not_found" });
  });

  app.post("/v1/owner/grants/:grantId/lifecycle/erase", async (req, res) => {
    const rt = ctx.runtime();
    if (!rt) {
      return res.status(404).json({ error: "not_found" });
    }
    if (!(await requireOwner(req, res))) {
      return;
    }
    const grantId = req.params.grantId as string;
    if (!(await ctx.ensureGrant(grantId))) {
      return res.status(404).json({ error: "not_found" });
    }
    rt.authority.elect({ grantId, disposition: "delete" });
    return res.status(200).json(ownerRecord(rt, grantId));
  });

  app.post("/v1/owner/grants/:grantId/lifecycle/recovery-code", async (req, res) => {
    const rt = ctx.runtime();
    if (!rt) {
      return res.status(404).json({ error: "not_found" });
    }
    if (!(await requireOwner(req, res))) {
      return;
    }
    const grantId = req.params.grantId as string;
    if (!(await ctx.ensureGrant(grantId))) {
      return res.status(404).json({ error: "not_found" });
    }
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ recovery_code: rt.authority.ownerRecoveryCode(grantId) });
  });
}

/** K4 wording: "recorded", and only the bounds that hold. */
function ownerMessage(
  e: {
    accepted_at: number;
    delivered_at: number | null;
    receipt_at: number | null;
    delete_by: number | null;
    completion: { outcome: string } | null;
  },
  pauseThresholdMs: number,
): string {
  if (e.completion) {
    return e.completion.outcome === "deleted"
      ? "The app reported that it deleted this data."
      : "The app reported that it could not delete all of this data.";
  }
  const stop = new Date(e.accepted_at + pauseThresholdMs).toISOString();
  if (e.receipt_at !== null && e.delete_by !== null) {
    return `Deletion request recorded and received by the app. Apps that follow PDPP stop using this data now and delete it by ${new Date(e.delete_by).toISOString()}.`;
  }
  return `Deletion request recorded. The app has not confirmed it yet. Apps that follow PDPP stop using this data by ${stop} at the latest; the deletion date is set when the app receives the request.`;
}
