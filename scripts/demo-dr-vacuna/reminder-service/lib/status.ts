// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Grant status sources for the daily held-data check (PDPP PR #401,
// "Positive assessment and reconciliation" and "Grant lifecycle operation").
//
// LifecycleEndpointStatusSource speaks the PR #401 wire format:
//   POST <pdpp_grant_lifecycle_endpoint>, form-encoded, grant_id repeated
//   (confidential client), client authentication as at the token endpoint;
//   200 { grants: [ { grant_id, assessed_at, read_state, ended_at?,
//   held_data: permitted|erase, erasure?: { instruction_id, accepted_at,
//   effective_at, stop_use_by } } | { grant_id, error } ] }.
// The reference AS does not implement that endpoint yet.
//
// IntrospectionStatusSource is the fallback that works against today's
// reference AS: RFC 7662 introspection of the child's current access token
// (with the RS introspection credentials, a demo shortcut). Introspection
// carries no keep-or-delete choice, so the parent's disposition comes from a
// stub (a JSON map grant_id -> "keep" | "delete"), default keep. That stub
// stands in for the AS-recorded disposition PR #401 requires.

import { readFileSync } from "node:fs";
import type { ClientCredentials, FetchLike } from "./oauth.ts";

export interface LifecycleAnswer {
  assessedAt: string;
  endedAt: string | null;
  erasure: { acceptedAt: string | null; effectiveAt: string; instructionId: string; stopUseBy: string } | null;
  grantId: string;
  heldData: "permitted" | "erase";
  readState: "active" | "window_closed" | "expired" | "revoked";
}

export type LifecycleResult = { kind: "answer"; answer: LifecycleAnswer } | { kind: "error"; error: string; grantId: string };

export interface StatusQuery {
  accessToken: string | null;
  grantId: string;
  refreshToken: string | null;
}

export interface GrantStatusSource {
  readonly name: string;
  readonly batchSize: number;
  /** One result per query, same order. Throws on a transport-level failure. */
  query: (queries: StatusQuery[]) => Promise<LifecycleResult[]>;
  /** Optional PR #401 erasure reports (received / completed). */
  report?: (args: { grantId: string; instructionId: string; report: "received" | "completed"; reportedAt: string }) => Promise<boolean>;
}

function parseAnswer(entry: Record<string, unknown>): LifecycleResult {
  const grantId = String(entry.grant_id ?? "");
  if (typeof entry.error === "string") {
    return { error: entry.error, grantId, kind: "error" };
  }
  const erasure = entry.erasure as Record<string, unknown> | undefined;
  return {
    answer: {
      assessedAt: String(entry.assessed_at ?? ""),
      endedAt: typeof entry.ended_at === "string" ? entry.ended_at : null,
      erasure:
        entry.held_data === "erase" && erasure
          ? {
              acceptedAt: typeof erasure.accepted_at === "string" ? erasure.accepted_at : null,
              effectiveAt: String(erasure.effective_at),
              instructionId: String(erasure.instruction_id),
              stopUseBy: String(erasure.stop_use_by),
            }
          : null,
      grantId,
      heldData: entry.held_data === "erase" ? "erase" : "permitted",
      readState: (entry.read_state as LifecycleAnswer["readState"]) ?? "active",
    },
    kind: "answer",
  };
}

export class LifecycleEndpointStatusSource implements GrantStatusSource {
  readonly name = "lifecycle-endpoint";
  readonly batchSize: number;
  private readonly client: ClientCredentials;
  private readonly endpoint: string;
  private readonly fetchImpl: FetchLike;

