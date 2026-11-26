// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { historyBounds, historyLimit, type HistoryInput } from "../../lib/history-query.ts";
import { readSyncHistory } from "../../lib/sync-history.ts";
import type { MiddlewareHandler, PdppErrorFn } from "./_route-contract.ts";
export function parseHistoryInput(query: Record<string, unknown>): HistoryInput {
  const input: HistoryInput = {
    first: String(query.first ?? ""), last: String(query.last ?? ""), offset: Number(query.offset ?? 0),
    ...(query.connection_id ? { connection_id: String(query.connection_id) } : {}),
    ...(query.day ? { day: String(query.day) } : {}),
    ...(query.limit ? { limit: Number(query.limit) } : {}),
    ...(query.cursor ? { cursor: String(query.cursor) } : {}),
  };
  historyBounds(input); historyLimit(input);
  return input;
}
export interface HistoryRequest { query?: Record<string, unknown> }
export interface HistoryResponse { json: (body: unknown) => unknown }
export type HistoryHandler = (req: HistoryRequest, res: HistoryResponse) => Promise<unknown>;
export interface HistoryRouteApp { get: (path: string, ...handlers: (MiddlewareHandler | HistoryHandler)[]) => unknown }
export interface HistoryRouteContext {
  requireOwnerSession: MiddlewareHandler;
  pdppError: PdppErrorFn;
  handleError: (res: unknown, error: unknown) => void;
}
export function mountRefSyncHistory(app: HistoryRouteApp, ctx: HistoryRouteContext): void {
  app.get("/_ref/sync-history", ctx.requireOwnerSession, async (req: HistoryRequest, res: HistoryResponse) => {
    try {
      const input = parseHistoryInput(req.query ?? {});
      return res.json(await readSyncHistory({ ...input, only_problems: req.query?.only_problems === "true" }));
    } catch (error) {
      if (error instanceof RangeError || error instanceof SyntaxError) return ctx.pdppError(res, 400, "invalid_request", error.message);
      return ctx.handleError(res, error);
    }
  });
}
