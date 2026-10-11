// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { MiddlewareHandler, PdppErrorFn } from "./_route-contract.ts";

interface Request {
  readonly params: Readonly<Record<string, string>>;
}
interface Response {
  json: (body: unknown) => unknown;
}
type Handler = (req: Request, res: Response) => unknown | Promise<unknown>;
interface AppLike {
  get: (path: string, ...handlers: (MiddlewareHandler | Handler)[]) => AppLike;
}

interface ReadContext {
  readonly handleError: (res: unknown, err: unknown) => void;
  readonly pdppError: PdppErrorFn;
  readonly readRunEffectiveAuthority: (runId: string) => Promise<Readonly<Record<string, unknown>> | null>;
}

function authorityHandler(ctx: ReadContext): Handler {
  return async (req, res) => {
    try {
      const runId = decodeURIComponent(req.params.runId as string);
      const record = await ctx.readRunEffectiveAuthority(runId);
      return record
        ? res.json(record)
        : ctx.pdppError(res, 404, "not_found", `Authority record not found: ${runId}`, "run_id");
    } catch (error) {
      return ctx.handleError(res, error);
    }
  };
}

export function mountRefRunEffectiveAuthority(
  app: AppLike,
  ctx: ReadContext & {
    readonly requireOwnerSession: MiddlewareHandler;
  }
): void {
  app.get("/_ref/runs/:runId/effective-authority", ctx.requireOwnerSession, authorityHandler(ctx));
}

export function mountOwnerRunEffectiveAuthority(
  app: AppLike,
  ctx: ReadContext & {
    readonly requireToken: MiddlewareHandler;
    readonly requireOwner: MiddlewareHandler;
  }
): void {
  app.get("/v1/owner/runs/:runId/effective-authority", ctx.requireToken, ctx.requireOwner, authorityHandler(ctx));
}
