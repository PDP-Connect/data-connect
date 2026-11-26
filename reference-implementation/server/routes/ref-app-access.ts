// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { type AppAccess, type AppAccessSourceIdentity, jsonObject } from "../../lib/app-access.ts";
import {
  AppAccessRemovalError,
  removeAppAccess,
  type RemoveAppAccessInput,
} from "../../lib/remove-app-access.ts";
import type { MiddlewareHandler, PdppErrorFn } from "./_route-contract.ts";

interface Request {
  body?: unknown;
  headers: Readonly<Record<string, string | string[] | undefined>>;
  tokenInfo?: { subject_id?: string | null };
}
interface Response {
  json: (body: unknown) => unknown;
}
type Handler = (req: Request, res: Response) => Promise<unknown>;
interface App {
  get: (path: string, ...handlers: (MiddlewareHandler | Handler)[]) => unknown;
  post: (path: string, ...handlers: (MiddlewareHandler | Handler)[]) => unknown;
}
export interface AppAccessRouteContext {
  requireOwnerSession: MiddlewareHandler;
  ownerSubjectId: (req: Request) => string;
  list: (subjectId: string) => AppAccess[] | Promise<AppAccess[]>;
  revokeGrant: (id: string, context: { request_id?: string }) => Promise<unknown>;
  revokePackage: (id: string, context: { request_id?: string }) => Promise<unknown>;
  getPackage: (id: string) => Promise<Record<string, unknown> | null>;
  applyRevokeSideEffects: (id: string) => Promise<void>;
  pdppError: PdppErrorFn;
  handleError: (res: unknown, error: unknown) => void;
}

function parseInput(raw: unknown): RemoveAppAccessInput {
  const body = jsonObject(raw);
  if (
    !Array.isArray(body.client_ids) ||
    !body.client_ids.length ||
    body.client_ids.some((id) => typeof id !== "string" || !id.trim())
  ) {
    throw new AppAccessRemovalError("client_ids must be a nonempty list of registration ids");
  }
  const input: RemoveAppAccessInput = {
    client_ids: body.client_ids as string[],
  };
  if (body.source !== undefined) {
    const source = jsonObject(body.source);
    if (
      !(source.kind === "connector" || source.kind === "provider_native") ||
      typeof source.id !== "string" ||
      !source.id ||
      !(source.connector_id === null || typeof source.connector_id === "string") ||
      !(source.connection_id === null || typeof source.connection_id === "string")
    ) {
      throw new AppAccessRemovalError("source must be a complete app access source identity");
    }
    input.source = source as unknown as AppAccessSourceIdentity;
  }
  return input;
}

export function mountRefAppAccess(app: App, ctx: AppAccessRouteContext): void {
  app.get("/_ref/app-access", ctx.requireOwnerSession, async (req: Request, res: Response) => {
    try {
      return res.json({
        object: "list",
        data: await ctx.list(ctx.ownerSubjectId(req)),
        has_more: false,
      });
    } catch (err) {
      return ctx.handleError(res, err);
    }
  });
  app.post("/_ref/app-access/remove", ctx.requireOwnerSession, async (req: Request, res: Response) => {
    try {
      const input = parseInput(req.body);
      const requestId = req.headers["x-request-id"];
      const context = typeof requestId === "string" ? { request_id: requestId } : {};
      const subjectId = ctx.ownerSubjectId(req);
      return res.json(
        await removeAppAccess(input, {
          list: async () => ctx.list(subjectId),
          revokePackage: async (id) => {
            const pkg = await ctx.getPackage(id);
            const ownedGrants = new Set(
              (await ctx.list(subjectId)).flatMap((entry) =>
                entry.sources.flatMap((source) => source.grant_ids),
              ),
            );
            if (
              !pkg ||
              pkg.subject_id !== subjectId ||
              !input.client_ids.includes(String(pkg.client_id)) ||
              !Array.isArray(pkg.children) ||
              pkg.children.some((child) => !ownedGrants.has(String(jsonObject(child).grant_id)))
            ) {
              throw new AppAccessRemovalError("Package contains permissions outside this owner", 403);
            }
            return ctx.revokePackage(id, context);
          },
          revokeGrant: async (id) => {
            await ctx.revokeGrant(id, context);
            try {
              await ctx.applyRevokeSideEffects(id);
            } catch {
              /* matches the single-grant route's best-effort hook */
            }
          },
        }),
      );
    } catch (err) {
      if (err instanceof AppAccessRemovalError) {
        return ctx.pdppError(
          res,
          err.status,
          err.status === 403 ? "permission_error" : "invalid_request",
          err.message,
        );
      }
      return ctx.handleError(res, err);
    }
  });
}
