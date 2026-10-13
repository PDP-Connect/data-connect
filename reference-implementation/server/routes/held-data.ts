// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * HTTP adapter for the experimental held-data lifecycle prototype: the Core
 * draft's grant lifecycle operation (`rev/held-data` 699e8b71bd) plus owner
 * routes. Every handler answers 404 while no runtime is installed.
 *
 *   POST /oauth/grant-lifecycle            queries and writes (Core)
 *   GET  /v1/owner/grants/:grantId/lifecycle             owner record
 *   POST /v1/owner/grants/:grantId/lifecycle/erase       later erase / election
 *   GET  /v1/owner/lifecycle-recovery/:requestId         review a recovery request
 *   POST /v1/owner/lifecycle-recovery/:requestId/approve | deny
 *
 * Queries: the form parameter `token` (or an `Authorization` header) with any
 * access or refresh token the AS issued for the grant, active or not (the AS
 * keeps digests), plus a DPoP proof when the token was bound; or
 * `client_assertion` for a confidential client, which may then batch.
 * Writes (`report`, `pdpp_disposition=delete`) need current authentication:
 * an active access or package token covering the grant, the current
 * unexpired refresh token, an unexpired lifecycle recovery token, or a client
 * assertion. Lifecycle recovery is the `authorization_details` flow of
 * `https://pdpp.dev/grant-lifecycle`; see server/held-data/recovery.ts. Its
 * owner review is JSON here: Core defines no UI locator for owner controls.
 * Answers carry `as_position`, a prototype addition (the journal position
 * the answer is ordered after).
 *
 * PROTOTYPE: experimental, tracks the Core held-data text at `ready/v010-held-data`.
 */
import type { StatusResult } from "../../lib/held-data/authority.ts";
import { AuthorityUnavailableError } from "../../lib/held-data/authority.ts";
import { checkDpopProof, DPOP_MAX_AGE_S } from "../../lib/training-lease/dpop.ts";
import { acceptHeldDataClientAssertion, type HeldDataRuntime } from "../held-data/runtime.ts";
import {
  decommissionStatement,
  erasureStatements,
  PENDING_HISTORY_STATEMENT,
  RESTORED_STATEMENT,
  stageLine,
  stagesOf,
  formatRetainedUntil,
} from "../held-data/owner-statements.ts";
import { parseRetainedUntil, parseRfc3339 } from "../held-data/wire.ts";
import { reviewRecovery, decideRecovery } from "../held-data/recovery.ts";

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
  prepareDecommission: () => Promise<{ grant_id: string; grant: Record<string, unknown> | null }[]>;
  introspect: (token: string) => Promise<IntrospectInfo>;
  /** Revoke a grant through the RI's revocation funnel, with how it is ending. */
  revokeGrant: (
    grantId: string,
    context: { lifecycle: { path: "owner_withdrawal" | "client_revocation" | "decommission"; disposition: "keep" | "delete" } }
  ) => Promise<unknown>;
  /** The AS issuer identifier: the required `aud` of a client assertion. */
  issuer: (req: unknown) => string;
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
 * Wire form of one result, in the Core text's members (Grant lifecycle
 * operation). `stop_use_by` is the effective time plus the stop-use bound.
 * `as_position` is a prototype
 * addition: the journal position the answer is ordered after.
 */
