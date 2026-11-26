// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { MiddlewareHandler, PdppErrorFn, RouteArg } from "./_route-contract.ts";

interface RouteRequest {
  readonly params: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, unknown>>;
}

interface RouteResponse {
  header?: (name: string, value: string) => RouteResponse;
  json: (body: unknown) => unknown;
  status: (code: number) => RouteResponse;
}

type RouteHandler = (req: RouteRequest, res: RouteResponse) => unknown | Promise<unknown>;

interface AppLike {
  get: (path: string, ...args: RouteArg<RouteHandler>[]) => AppLike;
}

interface ConnectorInstanceRow {
  readonly connectorId: string;
  readonly connectorInstanceId: string;
  readonly ownerSubjectId: string;
}

interface ConnectorInstanceStore {
  get: (connectorInstanceId: string) => Promise<ConnectorInstanceRow | null> | ConnectorInstanceRow | null;
}

interface RecordRejectionMetadata {
  readonly connectorId: string;
  readonly connectorInstanceId: string;
  readonly createdAt: string;
  readonly firstInputIndex: number;
  readonly lastSeenAt: string;
  readonly latestInputIndex: number;
  readonly payloadBytes: number;
  readonly payloadSha256: string;
  readonly quotaNearLimit: boolean;
  readonly reasonCode: string;
  readonly receiptId: string;
  readonly replayCount: number;
  readonly runId: string | null;
  readonly status: "pending";
  readonly stream: string;
}

interface RecordRejectionDetail extends RecordRejectionMetadata {
  readonly payloadBase64: string;
  readonly payloadEncoding: "base64";
  readonly payloadText: string | null;
}

interface RecordRejectionPage {
  readonly items: readonly RecordRejectionMetadata[];
  readonly nextCursor: string | null;
}

interface RecordRejectionStore {
  getDetail: (input: {
    connectorInstanceId: string;
    ownerSubjectId: string;
    receiptId: string;
  }) => Promise<RecordRejectionDetail | null> | RecordRejectionDetail | null;
  list: (input: {
    connectorInstanceId: string;
    cursor?: string | null;
    limit: number;
    ownerSubjectId: string;
    runId: string | null;
  }) => Promise<RecordRejectionPage> | RecordRejectionPage;
}

export interface MountRefRecordRejectionsContext {
  createRequestConnectorInstanceStore: () => ConnectorInstanceStore;
  createRequestRecordRejectionStore: () => RecordRejectionStore;
  getOwnerSubjectId: (req: unknown) => string;
  handleError: (res: unknown, err: unknown) => void;
  maxRecordRejectionPageSize?: number;
  pdppError: PdppErrorFn;
  requireOwnerSession: MiddlewareHandler;
}

const DEFAULT_MAX_PAGE_SIZE = 100;

function configuredMaxPageSize(ctx: MountRefRecordRejectionsContext): number {
  const configured = ctx.maxRecordRejectionPageSize;
  if (configured !== undefined && Number.isSafeInteger(configured) && configured > 0) {
    return configured;
  }
  return DEFAULT_MAX_PAGE_SIZE;
}

function parseLimit(raw: unknown, maxPageSize: number): number {
  if (typeof raw !== "string" || raw.trim() === "") {
    return maxPageSize;
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return maxPageSize;
  }
  return Math.min(parsed, maxPageSize);
}

function parseCursor(raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === "") {
    return null;
  }
  return typeof raw === "string" ? raw : "__invalid_cursor__";
}

function parseRunId(raw: unknown): string | null | "__invalid_run_id__" {
  if (raw === undefined) {
    return null;
  }
  return typeof raw === "string" && raw !== "" ? raw : "__invalid_run_id__";
}

function sendNotFound(ctx: MountRefRecordRejectionsContext, res: RouteResponse): unknown {
  return ctx.pdppError(res, 404, "not_found", "Record rejection not found");
}

function sendInvalidCursor(ctx: MountRefRecordRejectionsContext, res: RouteResponse): unknown {
  return ctx.pdppError(res, 400, "invalid_cursor", "Record rejection cursor is invalid", "cursor");
}

function isInvalidCursorError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "invalid_cursor";
}

