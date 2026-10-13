// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * HTTP transports for HeldDataClient against the grant lifecycle operation,
 * in the Core draft's wire form (`rev/held-data` 699e8b71bd): a form-encoded
 * POST to `/oauth/grant-lifecycle` with `grant_id` and `token`, answered with
 * `{ grants: [{ grant_id, assessed_at, read_state, held_data, erasure? }] }`.
 * Writes (`report=received|completed|retained`) go to the same endpoint. A `retained` report carries
 * `retained_until` in one of its three forms (RFC 3339 date-time, `event:<text>`, `unknown`) and,
 * unless law prohibits them, `retention_basis` and `retention_scope`.
 *
 * PROTOTYPE: experimental held-data lifecycle work, off by default.
 */
import type { StatusResult } from "./authority.ts";
import { formatRetentionEnd, type ReportTransport, type StatusTransport } from "./client.ts";

function ms(v: unknown): number {
  return typeof v === "string" ? Date.parse(v) : Number.NaN;
}

/** Parse one wire entry. Anything malformed is treated as no answer. */
export function parseStatusWire(raw: unknown): StatusResult | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.grant_id !== "string") {
    return null;
  }
  if (typeof r.error === "string") {
    return { grant_id: r.grant_id, error: "invalid_grant" };
  }
  const assessed = ms(r.assessed_at);
  if (!Number.isFinite(assessed) || (r.held_data !== "permitted" && r.held_data !== "erase")) {
    return null;
  }
  const erasure = r.erasure as Record<string, unknown> | undefined;
  if (r.held_data === "erase" && !(erasure && typeof erasure.instruction_id === "string")) {
    return null;
  }
  const endedAt = ms(r.ended_at);
  let grantState: "active" | "window_closed" | "expired" | "ended" = "active";
  if (r.read_state === "revoked") {
    grantState = "ended";
  } else if (r.read_state === "expired") {
    grantState = "expired";
  } else if (r.read_state === "window_closed") {
    grantState = "window_closed";
  }
  return {
    grant_id: r.grant_id,
    grant_state: grantState,
    ending:
      r.read_state === "revoked"
        ? { path: "owner_withdrawal", ended_at: endedAt, disposition: null, owner_notice_required: false }
        : null,
    erasures:
      erasure && typeof erasure.instruction_id === "string"
        ? [{ operation_id: erasure.instruction_id, scope: { streams: "all" }, accepted_at: ms(erasure.accepted_at), effective_at: ms(erasure.effective_at) }]
        : [],
    ordinary_use: r.held_data === "erase" ? "stopped" : "permitted",
    assessed_at: assessed,
    expires_at: r.read_state === "expired" && Number.isFinite(endedAt) ? endedAt : null,
    // Not in the Core draft; without it the client's ordering check is a no-op.
    as_position: typeof r.as_position === "number" ? r.as_position : 0,
  };
}

function formBody(o: Record<string, string>): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(o).toString(),
  };
}

export function httpStatusTransport(o: {
  asBaseUrl: string;
  /** Lifecycle credential per grant: any access or refresh token issued for it, or a recovered credential. */
  credentialFor: (grantId: string) => string | null;
  fetchImpl?: typeof fetch;
}): StatusTransport {
  const f = o.fetchImpl ?? fetch;
  return async (grantIds) => {
    const results: StatusResult[] = [];
    for (const grantId of grantIds) {
      const token = o.credentialFor(grantId);
      if (!token) {
        results.push({ grant_id: grantId, error: "invalid_grant" });
        continue;
      }
      let resp: Response;
      try {
        resp = await f(`${o.asBaseUrl}/oauth/grant-lifecycle`, formBody({ grant_id: grantId, token }));
      } catch {
        return { ok: false, reason: "unreachable" };
      }
      if (resp.status === 401) {
        // Not an answer: counts as a failed attempt, retried at the retry delay.
        return { ok: false, reason: "invalid_token" };
      }
      if (!resp.ok) {
        // 429 and 503 are failed attempts; a `Retry-After` in seconds sets the wait.
        const retryAfterS = Number(resp.headers.get("retry-after"));
        return {
          ok: false,
          reason: `http_${resp.status}`,
          ...(Number.isFinite(retryAfterS) && retryAfterS > 0 ? { retryAfterMs: retryAfterS * 1000 } : {}),
        };
      }
      const body = (await resp.json()) as { grants?: unknown[] };
      for (const g of body.grants ?? []) {
        const parsed = parseStatusWire(g);
        if (parsed) {
          results.push(parsed);
        }
      }
    }
    return { ok: true, results };
  };
}

export function httpReportTransport(o: {
  asBaseUrl: string;
  /** Current authentication for a write: an active access token, the current refresh token, or null. */
  currentTokenFor: (grantId: string) => string | null;
  fetchImpl?: typeof fetch;
  now?: () => number;
}): ReportTransport {
  const f = o.fetchImpl ?? fetch;
  const now = o.now ?? Date.now;
  const offsets = new Map<string, number>();
  return async (r) => {
    const token = o.currentTokenFor(r.grantId);
    if (!token) {
      return false;
    }
    const eventTime = r.reportedAt ?? now();
    const send = (reportedAt: number) => f(
      `${o.asBaseUrl}/oauth/grant-lifecycle`,
      formBody({
        grant_id: r.grantId,
        token,
        report: r.kind === "receipt" ? "received" : r.kind === "retained" ? "retained" : "completed",
        instruction_id: r.operationId,
        reported_at: new Date(reportedAt).toISOString(),
        ...(r.kind === "retained" && r.retainedUntil ? { retained_until: formatRetentionEnd(r.retainedUntil) } : {}),
        ...(r.kind === "retained" && r.retentionBasis !== undefined ? { retention_basis: r.retentionBasis } : {}),
        ...(r.kind === "retained" && r.retentionScope !== undefined ? { retention_scope: r.retentionScope } : {}),
      })
    );
    let resp = await send(eventTime + (offsets.get(r.grantId) ?? 0));
    if (resp.status === 400) {
      const error = (await resp.json()) as { error?: string };
      if (error.error !== "invalid_request") return false;
      // Obtain an authenticated AS assessment, not an HTTP Date or arrival time.
      const query = await f(`${o.asBaseUrl}/oauth/grant-lifecycle`, formBody({ grant_id: r.grantId, token }));
      if (!query.ok) return false;
      const atReceipt = now();
      const body = (await query.json()) as { grants?: Record<string, unknown>[] };
      const answers = body.grants?.filter((g) => g.grant_id === r.grantId);
      const answer = answers?.length === 1 ? answers[0] : undefined;
      const assessedAt = ms(answer?.assessed_at);
      const erasure = answer?.erasure as { instruction_id?: string } | undefined;
      if (!Number.isFinite(assessedAt) || erasure?.instruction_id !== r.operationId || eventTime <= assessedAt) return false;
      // Subtract all local elapsed time through query delivery. The client's
      // original receipt stays intact; mapping may only make the report earlier.
      const offset = Math.min(offsets.get(r.grantId) ?? 0, assessedAt - atReceipt, 0);
      offsets.set(r.grantId, offset);
      resp = await send(Math.min(eventTime + offset, assessedAt));
    }
    if (!resp.ok) {
      return false;
    }
    const body = (await resp.json()) as { grants?: { error?: string }[] };
    return !body.grants?.[0]?.error;
  };
}
