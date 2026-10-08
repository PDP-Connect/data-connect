// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * HTTP transports for HeldDataClient against the RI's prototype endpoints
 * (`/oauth/grant-lifecycle`, `/oauth/grant-lifecycle/report`).
 *
 * PROTOTYPE: experimental held-data lifecycle work, off by default.
 */
import type { StatusResult } from "./authority.ts";
import type { ReportTransport, StatusTransport } from "./client.ts";

function ms(v: unknown): number {
  return typeof v === "string" ? Date.parse(v) : Number.NaN;
}

/** Parse one wire result. Anything malformed is treated as no answer. */
export function parseStatusWire(raw: unknown): StatusResult | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.grant_id !== "string") {
    return null;
  }
  if (r.error === "invalid_grant") {
    return { grant_id: r.grant_id, error: "invalid_grant" };
  }
  const assessed = ms(r.assessed_at);
  if (!Number.isFinite(assessed) || typeof r.as_position !== "number" || !Array.isArray(r.erasures)) {
    return null;
  }
  const ending = r.ending as Record<string, unknown> | null;
  return {
    grant_id: r.grant_id,
    grant_state: r.grant_state as "active" | "expired" | "ended",
    ending: ending
      ? {
          path: ending.path as never,
          ended_at: ms(ending.ended_at),
          disposition: (ending.disposition ?? null) as never,
          owner_notice_required: ending.owner_notice_required === true,
        }
      : null,
    erasures: (r.erasures as Record<string, unknown>[]).map((e) => ({
      operation_id: String(e.operation_id),
      scope: e.scope as never,
      accepted_at: ms(e.accepted_at),
    })),
    ordinary_use: r.ordinary_use as "permitted" | "stopped" | "custody_only",
    assessed_at: assessed,
    as_position: r.as_position,
  };
}

export function httpStatusTransport(o: {
  asBaseUrl: string;
  /** Lifecycle credential per grant (an access, refresh or status credential). */
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
        resp = await f(`${o.asBaseUrl}/oauth/grant-lifecycle`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ grant_id: grantId }),
        });
      } catch {
        return { ok: false, reason: "unreachable" };
      }
      if (resp.status === 401) {
        results.push({ grant_id: grantId, error: "invalid_grant" });
        continue;
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
  /** Current authentication for a write: an active access token, or null if none. */
  currentTokenFor: (grantId: string) => string | null;
  fetchImpl?: typeof fetch;
}): ReportTransport {
  const f = o.fetchImpl ?? fetch;
  return async (r) => {
    const token = o.currentTokenFor(r.grantId);
    if (!token) {
      return false;
    }
    const resp = await f(`${o.asBaseUrl}/oauth/grant-lifecycle/report`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        grant_id: r.grantId,
        operation_id: r.operationId,
        kind: r.kind,
        outcome: r.outcome,
      }),
    });
    return resp.ok;
  };
}