async function resolveOwnedConnection(
  ctx: MountRefRecordRejectionsContext,
  req: RouteRequest,
  connectorInstanceId: string
): Promise<{ connectorInstanceId: string; ownerSubjectId: string } | null> {
  const ownerSubjectId = ctx.getOwnerSubjectId(req);
  const instance = await ctx.createRequestConnectorInstanceStore().get(connectorInstanceId);
  if (!instance || instance.ownerSubjectId !== ownerSubjectId) {
    return null;
  }
  return { connectorInstanceId: instance.connectorInstanceId, ownerSubjectId };
}

function projectMetadata(item: RecordRejectionMetadata): Record<string, unknown> {
  return {
    connection_id: item.connectorInstanceId,
    connector_id: item.connectorId,
    created_at: item.createdAt,
    first_input_index: item.firstInputIndex,
    last_seen_at: item.lastSeenAt,
    latest_input_index: item.latestInputIndex,
    payload_bytes: item.payloadBytes,
    payload_sha256: item.payloadSha256,
    quota_near_limit: item.quotaNearLimit,
    reason_code: item.reasonCode,
    receipt_id: item.receiptId,
    replay_count: item.replayCount,
    run_id: item.runId,
    status: item.status,
    stream: item.stream,
  };
}

function projectDetail(item: RecordRejectionDetail): Record<string, unknown> {
  return {
    ...projectMetadata(item),
    payload_base64: item.payloadBase64,
    payload_encoding: item.payloadEncoding,
    payload_text: item.payloadText,
  };
}

function noStore(res: RouteResponse): void {
  res.header?.("Cache-Control", "private, no-store");
}

// GET .../record-rejections lists receipts oldest first. `?run_id=` narrows the
// list, in the query and ahead of paging, to receipts whose first or latest
// run is that run. Receipts are deduplicated by payload per connection, so a
// payload rejected again in a later run stays one receipt: it matches the run
// that first stored it and the latest run that replayed it, not the runs in
// between.
export function mountRefRecordRejections(app: AppLike, ctx: MountRefRecordRejectionsContext): void {
  app.get(
    "/_ref/connections/:connectorInstanceId/record-rejections",
    { contract: "refListRecordRejections" },
    ctx.requireOwnerSession,
    async (req: RouteRequest, res: RouteResponse) => {
      try {
        const connectorInstanceId = decodeURIComponent(req.params.connectorInstanceId as string);
        noStore(res);
        const owned = await resolveOwnedConnection(ctx, req, connectorInstanceId);
        if (!owned) {
          return sendNotFound(ctx, res);
        }
        const limit = parseLimit(req.query.limit, configuredMaxPageSize(ctx));
        const cursor = parseCursor(req.query.cursor);
        if (cursor === "__invalid_cursor__") {
          return sendInvalidCursor(ctx, res);
        }
        const runId = parseRunId(req.query.run_id);
        if (runId === "__invalid_run_id__") {
          return ctx.pdppError(res, 400, "invalid_request", "run_id must be a non-empty string", "run_id");
        }
        const page = await ctx.createRequestRecordRejectionStore().list({
          connectorInstanceId: owned.connectorInstanceId,
          cursor,
          limit,
          ownerSubjectId: owned.ownerSubjectId,
          runId,
        });
        return res.json({
          data: page.items.map(projectMetadata),
          has_more: page.nextCursor !== null,
          next_cursor: page.nextCursor,
          object: "list",
        });
      } catch (err) {
        if (isInvalidCursorError(err)) {
          return sendInvalidCursor(ctx, res);
        }
        return ctx.handleError(res, err);
      }
    }
  );

  app.get(
    "/_ref/connections/:connectorInstanceId/record-rejections/:receiptId",
    { contract: "refGetRecordRejection" },
    ctx.requireOwnerSession,
    async (req: RouteRequest, res: RouteResponse) => {
      try {
        const connectorInstanceId = decodeURIComponent(req.params.connectorInstanceId as string);
        noStore(res);
        const receiptId = decodeURIComponent(req.params.receiptId as string);
        const owned = await resolveOwnedConnection(ctx, req, connectorInstanceId);
        if (!owned) {
          return sendNotFound(ctx, res);
        }
        const item = await ctx.createRequestRecordRejectionStore().getDetail({
          connectorInstanceId: owned.connectorInstanceId,
          ownerSubjectId: owned.ownerSubjectId,
          receiptId,
        });
        if (!item) {
          return sendNotFound(ctx, res);
        }
        return res.json(projectDetail(item));
      } catch (err) {
        return ctx.handleError(res, err);
      }
    }
  );
}
