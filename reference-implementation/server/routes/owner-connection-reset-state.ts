// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { MiddlewareHandler, PdppErrorFn, RouteArg } from "./_route-contract.ts";

interface Request {
  readonly params: Record<string, string | undefined>;
}
interface Response {
  json: (body: unknown) => unknown;
  status: (status: number) => Response;
}
type Handler = (req: Request, res: Response) => Promise<void>;
interface App {
  post: (path: string, ...args: RouteArg<Handler>[]) => App;
}

export function mountOwnerConnectionResetState(
  app: App,
  ctx: {
    readonly requireToken: MiddlewareHandler;
    readonly requireOwner: MiddlewareHandler;
    readonly getOwnerSubjectId: (req: unknown) => string;
    readonly resetConnectionState: (input: { connectorInstanceId: string; ownerSubjectId: string }) => Promise<unknown>;
    readonly handleError: (res: unknown, error: unknown) => void;
    readonly pdppError: PdppErrorFn;
  }
): void {
  app.post(
    "/v1/owner/connections/:connectorInstanceId/reset-state",
    ctx.requireToken,
    ctx.requireOwner,
    async (req: Request, res: Response) => {
      const id = req.params.connectorInstanceId?.trim();
      if (!id) {
        ctx.pdppError(res, 400, "invalid_request", "connectorInstanceId is required", "connectorInstanceId");
        return;
      }
      try {
        const ownerSubjectId = ctx.getOwnerSubjectId(req);
        const started = (await ctx.resetConnectionState({
          connectorInstanceId: decodeURIComponent(id),
          ownerSubjectId,
        })) as { run_id?: unknown };
        if (typeof started?.run_id !== "string") throw new Error("Reset did not admit a full sync run.");
        res.status(202).json({
          connection_id: id,
          object: "owner_connection_state_reset",
          reset: true,
          run_id: started.run_id,
        });
      } catch (error) {
        ctx.handleError(res, error);
      }
    }
  );
}