  constructor(opts: { batchSize?: number; client: ClientCredentials; endpoint: string; fetchImpl?: FetchLike }) {
    this.endpoint = opts.endpoint;
    this.client = opts.client;
    this.batchSize = opts.batchSize ?? 100;
    this.fetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, init));
  }

  async query(queries: StatusQuery[]): Promise<LifecycleResult[]> {
    const params = new URLSearchParams(this.client.fields());
    for (const q of queries) {
      params.append("grant_id", q.grantId);
    }
    const resp = await this.fetchImpl(this.endpoint, {
      body: params.toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
      signal: AbortSignal.timeout(30_000),
    });
    if (resp.status !== 200) {
      throw new Error(`lifecycle query failed: HTTP ${resp.status}`);
    }
    const body = (await resp.json()) as { grants?: Record<string, unknown>[] };
    const byId = new Map((body.grants ?? []).map((g) => [String(g.grant_id), g]));
    return queries.map((q) => {
      const entry = byId.get(q.grantId);
      return entry ? parseAnswer(entry) : { error: "missing_from_response", grantId: q.grantId, kind: "error" };
    });
  }

  async report(args: { grantId: string; instructionId: string; report: "received" | "completed"; reportedAt: string }) {
    const params = new URLSearchParams({
      ...this.client.fields(),
      grant_id: args.grantId,
      instruction_id: args.instructionId,
      report: args.report,
      reported_at: args.reportedAt,
    });
    const resp = await this.fetchImpl(this.endpoint, {
      body: params.toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
      signal: AbortSignal.timeout(30_000),
    });
    return resp.status === 200;
  }
}

export type DispositionStub = (grantId: string) => "keep" | "delete";

export function dispositionStubFromFile(path: string | null | undefined): DispositionStub {
  if (!path) {
    return () => "keep";
  }
  return (grantId) => {
    try {
      const map = JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
      return map[grantId] === "delete" ? "delete" : "keep";
    } catch {
      return "keep";
    }
  };
}

export class IntrospectionStatusSource implements GrantStatusSource {
  readonly name = "introspection+disposition-stub";
  readonly batchSize = 1;
  private readonly authorization: string;
  private readonly disposition: DispositionStub;
  private readonly endpoint: string;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;

  constructor(opts: {
    clientId: string;
    clientSecret: string;
    disposition: DispositionStub;
    endpoint: string;
    fetchImpl?: FetchLike;
    now: () => number;
  }) {
    this.endpoint = opts.endpoint;
    this.authorization = `Basic ${Buffer.from(`${encodeURIComponent(opts.clientId)}:${encodeURIComponent(opts.clientSecret)}`).toString("base64")}`;
    this.disposition = opts.disposition;
    this.fetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, init));
    this.now = opts.now;
  }

  async query(queries: StatusQuery[]): Promise<LifecycleResult[]> {
    const results: LifecycleResult[] = [];
    for (const q of queries) {
      const token = q.accessToken;
      if (!token) {
        results.push({ error: "no_token_to_introspect", grantId: q.grantId, kind: "error" });
        continue;
      }
      const resp = await this.fetchImpl(this.endpoint, {
        body: new URLSearchParams({ token }).toString(),
        headers: { Authorization: this.authorization, "Content-Type": "application/x-www-form-urlencoded" },
        method: "POST",
        signal: AbortSignal.timeout(30_000),
      });
      if (resp.status !== 200) {
        throw new Error(`introspection failed: HTTP ${resp.status}`);
      }
      const info = (await resp.json()) as Record<string, unknown>;
      const reason = typeof info.inactive_reason === "string" ? info.inactive_reason : null;
      let readState: LifecycleAnswer["readState"];
      if (info.active === true) {
        readState = "active";
      } else if (reason === "grant_revoked") {
        readState = "revoked";
      } else if (reason === "grant_expired") {
        readState = "expired";
      } else {
        // An inactive token is not proof the grant ended (PDPP Core 10):
        // count it as a failed attempt and keep held data.
        results.push({ error: `inactive_token:${reason ?? "unknown"}`, grantId: q.grantId, kind: "error" });
        continue;
      }
      const assessedAt = new Date(this.now()).toISOString();
      const erase = readState !== "active" && this.disposition(q.grantId) === "delete";
      results.push({
        answer: {
          assessedAt,
          endedAt: readState === "active" ? null : assessedAt,
          erasure: erase
            ? {
                acceptedAt: assessedAt,
                effectiveAt: assessedAt,
                instructionId: `stub:${q.grantId}`,
                stopUseBy: new Date(this.now() + 48 * 3_600_000).toISOString(),
              }
            : null,
          grantId: q.grantId,
          heldData: erase ? "erase" : "permitted",
          readState,
        },
        kind: "answer",
      });
    }
    return results;
  }
}
