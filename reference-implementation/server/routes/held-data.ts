// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * HTTP adapter for the experimental held-data lifecycle prototype: the Core
 * draft's grant lifecycle operation (`rev/held-data` 699e8b71bd) plus owner
 * routes. Every handler answers 404 while no runtime is installed.
 *
 *   POST /oauth/grant-lifecycle            queries and writes (Core)
 *   POST /oauth/grant-lifecycle/recover    replace lifecycle authentication
 *   GET  /v1/owner/grants/:grantId/lifecycle             owner record
 *   POST /v1/owner/grants/:grantId/lifecycle/erase       later erase / election
 *   POST /v1/owner/grants/:grantId/lifecycle/recovery-code
 *
 * Queries: the form parameter `token` (or an `Authorization` header) with any
 * access or refresh token the AS issued for the grant, active or not (the AS
 * keeps digests), plus a DPoP proof when the token was bound; or
 * `client_assertion` for a confidential client, which may then batch.
 * Writes (`report`, `pdpp_disposition=delete`) need current authentication:
 * an active access or package token covering the grant, the current
 * unexpired refresh token, a recovered lifecycle credential (Core's recovery
 * token), or a client assertion.
 *
 * Recovery differs from Core: the owner hands the client a one-time code
 * instead of approving a `grant-lifecycle` authorization request. Answers
 * carry `as_position`, a prototype addition (the journal position the answer
 * is ordered after).
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
  /** Revoke a grant through the RI's revocation funnel, with how it is ending. */
  revokeGrant: (
    grantId: string,
    context: { lifecycle: { path: "owner_withdrawal" | "client_revocation"; disposition: "delete" } }
  ) => Promise<unknown>;
  /** Current client authentication for a write: the client id, or null. */
  writeClient: (token: string, grantId: string) => Promise<string | null>;
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

/**
 * Wire form of one result, in the Core draft's members (`rev/held-data`
 * 699e8b71bd, Grant lifecycle operation). `as_position` is a prototype
 * addition: the journal position the answer is ordered after.
 */
export function statusWire(r: StatusResult, stopUseBoundMs: number): Record<string, unknown> {
  if ("error" in r) {
    return r;
  }
  let readState = "active";
  let endedAt: number | null = null;
  if (r.ending) {
    readState = "revoked";
    endedAt = r.ending.ended_at;
  } else if (r.grant_state === "expired") {
    readState = "expired";
    endedAt = r.expires_at;
  }
  const erase = r.erasures.find((e) => e.scope.streams === "all");
  return {
    grant_id: r.grant_id,
    assessed_at: iso(r.assessed_at),
    read_state: readState,
    ...(endedAt === null ? {} : { ended_at: iso(endedAt) }),
    held_data: erase ? "erase" : "permitted",
    ...(erase
      ? {
          erasure: {
            instruction_id: erase.operation_id,
            accepted_at: iso(erase.accepted_at),
            effective_at: iso(erase.accepted_at),
            stop_use_by: iso(erase.accepted_at + stopUseBoundMs),
          },
        }
      : {}),
    as_position: r.as_position,
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
    res.setHeader("Pragma", "no-cache");
    const body = req.body ?? {};
    const path = "/oauth/grant-lifecycle";
    const { url } = endpoint(req, path);
    const grantIds = (Array.isArray(body.grant_id) ? body.grant_id : [body.grant_id]).filter(
      (x): x is string => typeof x === "string" && x.length > 0
    );
    const report = body.report === undefined ? null : body.report;
    const disposition = body.pdpp_disposition === undefined ? null : body.pdpp_disposition;
    const isWrite = report !== null || disposition !== null;
    const reportKinds = ["received", "completed", "retained"];
    const reportedAt = typeof body.reported_at === "string" ? Date.parse(body.reported_at) : Number.NaN;
    const invalid =
      grantIds.length === 0 ||
      (report !== null && disposition !== null) ||
      (report !== null && !reportKinds.includes(String(report))) ||
      (disposition !== null && disposition !== "delete") ||
      (isWrite && grantIds.length !== 1) ||
      (report !== null && (!str(body.instruction_id) || !Number.isFinite(reportedAt) || reportedAt > rt.now())) ||
      (report === "retained" && !str(body.retained_until));
    if (invalid) {
      return res.status(400).json({ error: "invalid_request" });
    }
    const clientId = await clientFromAssertion(req, path);
    if (body.client_assertion !== undefined && !clientId) {
      return res.status(401).json({ error: "invalid_client" });
    }
    const token = str(body.token) ?? tokenFrom(req)?.token ?? null;
    try {
      if (token) {
        await ctx.prepareStatusToken(token);
      }
      const principal = rt.authority.authenticateRead({ token, dpopJkt: dpopJkt(req, rt, url), clientId });
      if (!principal) {
        return res.status(401).json({ error: token ? "invalid_token" : "invalid_client" });
      }
      if (!isWrite) {
        const results = rt.authority.status(principal, grantIds);
        return res.status(200).json({ grants: results.map((r) => statusWire(r, rt.stopUseBoundMs)) });
      }
      const grantId = grantIds[0] as string;
      const [visible] = rt.authority.status(principal, [grantId]);
      if (!visible || "error" in visible) {
        return res.status(200).json({ grants: [{ grant_id: grantId, error: "invalid_grant" }] });
      }
      // Writes need current client authentication; an old token never authenticates one.
      const writer =
        (clientId && rt.authority.grantClient(grantId) === clientId ? clientId : null) ??
        (token ? await ctx.writeClient(token, grantId) : null);
      if (!writer) {
        return res.status(200).json({ grants: [{ grant_id: grantId, error: "current_authentication_required" }] });
      }
      if (report !== null) {
        const ok = rt.authority.report({
          clientId: writer,
          grantId,
          operationId: str(body.instruction_id) as string,
          kind: report === "received" ? "receipt" : "completion",
          ...(report === "retained"
            ? {
                outcome: "exception" as const,
                detail: `retained_until=${String(body.retained_until)}${typeof body.retention_basis === "string" ? `; basis=${body.retention_basis}` : ""}`,
              }
            : {}),
          reportedAt,
        });
        if (!ok) {
          return res.status(200).json({ grants: [{ grant_id: grantId, error: "invalid_instruction" }] });
        }
      } else if (visible.ending || visible.grant_state === "expired") {
        rt.authority.requestErasure({ grantId, origin: "client_pdpp_disposition" });
      } else {
        // Records the instruction and ends the grant (Core: Erasure, Instruction).
        await ctx.revokeGrant(grantId, { lifecycle: { path: "client_revocation", disposition: "delete" } });
      }
      const after = rt.authority.status(principal, [grantId]);
      return res.status(200).json({ grants: after.map((r) => statusWire(r, rt.stopUseBoundMs)) });
    } catch (err) {
      if (err instanceof AuthorityUnavailableError) {
        res.setHeader("Retry-After", "60");
        return res.status(503).json({ error: "temporarily_unavailable" });
      }
      throw err;
    }
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
    // An instruction that takes effect while the grant is active also revokes it (Core: Erasure).
    const [answer] = rt.authority.status(
      { clientId: rt.authority.grantClient(grantId) ?? "", grantIds: new Set([grantId]), clientAuthenticated: false },
      [grantId]
    );
    if (answer && !("error" in answer) && answer.grant_state === "active") {
      await ctx.revokeGrant(grantId, { lifecycle: { path: "owner_withdrawal", disposition: "delete" } });
    } else {
      rt.authority.elect({ grantId, disposition: "delete" });
    }
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
