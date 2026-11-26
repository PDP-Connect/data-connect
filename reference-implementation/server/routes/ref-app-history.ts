// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { readAppHistory } from "../../lib/app-history.ts";
import { parseHistoryInput, type HistoryRequest, type HistoryResponse, type HistoryRouteApp, type HistoryRouteContext } from "./ref-sync-history.ts";
export function mountRefAppHistory(app: HistoryRouteApp, ctx: HistoryRouteContext & { ownerSubjectId: (req: HistoryRequest) => string }): void {
  app.get("/_ref/app-history", ctx.requireOwnerSession, async (req: HistoryRequest, res: HistoryResponse) => {
    try {
      const input = parseHistoryInput(req.query ?? {});
      const clientIds = req.query?.client_ids;
      return res.json(await readAppHistory(ctx.ownerSubjectId(req), { ...input,
        ...(clientIds ? { client_ids: String(clientIds).split(",").filter(Boolean) } : {}) }));
    } catch (error) {
      if (error instanceof RangeError || error instanceof SyntaxError) return ctx.pdppError(res, 400, "invalid_request", error.message);
      return ctx.handleError(res, error);
    }
  });
}
