// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * HTTP transports for HeldDataClient against the grant lifecycle operation,
 * in the Core draft's wire form (`rev/held-data` 699e8b71bd): a form-encoded
 * POST to `/oauth/grant-lifecycle` with `grant_id` and `token`, answered with
 * `{ grants: [{ grant_id, assessed_at, read_state, held_data, erasure? }] }`.
 * Writes (`report=received|completed`) go to the same endpoint.
 *
 * PROTOTYPE: experimental held-data lifecycle work, off by default.
 */
import type { StatusResult } from "./authority.ts";
import type { ReportTransport, StatusTransport } from "./client.ts";

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
  let grantState: "active" | "expired" | "ended" = "active";
  if (r.read_state === "revoked") {
    grantState = "ended";
  } else if (r.read_state === "expired") {
    grantState = "expired";
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
        ? [{ operation_id: erasure.instruction_id, scope: { streams: "all" }, accepted_at: ms(erasure.accepted_at) }]
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
        return { ok: false, reason: `http_${resp.status}` };
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
}): ReportTransport {
  const f = o.fetchImpl ?? fetch;
  return async (r) => {
    const token = o.currentTokenFor(r.grantId);
    if (!token) {
      return false;
    }
    const resp = await f(
      `${o.asBaseUrl}/oauth/grant-lifecycle`,
      formBody({
        grant_id: r.grantId,
        token,
        report: r.kind === "receipt" ? "received" : "completed",
        instruction_id: r.operationId,
        reported_at: new Date(r.reportedAt ?? Date.now()).toISOString(),
      })
    );
    if (!resp.ok) {
      return false;
    }
    const body = (await resp.json()) as { grants?: { error?: string }[] };
    return !body.grants?.[0]?.error;
  };
}