export function statusWire(r: StatusResult, stopUseBoundMs: number): Record<string, unknown> {
  if ("error" in r) {
    return r;
  }
  let readState = r.grant_state === "window_closed" ? "window_closed" : "active";
  let endedAt: number | null = null;
  if (r.ending) {
    readState = "revoked";
    endedAt = r.ending.ended_at;
  } else if (r.grant_state === "expired") {
    readState = "expired";
    endedAt = r.expires_at;
  }
  const erase = r.erasures.find((e) => e.scope.streams === "all");
  const effectiveAt = erase?.effective_at ?? erase?.accepted_at;
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
            effective_at: iso(effectiveAt),
            stop_use_by: iso((effectiveAt ?? erase.accepted_at) + stopUseBoundMs),
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

  // Replay caches (Core: Assertions and proofs). Keys live until the
  // assertion or proof could no longer be accepted anyway.
  const seenProofs = new Map<string, number>();
  function firstUse(cache: Map<string, number>, key: string, untilMs: number, nowMs: number): boolean {
    for (const [k, until] of cache) {
      if (until <= nowMs) {
        cache.delete(k);
      }
    }
    if (cache.has(key)) {
      return false;
    }
    cache.set(key, untilMs);
    return true;
  }

  /**
   * Client assertion for the lifecycle operation: `aud` MUST be the AS issuer
   * identifier and `jti` MUST be present and unused for that client.
   */
  async function clientFromAssertion(req: RouteRequest, _path: string): Promise<string | null> {
    const body = req.body ?? {};
    if (body.client_assertion === undefined) {
      return null;
    }
    const rt = ctx.runtime();
    let claims: Record<string, unknown>;
    try {
      claims = JSON.parse(
        Buffer.from(String(body.client_assertion).split(".")[1] ?? "", "base64url").toString("utf8")
      ) as Record<string, unknown>;
    } catch {
      return null;
    }
    if (typeof claims.jti !== "string" || claims.jti.length === 0 || typeof claims.exp !== "number" || !rt) {
      return null;
    }
    const { baseUrl } = endpoint(req, _path);
    let clientId: string | null;
    try {
      clientId = await ctx.authenticateOAuthTokenClient({
        baseUrl,
        clientAssertion: body.client_assertion,
        clientAssertionType: body.client_assertion_type,
        clientId: body.client_id,
        // The verifier checks `aud` against this value: the issuer identifier.
        tokenEndpoint: ctx.issuer(req),
      });
    } catch {
      return null;
    }
    if (!clientId) {
      return null;
    }
    return acceptHeldDataClientAssertion(rt, clientId, claims) ? clientId : null;
  }

  /**
   * The key thumbprint of a valid DPoP proof (RFC 9449 §4.3), or null. With
   * an access token the proof must carry its `ath`; a proof `jti` is accepted
   * once.
   */
  function dpopJkt(req: RouteRequest, rt: HeldDataRuntime, url: string, token: string | null): string | null {
    const proof = header(req, "dpop");
    if (!proof) {
      return null;
    }
    const accessToken = token && rt.authority.credentialKind(token) === "access" ? token : null;
    const c = checkDpopProof({
      method: "POST",
      nowS: Math.floor(rt.now() / 1000),
      proof,
      url,
      ...(accessToken ? { accessToken } : {}),
    });
    if (!c.ok) {
      return null;
    }
    const nowMs = rt.now();
    return firstUse(seenProofs, `${c.jkt} ${c.jti}`, (c.iat + DPOP_MAX_AGE_S) * 1000 + 1, nowMs) ? c.jkt : null;
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
    const reportedAt = parseRfc3339(body.reported_at) ?? Number.NaN;
    const retainedUntil = report === "retained" ? parseRetainedUntil(body.retained_until) : null;
    const optionalText = (v: unknown) => v === undefined || (typeof v === "string" && v.length > 0);
    const invalid =
      grantIds.length === 0 ||
      (report !== null && disposition !== null) ||
      (report !== null && !reportKinds.includes(String(report))) ||
      (disposition !== null && disposition !== "delete") ||
      (isWrite && grantIds.length !== 1) ||
      (report !== null && (!str(body.instruction_id) || !Number.isFinite(reportedAt) || reportedAt > rt.now())) ||
      // With pdpp_disposition, reported_at is optional: the owner's choice time in the client.
      (disposition !== null &&
        body.reported_at !== undefined &&
        (!Number.isFinite(reportedAt) || reportedAt > rt.now())) ||
      // retained_until is one of three forms; a date-time may not precede reported_at.
      (report === "retained" &&
        (retainedUntil === null ||
          (retainedUntil.form === "date-time" && retainedUntil.at < reportedAt) ||
          !optionalText(body.retention_basis) ||
          !optionalText(body.retention_scope)));
    if (invalid) {
      return res.status(400).json({ error: "invalid_request" });
    }
    const clientId = await clientFromAssertion(req, path);
    if (body.client_assertion !== undefined && !clientId) {
      return res.status(401).json({ error: "invalid_client" });
    }
    if (clientId) {
      // Lazy registration: a client-authenticated query names grants the journal may not have seen.
      for (const id of grantIds) {
        await ctx.ensureGrant(id);
      }
    }
    const token = str(body.token) ?? tokenFrom(req)?.token ?? null;
    try {
      if (token) {
        await ctx.prepareStatusToken(token);
      }
      const principal = rt.authority.authenticateRead({ token, dpopJkt: dpopJkt(req, rt, url, token), clientId });
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
      // History that is not current authenticates no write (Core: Lifecycle durability).
      rt.authority.requireCurrent(grantId);
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
          kind: report === "received" ? "receipt" : report === "retained" ? "retained" : "completion",
          ...(report === "retained" && retainedUntil
            ? {
                retained: {
                  until: retainedUntil,
                  basis: typeof body.retention_basis === "string" ? body.retention_basis : null,
                  scope: typeof body.retention_scope === "string" ? body.retention_scope : null,
                },
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
      // The owner's choice in the client is the first receipt. Its time is
      // recorded only when the client reports it; the request's arrival is
      // never taken as the receipt time.
      if (disposition !== null && Number.isFinite(reportedAt)) {
        const [answer] = rt.authority.status(principal, [grantId]);
        const op = answer && !("error" in answer) ? answer.erasures[0]?.operation_id : undefined;
        if (op) {
          rt.authority.report({ clientId: writer, grantId, operationId: op, kind: "receipt", reportedAt });
        }
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
    const durability = rt.authority.durability();
    const unavailable = v.history_state === "unavailable";
    return {
      grant_id: grantId,
      grant_state: v.grant_state,
      history_available: v.history_available,
      history_state: v.history_state,
      durability: durability.statement,
      durability_detail: {
        mechanism: durability.mechanism,
        survives: durability.survives,
        does_not_survive: durability.does_not_survive,
        undetected: durability.undetected,
      },
      pending_actions: v.pending_actions.map((a) => ({ action_id: a.id, kind: a.kind, path: a.path, disposition: a.disposition, accepted_at: iso(a.acceptedAt), status: "pending" })),
      ...(unavailable ? { owner_message: PENDING_HISTORY_STATEMENT } : {}),
      ...(v.history_state === "restored_not_current" ? { owner_message: RESTORED_STATEMENT } : {}),
      ending: v.ending ? { ...v.ending, ended_at: iso(v.ending.ended_at) } : null,
      erasures: v.erasures.map((e) => {
        const facts = {
          accepted_at: e.accepted_at,
          effective_at: e.effective_at,
          delivered_at: e.delivered_at,
          receipt_at: e.receipt_at,
          completion: e.completion,
          retained: e.retained,
        };
        const statements = erasureStatements({
          effectiveAt: e.effective_at,
          stopUseBoundMs: rt.stopUseBoundMs,
          deletionPeriodMs: rt.deletionPeriodMs,
          retentionMaxDuration: v.retention_max_duration,
        });
        const pendingAdvance = e.effective_at === null || e.effective_at > rt.now();
        return {
          operation_id: e.operation_id,
          scope: e.scope,
          accepted_at: iso(e.accepted_at),
          effective_at: iso(e.effective_at),
          delivered_at: iso(e.delivered_at),
          receipt_at: iso(e.receipt_at),
          // Shown only from a reported receipt (Core: AS records and owner statements).
          delete_by: iso(e.delete_by),
          stop_use_by: e.effective_at === null ? null : iso(e.effective_at + rt.stopUseBoundMs),
          stages: stagesOf(facts),
          statements,
          // Each retained report is kept, in order; a later one corrects an earlier one.
          retained: e.retained.map((r) => ({
            reported_at: iso(r.reportedAt),
            received_at: iso(r.receivedAt),
            retained_until: r.until,
            retained_until_display: formatRetainedUntil(r.until),
            retention_basis: r.basis,
            retention_scope: r.scope,
            detail: r.detail,
          })),
          completion: e.completion ? { ...e.completion, at: iso(e.completion.at) } : null,
          owner_message: pendingAdvance
            ? "Advance deletion election recorded. It takes effect when the grant ends; acceptance does not end access or use. The stop-use period runs from that ending, not from this election."
            : `${stageLine(facts, e.delete_by)} ${statements.join(" ")}`,
        };
      }),
    };
  }

  /** Where one grant's disposition stands: offered, recorded, sent, or receipt reported. */
  function dispositionStage(rt: HeldDataRuntime, grantId: string): "offered" | "recorded" | "sent" | "receipt reported" {
    const v = rt.authority.ownerView(grantId, rt.deletionPeriodMs);
    const e = v?.erasures.find((x) => x.scope.streams === "all");
    if (e) {
      return e.receipt_at !== null ? "receipt reported" : e.delivered_at !== null ? "sent" : "recorded";
    }
    return v?.ending?.disposition ? "recorded" : "offered";
  }

  /** A delete the AS holds that no app has received yet: it cannot be delivered once the AS stops answering. */
  function undeliveredDelete(rt: HeldDataRuntime, grantId: string): boolean {
    const e = rt.authority.ownerView(grantId, rt.deletionPeriodMs)?.erasures.find((x) => x.scope.streams === "all");
    return e !== undefined && e.delivered_at === null && e.receipt_at === null;
  }

  app.get("/v1/owner/lifecycle/decommission", async (req, res) => {
    const rt = ctx.runtime();
    if (!rt) {
      return res.status(404).json({ error: "not_found" });
    }
    if (!(await requireOwner(req, res))) {
      return;
    }
    const snapshots = await ctx.prepareDecommission();
    const offer = rt.authority.offerDecommission();
    return res.status(200).json({
      offer_id: offer.id,
      grants: offer.grants.map((grant_id) => ({
        grant_id, choices: ["keep", "delete"], lifecycle: ownerRecord(rt, grant_id),
        stage: dispositionStage(rt, grant_id),
        delete_warning:
          "A delete chosen now reaches the app only when it next gets an answer from this server. Once this server stops answering, an app that has not received it cannot learn of it.",
        ...(undeliveredDelete(rt, grant_id)
          ? { warning: "This delete has not been received by the app. Once this server stops answering, the app cannot learn of it." }
          : {}),
        grant: snapshots.find((g) => g.grant_id === grant_id)?.grant ?? null,
      })),
      owner_message: decommissionStatement(),
    });
  });

  app.post("/v1/owner/lifecycle/decommission", async (req, res) => {
    const rt = ctx.runtime();
    if (!rt) {
      return res.status(404).json({ error: "not_found" });
    }
    if (!(await requireOwner(req, res))) {
      return;
    }
    const grantIds = (await ctx.prepareDecommission()).map((g) => g.grant_id);
    const offerId = str(req.body?.offer_id);
    const dispositions = req.body?.dispositions;
    if (!offerId || !rt.authority.decommissionOfferMatches(offerId, grantIds)) {
      return res.status(400).json({ error: "invalid_request", message: "review the complete decommission offer first" });
    }
    if (!dispositions || typeof dispositions !== "object" || Array.isArray(dispositions)) {
      return res.status(400).json({ error: "disposition_required" });
    }
    const choices = dispositions as Record<string, unknown>;
    if (Object.keys(choices).length !== grantIds.length || grantIds.some((id) => choices[id] !== "keep" && choices[id] !== "delete")) {
      return res.status(400).json({ error: "disposition_required" });
    }
    for (const grantId of grantIds) {
      const disposition = choices[grantId] as "keep" | "delete";
      await ctx.revokeGrant(grantId, { lifecycle: { path: "decommission", disposition } });
      rt.authority.end({ grantId, path: "decommission", disposition });
      rt.authority.elect({ grantId, disposition });
    }
    rt.authority.completeDecommission(offerId);
    return res.status(200).json({
      decommissioned: true,
      grants: grantIds.map((grant_id) => ({
        grant_id,
        disposition: choices[grant_id],
        stage: dispositionStage(rt, grant_id),
        ...(undeliveredDelete(rt, grant_id)
          ? { warning: "This delete has not been received by the app, and it cannot be delivered now that this server has stopped answering." }
          : {}),
      })),
    });
  });

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

  app.post("/v1/owner/grants/:grantId/lifecycle/elect-delete", async (req, res) => {
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
    rt.authority.electAdvance(grantId);
    return res.status(200).json(ownerRecord(rt, grantId));
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
    if (rt.authority.lost) {
      await ctx.revokeGrant(grantId, { lifecycle: { path: "owner_withdrawal", disposition: "delete" } });
      return res.status(202).json(ownerRecord(rt, grantId));
    }
    // An instruction that takes effect while the grant is active also revokes it (Core: Erasure).
    // History that is not current for the grant gives no answer, but the owner's request is still
    // accepted: ending the grant with `delete` records the instruction and is safe whatever the state.
    let answer: ReturnType<typeof rt.authority.status>[number] | undefined;
    try {
      [answer] = rt.authority.status(
        { clientId: rt.authority.grantClient(grantId) ?? "", grantIds: new Set([grantId]), clientAuthenticated: false },
        [grantId]
      );
    } catch (err) {
      if (!(err instanceof AuthorityUnavailableError)) throw err;
    }
    if (!answer || (!("error" in answer) && (answer.grant_state === "active" || answer.grant_state === "window_closed"))) {
      await ctx.revokeGrant(grantId, { lifecycle: { path: "owner_withdrawal", disposition: "delete" } });
    } else {
      rt.authority.elect({ grantId, disposition: "delete" });
    }
    return res.status(200).json(ownerRecord(rt, grantId));
  });

  // Lifecycle recovery (Core): the owner reviews and decides a recovery request that
  // /oauth/authorize parked (server/held-data/recovery.ts).
  app.get("/v1/owner/lifecycle-recovery/:requestId", async (req, res) => {
    const rt = ctx.runtime();
    if (!rt) {
      return res.status(404).json({ error: "not_found" });
    }
    if (!(await requireOwner(req, res))) {
      return;
    }
    const review = reviewRecovery(rt, req.params.requestId as string);
    return review ? res.status(200).json(review) : res.status(404).json({ error: "not_found" });
  });

  for (const decision of ["approve", "deny"] as const) {
    app.post(`/v1/owner/lifecycle-recovery/:requestId/${decision}`, async (req, res) => {
      const rt = ctx.runtime();
      if (!rt) {
        return res.status(404).json({ error: "not_found" });
      }
      if (!(await requireOwner(req, res))) {
        return;
      }
      res.setHeader("Cache-Control", "no-store");
      try {
        const result = decideRecovery(rt, req.params.requestId as string, decision);
        return result ? res.status(200).json(result) : res.status(404).json({ error: "not_found" });
      } catch (err) {
        if (err instanceof AuthorityUnavailableError) {
          res.setHeader("Retry-After", "60");
          return res.status(503).json({ error: "temporarily_unavailable" });
        }
        throw err;
      }
    });
  }
}

