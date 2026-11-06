// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  type AccessPolicyAction,
  BindingAccessPolicyError,
  createConnectorBindingAccessPolicyStore,
  type WeakCoverageAcknowledgment,
} from "../stores/connector-binding-access-policy-store.ts";
import type { MiddlewareHandler, PdppErrorFn, RouteArg } from "./_route-contract.ts";

interface Request {
  readonly body?: unknown;
  readonly params: { readonly connectionId: string; readonly proposalId?: string };
  readonly tokenInfo?: { readonly subject_id?: string | null } | null;
}
interface Response {
  json: (body: unknown) => unknown;
  setHeader: (name: string, value: string) => unknown;
}
type Handler = (req: Request, res: Response) => unknown | Promise<unknown>;
interface App {
  get: (path: string, ...handlers: RouteArg<Handler>[]) => App;
  post: (path: string, ...handlers: RouteArg<Handler>[]) => App;
}
interface Context {
  pdppError: PdppErrorFn;
  requireOwner: MiddlewareHandler;
  requireToken: MiddlewareHandler;
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function decisionBody(body: unknown, decision: "confirm" | "reject" | "withdraw"): Record<string, unknown> {
  const fields =
    decision === "confirm"
      ? ["revision", "baseEpoch", "snapshotDigest", "acknowledgments"]
      : ["revision", "baseEpoch", "snapshotDigest"];
  if (
    !object(body) ||
    Object.keys(body).length !== fields.length ||
    !fields.every((field) => Object.hasOwn(body, field)) ||
    (decision === "confirm" && !Array.isArray(body.acknowledgments))
  ) {
    throw new BindingAccessPolicyError("invalid");
  }
  return body;
}
/** Owner decisions over server-recorded descriptions. There is deliberately no public proposal writer. */
export function mountOwnerBindingAccessPolicy(app: App, ctx: Context): void {
  const store = createConnectorBindingAccessPolicyStore();
  const noStore: MiddlewareHandler = (_req, res, next) => {
    (res as Response).setHeader("Cache-Control", "no-store");
    return (next as () => unknown)();
  };
  const handler =
    (decision?: "confirm" | "reject" | "withdraw"): Handler =>
    async (req, res) => {
      const ownerId = req.tokenInfo?.subject_id;
      if (typeof ownerId !== "string" || ownerId.trim().length === 0) {
        return ctx.pdppError(res, 403, "permission_error", "Owner subject required");
      }
      const key = { connectionId: req.params.connectionId, ownerId };
      try {
        if (!decision) {
          return res.json(await store.read(key, req.params.proposalId));
        }
        const body = decisionBody(req.body, decision);
        const input = {
          ...key,
          baseEpoch: body.baseEpoch,
          proposalId: req.params.proposalId,
          revision: body.revision,
          snapshotDigest: body.snapshotDigest,
        } as AccessPolicyAction;
        return res.json(
          await store.decide(input, decision, (body.acknowledgments ?? []) as WeakCoverageAcknowledgment[])
        );
      } catch (error) {
        const code = error instanceof BindingAccessPolicyError ? error.code : "storage_error";
        const status = { conflict: 409, invalid: 400, not_found: 404, stale: 409, storage_error: 500 }[code];
        return ctx.pdppError(res, status, `binding_access_${code}`, "Binding access decision unavailable");
      }
    };
  const base = "/v1/owner/connections/:connectionId/binding-access-policy";
  app.get(base, noStore, ctx.requireToken, ctx.requireOwner, handler());
  app.get(`${base}/proposals/:proposalId`, noStore, ctx.requireToken, ctx.requireOwner, handler());
  for (const decision of ["confirm", "reject", "withdraw"] as const) {
    app.post(
      `${base}/proposals/:proposalId/${decision}`,
      noStore,
      ctx.requireToken,
      ctx.requireOwner,
      handler(decision)
    );
  }
}
