// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// RFC 7009 adapter. Unknown hints are ignored, not unsupported token types.

import { AuthorityUnavailableError } from "../../lib/held-data/authority.ts";
import type { HeldDataEnding } from "../auth.ts";
import type { RouteArg } from "./_route-contract.ts";

interface Request {
  body?: Record<string, unknown>;
  headers?: Record<string, string | string[] | undefined>;
}
interface Response {
  json: (body: unknown) => unknown;
  send: (body: string) => unknown;
  setHeader: (name: string, value: string) => unknown;
  status: (code: number) => Response;
}
type Handler = (req: Request, res: Response) => Promise<unknown>;
const RFC3339_TIME =
  /^(\d{4})-(\d{2})-(\d{2})[tT](?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:[zZ]|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

function receiptTime(value: unknown): number {
  const match = typeof value === "string" ? RFC3339_TIME.exec(value) : null;
  if (!match) {
    return Number.NaN;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
  return day >= 1 && day <= days ? Date.parse(String(value)) : Number.NaN;
}

/** Validate the extension independently of OAuth token authentication. */
function parseLifecycle(body: Record<string, unknown>, now: number): HeldDataEnding | null {
  const disposition = body.pdpp_disposition;
  if (disposition !== undefined && disposition !== "keep" && disposition !== "delete") {
    return null;
  }
  const reportedAt =
    disposition === "delete" && body.reported_at !== undefined ? receiptTime(body.reported_at) : undefined;
  if (reportedAt !== undefined && !(reportedAt <= now)) {
    return null;
  }
  return {
    disposition: disposition ?? null,
    path: "client_revocation",
    ...(reportedAt === undefined ? {} : { reportedAt }),
  };
}

/** Map authority and token errors to the revocation wire contract. */
function revocationError(err: unknown, res: Response): unknown {
  if (err instanceof AuthorityUnavailableError) {
    res.setHeader("Retry-After", "60");
    return res.status(503).json({ error: "temporarily_unavailable" });
  }
  const { code } = err as { code?: string };
  if (code === "temporarily_unavailable") {
    res.setHeader("Retry-After", "60");
    return res.status(503).json({ error: code, grants: (err as { result?: unknown }).result });
  }
  if (code === "unsupported_token_type" || code === "invalid_grant") {
    return res.status(400).json({ error: code });
  }
  throw err;
}

export interface TokenRevocationContext {
  authenticateClient: (
    req: Request,
    body: Record<string, unknown>,
  ) => Promise<{ clientId: string; confidential: boolean }>;
  lifecycleNow: () => number | null;
  revocationUrl: (req: Request) => string;
  revokeToken: (input: {
    token: string;
    clientId: string;
    confidential: boolean;
    lifecycle?: HeldDataEnding;
    dpopProof?: string;
    revocationUrl?: string;
  }) => Promise<void>;
}

export function mountAsTokenRevoke(
  app: { post: (path: string, ...handlers: RouteArg<Handler>[]) => unknown },
  ctx: TokenRevocationContext,
): void {
  const handler: Handler = async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Pragma", "no-cache");
    const body = req.body ?? {};
    let client: { clientId: string; confidential: boolean };
    try {
      client = await ctx.authenticateClient(req, body);
    } catch {
      return res.status(401).json({ error: "invalid_client" });
    }
    if (typeof body.token !== "string" || body.token.length === 0) {
      return res.status(400).json({ error: "invalid_request" });
    }
    const now = ctx.lifecycleNow();
    let lifecycle: HeldDataEnding | null | undefined;
    if (now !== null) {
      lifecycle = parseLifecycle(body, now);
      if (!lifecycle) {
        return res.status(400).json({ error: "invalid_request" });
      }
    }
    try {
      await ctx.revokeToken({
        token: body.token,
        ...client,
        ...(lifecycle ? { lifecycle } : {}),
        ...(typeof req.headers?.dpop === "string" ? { dpopProof: req.headers.dpop } : {}),
        revocationUrl: ctx.revocationUrl(req),
      });
      return res.status(200).send("");
    } catch (err) {
      return revocationError(err, res);
    }
  };
  app.post("/oauth/revoke", handler);
}
