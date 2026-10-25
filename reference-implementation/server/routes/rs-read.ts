// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// HTTP adapter for the resource-server read/query route family under `/v1`.
//
// Behaviour-preserving extraction from `server/index.js` per the OpenSpec
// change `split-reference-server-by-route-family` (§3). Each `mount...`
// function registers one route at the same point in registration order where
// `server/index.js` previously registered it inline. Auth posture
// (`requireToken`), request-id / trace-id wiring, source-descriptor / manifest
// / grant resolution, `query.received` and `disclosure.served` spine emission,
// content negotiation, response-envelope shape, status codes, and error->HTTP
// mapping are all unchanged.
//
// The canonical `rs.*` operations (see `operations/rs-connectors-list`,
// `rs-schema-get`, `rs-streams-list`, `rs-streams-detail`,
// `rs-streams-aggregate`, `rs-records-list`, `rs-records-detail`,
// `rs-blobs-read`) own the read semantics and envelope shapes. This adapter
// owns the HTTP wiring only: it MUST NOT recompute visibility rules, disclosure
// totals, or envelope shapes locally. Every host capability the routes touch is
// injected via `MountRsReadContext` so the adapter never reaches back into the
// `buildRsApp` closure or speaks SQL directly.
//
// The three search routes (`/v1/search`, `/v1/search/semantic`,
// `/v1/search/hybrid`) keep their registration-time gating exactly: lexical is
// always mounted; semantic/hybrid are only mounted when their backends are
// configured, evaluated against `ctx.getSemanticBackend()` and the `opts`
// feature flags at mount time, identical to the inline behaviour.

import {
  type BlobsReadDependencies,
  type BlobsReadInput,
  BlobsReadNotFoundError,
  executeBlobsRead,
} from "../../operations/rs-blobs-read/index.ts";
import {
  type ConnectorsListDependencies,
  type ConnectorsListInput,
  executeConnectorsList,
} from "../../operations/rs-connectors-list/index.ts";
import {
  executeRecordDetail,
  type RecordDetailDependencies,
  type RecordDetailInput,
  RecordDetailVisibilityError,
} from "../../operations/rs-records-detail/index.ts";
import {
  executeRecordsList,
  type RecordsListDependencies,
  type RecordsListInput,
  RecordsListVisibilityError,
} from "../../operations/rs-records-list/index.ts";
import {
  projectSchemaCompactView,
  projectSchemaStreamScope,
  schemaSourceOptions,
} from "../../operations/rs-schema-get/compact-view.ts";
import {
  executeSchemaGet,
  type SchemaGetDependencies,
  type SchemaGetInput,
} from "../../operations/rs-schema-get/index.ts";
import {
  executeStreamsAggregate,
  type StreamsAggregateDependencies,
  type StreamsAggregateInput,
  StreamsAggregateVisibilityError,
} from "../../operations/rs-streams-aggregate/index.ts";
import {
  executeStreamDetail,
  type StreamDetailDependencies,
  type StreamDetailInput,
  StreamDetailVisibilityError,
} from "../../operations/rs-streams-detail/index.ts";
import {
  executeStreamsList,
  type StreamsListDependencies,
  type StreamsListInput,
} from "../../operations/rs-streams-list/index.ts";
import {
  clientGrantForPairwiseDetail,
  pairwiseClientReadContext,
  pairwiseClientReadMap,
  pairwiseOwnerReadMap,
  pairwiseOwnerReadMapForSource,
  parsePairwiseReadSelector,
  parsePairwiseReadSelectorSyntax,
  projectPairwiseDetailRecord,
  safePairwiseBlobError,
  safePairwiseDetailError,
  safePairwiseFieldWindowError,
  safePairwiseFieldWindowWarnings,
  type PairwiseReadMap,
} from "../pairwise-rs-identity.ts";
import { rejectUnsupportedClientQuery } from "../record-filters.ts";
import type { MiddlewareHandler, RouteArg } from "./_route-contract.ts";

// Express-shaped surface, structurally typed to avoid pulling in the
// transport's `.js` ambient types. Matches the pattern established in
// `server/routes/ref-dataset.ts` / `ref-connectors.ts`.

interface RouteRequest {
  _pdpp_deprecated_instance_alias?: boolean;
  _pdpp_resolver_warnings?: ResolverWarning[] | undefined;
  readonly headers: Readonly<Record<string, unknown>>;
  readonly params: Readonly<Record<string, string>>;
  readonly path: string;
  readonly query: Readonly<Record<string, unknown>>;
  // The host attaches `tokenInfo` during `requireToken`. Routes also stash
  // `_pdpp_resolver_warnings` on the request scope between resolution and
  // envelope assembly, mirroring the inline handlers.
  tokenInfo: TokenInfo;
}

interface RouteResponse {
  json: (body: unknown) => unknown;
  send: (body: unknown) => unknown;
  setHeader: (name: string, value: string) => unknown;
}

type RouteHandler = (req: RouteRequest, res: RouteResponse) => unknown | Promise<unknown>;

interface AppLike {
  get: (path: string, ...args: RouteArg<RouteHandler>[]) => AppLike;
}

// Structural token shape. The host's `requireToken` middleware narrows the
// real object; these are the fields the read routes read.
interface TokenInfo {
  readonly client_id?: string | null;
  readonly grant?: GrantLike | null;
  readonly grant_id?: string | null;
  readonly pdpp_token_kind?: string | null;
  readonly subject_id?: string | null;
  readonly [key: string]: unknown;
}

interface GrantStreamLike {
  readonly instance_ids?: string[] | null;
  readonly name?: string | null;
  readonly [key: string]: unknown;
}

interface GrantLike {
  readonly streams?: GrantStreamLike[] | null;
  readonly [key: string]: unknown;
}

interface ManifestStreamLike {
  readonly name?: string | null;
  readonly [key: string]: unknown;
}

interface ManifestLike {
  readonly streams?: ManifestStreamLike[] | null;
  readonly [key: string]: unknown;
}

interface SourceDescriptorLike {
  readonly id?: string | null;
  readonly kind?: string | null;
  readonly [key: string]: unknown;
}

interface StorageBindingLike {
  readonly connector_id?: string | null;
  readonly connector_instance_id?: string | null;
  readonly [key: string]: unknown;
}

interface OwnerScopeLike {
  readonly source?: SourceDescriptorLike | null;
  readonly [key: string]: unknown;
}

interface ResolvedManifest {
  readonly manifest: ManifestLike;
  readonly source: SourceDescriptorLike;
  readonly storageBinding: StorageBindingLike;
  readonly [key: string]: unknown;
}

interface QueryActorContext {
  readonly actorId: string | null;
  readonly actorType: string;
  readonly scenarioId: string | null;
  readonly traceId: string | null;
}

interface ResolverWarning {
  readonly code?: string;
  readonly [key: string]: unknown;
}

interface ReadRequestBinding {
  readonly connectorId: string;
  readonly connectorInstanceId: string;
  readonly displayName?: string | null;
  readonly [key: string]: unknown;
}

interface ReadRequestBindingsResult {
  readonly bindings: ReadRequestBinding[];
  readonly requestConnectionId?: string | null;
  readonly warnings?: ResolverWarning[];
  readonly [key: string]: unknown;
}

interface NativeManifest {
  readonly source_declaration?: { readonly source?: SourceDescriptorLike | null } | null;
  readonly storage_binding?: { connector_id?: string | null } | null;
  readonly [key: string]: unknown;
}

interface BlobBindingRow {
  readonly connector_id: string | null;
  readonly connector_instance_id: string | null;
  readonly record_key: string;
  readonly stream: string;
  readonly [key: string]: unknown;
}

interface BlobRow {
  readonly [key: string]: unknown;
}

interface BlobStoreLike {
  listBlobBindingsPage: (args: {
    blobId: string;
    connectorId: string;
    connectorInstanceId: string;
    cursor?: { record_key: string; stream: string } | null;
  }) => Promise<{
    nextCursor: { record_key: string; stream: string } | null;
    rows: readonly BlobBindingRow[];
  }>;
  loadContentAddressedBlob: (blobId: string) => Promise<BlobRow | null>;
}

// The query-context object threaded through `emitQueryReceived` / `rejectQuery`.
// It is built and mutated by the handlers exactly as the inline code did;
// modeled as a permissive record so the adapter does not re-document the
// instrumentation contract.
type QueryContext = Record<string, unknown> & {
  sourceDescriptor: SourceDescriptorLike | null;
  queryData: Record<string, unknown>;
};

// Every host capability the read routes touch. These are all defined or
// imported in `server/index.js` (and are not exported there), so they are
// injected rather than imported. Signatures mirror the inline call sites; the
// permissive `unknown` returns keep the adapter from re-stating each helper's
// internal shape while still type-checking the wiring.
export interface MountRsReadContext {
  aggregateRecordsAcrossBindings: (
    bindings: ReadRequestBinding[],
    stream: string,
    grant: GrantLike | null,
    params: Record<string, unknown>,
    manifest: ManifestLike,
    options: { extraWarnings: ResolverWarning[] }
  ) => Promise<unknown>;
  buildClientSourceDescriptor: (tokenInfo: TokenInfo) => SourceDescriptorLike | null;
  buildConnectorAwareFreshness: (evidence: unknown, recordLastUpdatedAt?: string | null) => unknown;

  // discovery / metadata / freshness builders
  buildConnectorDiscoveryItem: (args: {
    source: SourceDescriptorLike | null;
    storageBinding: StorageBindingLike;
    manifest: ManifestLike;
    grant?: GrantLike | null | undefined;
    ownerSubjectId?: string | null | undefined;
  }) => Promise<unknown>;
  buildConnectorSchemaItem: (args: {
    source: SourceDescriptorLike | null;
    storageBinding: StorageBindingLike;
    manifest: ManifestLike;
    grant?: GrantLike | null | undefined;
    ownerSubjectId?: string | null | undefined;
  }) => Promise<unknown>;
  buildOwnerQuerySourceDescriptor: (req: unknown, opts: unknown) => SourceDescriptorLike | null;
  buildOwnerReadGrant: (streamName: string) => GrantLike;
  buildQueryActorContext: (tokenInfo: TokenInfo) => QueryActorContext;
  buildSourceDescriptor: (sourceBinding: unknown) => SourceDescriptorLike;
  buildStreamMetadataEntry: (args: {
    manifestStream: ManifestStreamLike | undefined;
    streamGrant: GrantStreamLike | null | undefined;
    grantStreams: GrantStreamLike[];
    freshness: unknown;
    manifestStreamNames?: Set<string> | null;
  }) => unknown;
  canonicalConnectorKey: (connectorId: string) => string | null;

  /**
   * Cheap, honest count of currently-dirty search-index scopes
   * (process-wide, not scoped to any one query). Used to attach an
   * additive `meta.index_maintenance` disclosure when nonzero. Optional so
   * hosts/tests that do not wire it simply omit the disclosure.
   */
  countSearchIndexDirtyScopes?: () => Promise<number>;

  // blob read
  createBlobStore: () => BlobStoreLike;
  decorateRecordBlobRefs: (record: unknown) => unknown;
  emitQueryReceived: (context: QueryContext, req: unknown) => Promise<void>;
  emitSpineEvent: (event: Record<string, unknown>) => Promise<unknown>;

  // request/response + instrumentation helpers
  ensureRequestId: (res: unknown) => string;
  finalizeCanonicalEnvelope: (payload: unknown, req: unknown) => unknown;
  getConnectorFreshnessEvidence: (args: {
    storageBinding: StorageBindingLike;
    manifest: ManifestLike;
  }) => Promise<unknown>;
  getOwnerTokenSubjectId: (req: unknown) => string | null;
  getRecord: (
    storageTarget: StorageBindingLike,
    stream: string,
    recordKey: string,
    grant: GrantLike | null,
    manifest: ManifestLike
  ) => Promise<{ data?: { blob_ref?: { blob_id?: string } } } | null>;
  getRecordAcrossBindings: (
    bindings: ReadRequestBinding[],
    stream: string,
    recordId: string,
    grant: GrantLike | null,
    manifest: ManifestLike,
    params: Record<string, unknown>,
    options: { extraWarnings: ResolverWarning[] }
  ) => Promise<unknown>;
  getRecordFieldWindowAcrossBindings: (
    bindings: ReadRequestBinding[],
    stream: string,
    recordId: string,
    fieldPath: string,
    grant: GrantLike | null,
    manifest: ManifestLike,
    params: Record<string, unknown>,
    options: { extraWarnings: ResolverWarning[] }
  ) => Promise<unknown>;
  getSemanticBackend: () => { available: () => boolean } | null;
  getVisibleStreamFreshness: (args: {
    tokenInfo: TokenInfo;
    source: SourceDescriptorLike | null;
    storageBinding: StorageBindingLike;
    stream: string;
    manifest: ManifestLike;
  }) => Promise<unknown>;
  handleError: (res: unknown, err: unknown) => void;

  // records.js substrate reads
  listAllStreams: (storageBinding: StorageBindingLike) => Promise<unknown[]>;
  listRegisteredConnectorIds: () => Promise<string[]>;
  listStreamsAcrossBindings: (
    bindings: ReadRequestBinding[],
    grant: GrantLike | null,
    manifest: ManifestLike,
    options: { resolveBindingsForStream: (streamGrant: GrantStreamLike) => Promise<ReadRequestBinding[]> }
  ) => Promise<Record<string, unknown>[]>;
  readonly opts: Readonly<Record<string, unknown>>;
  ownerSubjectIdForBindings: (tokenInfo: TokenInfo) => string | null;
  projectBindingForWire: (args: {
    connectorInstanceId: string | null;
    connectorId: string | null;
    displayName: string | null;
  }) => unknown;
  queryRecordsAcrossBindings: (
    bindings: ReadRequestBinding[],
    stream: string,
    grant: GrantLike | null,
    params: Record<string, unknown>,
    manifest: ManifestLike,
    options: { extraWarnings: ResolverWarning[] }
  ) => Promise<unknown>;
  rejectQuery: (
    res: unknown,
    req: unknown,
    context: QueryContext,
    err: unknown,
    param?: string | null
  ) => Promise<unknown>;
  readonly requireCoreEndpointToken: MiddlewareHandler;
  readonly requireToken: MiddlewareHandler;
  resolveGrantManifest: (tokenInfo: TokenInfo, opts: unknown) => Promise<ResolvedManifest>;

  // manifest / grant / scope resolution
  resolveNativeManifest: (opts: unknown) => NativeManifest | null;
  resolveNativeStorageBinding: (opts: unknown) => StorageBindingLike | null;
  resolveOwnerManifest: (req: unknown, opts: unknown) => Promise<ResolvedManifest>;
  resolveOwnerManifestFromScope: (ownerScope: unknown, opts: unknown) => Promise<ResolvedManifest>;
  resolveOwnerReadScope: (req: unknown, opts: unknown) => Promise<OwnerScopeLike>;
  resolveReadRequestBindings: (args: {
    ownerSubjectId: string | null;
    storageBinding: StorageBindingLike;
    grant: GrantLike | null;
    requestParams: Record<string, unknown>;
    streamName: string | null;
    ownerRead?: boolean;
  }) => Promise<ReadRequestBindingsResult>;
  validatePairwiseReadBindingOwnership: (args: {
    ownerSubjectId: string;
    bindings: readonly {
      readonly source_id: string;
      readonly rs_instance: string;
    }[];
  }) => Promise<void>;
  resolveRegisteredConnectorManifest: (connectorId: string) => Promise<ManifestLike>;
  runHybridSearch: (args: Record<string, unknown>) => Promise<{ envelope: unknown; disclosureData: unknown }>;
  // search surfaces
  runLexicalSearch: (args: Record<string, unknown>) => Promise<{ envelope: unknown; disclosureData: unknown }>;
  runSemanticSearch: (args: Record<string, unknown>) => Promise<{ envelope: unknown; disclosureData: unknown }>;
  setReferenceTraceId: (res: unknown, traceId: string | null) => void;
  /**
   * Read-time self-heal (I3) trigger. MUST be non-blocking (fire-and-forget)
   * and internally deduplicated/cooldown-gated -- a single dirty scope's
   * backfill has no wall-clock bound, so awaiting this could hang an
   * ordinary search request. Returns void, not a Promise, specifically so a
   * caller cannot accidentally await it. Optional so tests/hosts that do not
   * wire it simply skip the self-heal (search still works, relying solely on
   * the periodic sweep for convergence).
   */
  triggerSearchIndexDirtySelfHeal?: () => void;
  validateRequestedQueryFieldParams: (
    requestParams: Record<string, unknown>,
    manifestStream: ManifestStreamLike | undefined
  ) => void;
}

function authorizationTokenId(req: RouteRequest): string | null {
  const auth = req.headers.authorization;
  return typeof auth === "string" ? auth.slice(7) : null;
}

// Resolve the request-time `connection_id`, honoring the deprecated
// `connector_instance_id` alias. Mirrors the inline precedence the
// `/v1/streams` handler used: explicit `connection_id` wins, then the
// alias, then null.
function resolveRequestConnectionId(query: Readonly<Record<string, unknown>>): string | null {
  // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
  if (typeof query?.connection_id === "string" && query.connection_id) {
    return query.connection_id;
  }
  // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
  if (typeof query?.connector_instance_id === "string" && query.connector_instance_id) {
    return query.connector_instance_id;
  }
  return null;
}

function canonicalDetailUrl(req: RouteRequest, publicHandle: string): string {
  const rawUrl = (req as RouteRequest & { url?: string }).url;
  const path =
    typeof rawUrl === "string" && rawUrl.startsWith("/") ? rawUrl : req.path;
  const separator = path.indexOf("?");
  const pathname = separator < 0 ? path : path.slice(0, separator);
  const query = new URLSearchParams(
    separator < 0 ? "" : path.slice(separator + 1),
  );
  query.delete("connection_id");
  query.delete("connector_instance_id");
  query.delete("instance_id");
  query.set("instance_id", publicHandle);
  const search = query.toString();
  return search ? `${pathname}?${search}` : pathname;
}

function pairwiseSelectorPrelude(
  ctx: MountRsReadContext,
  projectError: (error: unknown) => Error & { code: string; param?: string },
  markDeprecatedAlias = false,
): MiddlewareHandler {
  return (...args: unknown[]) => {
    const req = args[0] as RouteRequest;
    const res = args[1] as RouteResponse;
    const next = args[2];
    try {
      const handle = parsePairwiseReadSelectorSyntax(req.query ?? {});
      if (Object.hasOwn(req.query ?? {}, "connection_id")) {
        if (markDeprecatedAlias) req._pdpp_deprecated_instance_alias = true;
        const query = { ...req.query };
        delete query.connection_id;
        if (!Object.hasOwn(query, "instance_id")) query.instance_id = handle;
        (req as RouteRequest & { query: Readonly<Record<string, unknown>> }).query = query;
      }
    } catch (error) {
      return ctx.handleError(res, projectError(error));
    }
    return typeof next === "function" ? next() : undefined;
  };
}

async function ownerDetailSourceId(
  ctx: MountRsReadContext,
  req: RouteRequest,
): Promise<string | null> {
  const nativeManifest = ctx.resolveNativeManifest(ctx.opts);
  const nativeSource = nativeManifest?.source_declaration?.source;
  if (nativeManifest) {
    if (typeof nativeSource?.id !== "string" || !nativeSource.id) {
      throw Object.assign(new Error("Configured owner source is unavailable"), {
        code: "not_found",
      });
    }
    return nativeSource.id;
  }
  if (!Object.hasOwn(req.query, "connector_id")) return null;
  const rawConnectorId = req.query.connector_id;
  if (typeof rawConnectorId !== "string" || !rawConnectorId.trim()) {
    throw Object.assign(
      new Error("connector_id must be a single non-empty string"),
      {
        code: "invalid_request",
        param: "connector_id",
      },
    );
  }
  const connectorId =
    ctx.canonicalConnectorKey(rawConnectorId) ?? rawConnectorId;
  const manifest = await ctx.resolveRegisteredConnectorManifest(connectorId);
  const source = (
    manifest.source_declaration as
      | { source?: { id?: unknown } }
      | null
      | undefined
  )?.source;
  if (typeof source?.id !== "string" || !source.id) {
    throw Object.assign(new Error("Registered owner source is unavailable"), {
      code: "not_found",
    });
  }
  return source.id;
}

interface PairwiseSingleRecordContext {
  manifest: ManifestLike;
  ownerRead: boolean;
  ownerSubjectId: string;
  readMap: PairwiseReadMap;
  requestParams: Record<string, unknown>;
  selection: ReturnType<typeof parsePairwiseReadSelector>;
  sourceDescriptor: SourceDescriptorLike | null;
  storageBinding: StorageBindingLike;
  grant: GrantLike;
}

/** Resolve one public record selector through the authenticated pairwise boundary. */
async function preparePairwiseSingleRecordContext(
  ctx: MountRsReadContext,
  req: RouteRequest,
  tokenInfo: TokenInfo,
  queryContext: QueryContext,
  streamName: string,
): Promise<PairwiseSingleRecordContext> {
  const ownerRead = tokenInfo.pdpp_token_kind === "owner";
  const ownerSubjectId = ctx.ownerSubjectIdForBindings(tokenInfo);
  if (!ownerSubjectId) {
    throw Object.assign(new Error("Authenticated instance subject is unavailable"), {
      code: "grant_invalid",
    });
  }
  const ownerMap = ownerRead ? pairwiseOwnerReadMap(tokenInfo) : null;
  let readMap = ownerMap;
  let selection: ReturnType<typeof parsePairwiseReadSelector> | null = null;
  let scopeReq = req;

  if (ownerMap) {
    await ctx.validatePairwiseReadBindingOwnership({
      ownerSubjectId,
      bindings: ownerMap.bindings,
    });
    const sourceId = await ownerDetailSourceId(ctx, req);
    readMap = sourceId
      ? pairwiseOwnerReadMapForSource(ownerMap, sourceId)
      : ownerMap;
    selection = parsePairwiseReadSelector(req.query, readMap);
    const ownerScopeQuery = { ...(req.query as Record<string, unknown>) };
    delete ownerScopeQuery.instance_id;
    delete ownerScopeQuery.connection_id;
    delete ownerScopeQuery.connector_instance_id;
    ownerScopeQuery.connection_id = selection.internalId;
    scopeReq = { ...req, query: ownerScopeQuery };
  }

  const { storageBinding, manifest, sourceDescriptor } = await resolveReadScope(
    ctx,
    scopeReq,
    tokenInfo,
    queryContext,
  );

  if (!ownerMap) {
    readMap = pairwiseClientReadMap(
      tokenInfo,
      sourceDescriptor?.id ?? "",
      streamName,
    );
    await ctx.validatePairwiseReadBindingOwnership({
      ownerSubjectId,
      bindings: readMap.bindings,
    });
    selection = parsePairwiseReadSelector(req.query, readMap);
  }
  if (!readMap || !selection) {
    throw Object.assign(new Error("Record identity is unavailable"), {
      code: "grant_invalid",
    });
  }

  const requestParams = { ...(req.query as Record<string, unknown>) };
  delete requestParams.instance_id;
  delete requestParams.connection_id;
  delete requestParams.connector_instance_id;
  requestParams.connection_id = selection.internalId;
  const grant = ownerRead
    ? ctx.buildOwnerReadGrant(streamName)
    : (clientGrantForPairwiseDetail(
        (tokenInfo.grant ?? { streams: [] }) as unknown as Record<
          string,
          unknown
        >,
        streamName,
        selection.internalId,
      ) as GrantLike);
  return {
    grant,
    manifest,
    ownerRead,
    ownerSubjectId,
    readMap,
    requestParams,
    selection,
    sourceDescriptor,
    storageBinding,
  };
}

function sourceIdentityValue(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return null;
}

function withRecordSourceIdentity(
  record: unknown,
  refs: {
    sourceDescriptor: SourceDescriptorLike | null;
    storageBinding: StorageBindingLike | null;
  }
): unknown {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return record;
  }
  const connectorKey = sourceIdentityValue(refs.sourceDescriptor?.id, refs.storageBinding?.connector_id);
  return {
    ...(connectorKey ? { connector_key: connectorKey } : {}),
    ...(record as Record<string, unknown>),
  };
}

interface ReadScope {
  manifest: ManifestLike;
  sourceDescriptor: SourceDescriptorLike | null;
  storageBinding: StorageBindingLike;
}

// Map an operation's `*VisibilityError` to a `rejectQuery` response. The
// operation runs; if it throws a visibility error matching `errorType`, the
// route emits the canonical rejected-query response and the returned `rejected`
// flag tells the handler to stop. Any other error rethrows. Mirrors the inline
// `try { ... } catch (e) { if (e instanceof XVisibilityError) return rejectQuery(...) ; throw e }`.
async function runWithVisibilityRejection<T>(
  run: () => Promise<T>,
  errorType: new (...errArgs: never[]) => Error,
  reject: (err: Error & { code?: string }) => Promise<unknown>
): Promise<{ rejected: true } | { rejected: false; result: T }> {
  try {
    return { rejected: false, result: await run() };
  } catch (err) {
    if (err instanceof errorType) {
      const mapped = new Error((err as Error).message) as Error & { code?: string };
      // biome-ignore lint/style/useDestructuring: Explicit property or positional access documents this compatibility boundary.
      const code = (err as Error & { code?: string }).code;
      if (code !== undefined) {
        mapped.code = code;
      }
      await reject(mapped);
      return { rejected: true };
    }
    throw err;
  }
}

// Build the `stream_aggregate` `query.received` data block from the raw query
// params. Behaviour-identical to the inline literal.
function buildAggregateQueryEventData(requestParams: Record<string, unknown>): Record<string, unknown> {
  const stringOrNull = (value: unknown) => (typeof value === "string" ? value : null);
  return {
    field: stringOrNull(requestParams.field),
    granularity: stringOrNull(requestParams.granularity),
    group_by: stringOrNull(requestParams.group_by),
    group_by_time: stringOrNull(requestParams.group_by_time),
    limit: requestParams.limit ? Number(requestParams.limit) : null,
    metric: stringOrNull(requestParams.metric),
    query_shape: "stream_aggregate",
  };
}

// Integer query-param shape used by the field-window selector coercion. Hoisted
// to module scope so the route handler does not recompile it per request.
const INTEGER_PARAM_RE = /^-?\d+$/;

// Thrown by `coerceWindowSelectorParams` when a present numeric selector is not
// an integer. Carries the substrate's `invalid_window` code so the route maps
// it to the same HTTP 400 a malformed in-process call would produce.
class InvalidWindowParamError extends Error {
  code = "invalid_window";
  param: string;
  constructor(param: string) {
    super(`${param} must be an integer`);
    this.name = "InvalidWindowParamError";
    this.param = param;
  }
}

// Coerce the field-window numeric selectors (`offset_chars`, `limit_chars`) from
// HTTP query strings to integers in place. Absent/empty values are dropped so
// the substrate applies its defaults; a present non-integer is a typed
// `invalid_window` error. Keeping this at module scope (rather than inline in
// the handler) hoists the regex and keeps the handler's complexity bounded.
function coerceWindowSelectorParams(requestParams: Record<string, unknown>): void {
  for (const key of ["offset_chars", "limit_chars", "before_chars", "after_chars"]) {
    const raw = requestParams[key];
    if (raw === undefined || raw === null || raw === "") {
      delete requestParams[key];
      continue;
    }
    const text = String(raw).trim();
    if (!INTEGER_PARAM_RE.test(text)) {
      throw new InvalidWindowParamError(key);
    }
    requestParams[key] = Number.parseInt(text, 10);
  }
}

async function rejectInvalidWindowParams(
  ctx: MountRsReadContext,
  res: RouteResponse,
  req: RouteRequest,
  queryContext: QueryContext,
  requestParams: Record<string, unknown>,
  errorProjector: (err: unknown) => unknown = (err) => err,
): Promise<boolean> {
  try {
    coerceWindowSelectorParams(requestParams);
    return false;
  } catch (err) {
    if (err instanceof InvalidWindowParamError) {
      await ctx.rejectQuery(
        res,
        req,
        queryContext,
        errorProjector(err),
      );
      return true;
    }
    throw err;
  }
}

// Owner/client source + manifest + storage-binding resolution shared by the
// stream-detail, aggregate, records-list, record-detail, and blob-read routes.
// Sets `queryContext.sourceDescriptor` as a side effect (matching the inline
// handlers, which set it before any manifest work so malformed-connector
// failures stay attributable in `query.received` / `query.rejected`) and
// returns the resolved trio. Behaviour-identical to the previous inline
// branches.
async function resolveReadScope(
  ctx: MountRsReadContext,
  req: RouteRequest,
  tokenInfo: TokenInfo,
  queryContext: QueryContext
): Promise<ReadScope> {
  if (tokenInfo.pdpp_token_kind === "owner") {
    const ownerScope = await ctx.resolveOwnerReadScope(req, ctx.opts);
    const sourceDescriptor = ctx.buildSourceDescriptor(ownerScope.source);
    queryContext.sourceDescriptor = sourceDescriptor;
    const ownerResolved = await ctx.resolveOwnerManifestFromScope(ownerScope, ctx.opts);
    return { manifest: ownerResolved.manifest, sourceDescriptor, storageBinding: ownerResolved.storageBinding };
  }
  const grantResolved = await ctx.resolveGrantManifest(tokenInfo, ctx.opts);
  queryContext.sourceDescriptor = grantResolved.source;
  return {
    manifest: grantResolved.manifest,
    sourceDescriptor: grantResolved.source,
    storageBinding: grantResolved.storageBinding,
  };
}

// Shared `disclosure.served` spine emission. Owns the common event scaffold
// (actor / subject / object / token coordinates) so each route handler only
// supplies the per-query fields. Behaviour-identical to the inline
// `ctx.emitSpineEvent({ event_type: "disclosure.served", ... })` calls.
function emitDisclosureServed(
  ctx: MountRsReadContext,
  args: {
    req: RouteRequest;
    tokenInfo: TokenInfo;
    actorType: string;
    actorId: string | null;
    traceId: string | null;
    scenarioId: string | null;
    queryId: string;
    streamId?: string | null;
    data: Record<string, unknown>;
  }
): Promise<unknown> {
  const { tokenInfo } = args;
  const event: Record<string, unknown> = {
    actor_id: args.actorId,
    actor_type: args.actorType,
    client_id: tokenInfo.client_id || null,
    data: args.data,
    event_type: "disclosure.served",
    grant_id: tokenInfo.grant_id || null,
    object_id: args.queryId,
    object_type: "query",
    scenario_id: args.scenarioId,
    status: "succeeded",
    subject_id: tokenInfo.subject_id || null,
    subject_type: "subject",
    token_id: authorizationTokenId(args.req),
    trace_id: args.traceId,
  };
  if (args.streamId !== undefined) {
    event.stream_id = args.streamId;
  }
  return ctx.emitSpineEvent(event);
}

// Fold resolver-level warnings into a list body's `meta.warnings[]`, preserving
// any pre-existing meta/warnings. Behaviour-identical to the inline merge the
// `/v1/streams` handler used.
function mergeResolverWarningsIntoBody(body: Record<string, unknown>, resolverWarnings: unknown): void {
  if (!(Array.isArray(resolverWarnings) && resolverWarnings.length)) {
    return;
  }
  const existingMeta =
    body.meta && typeof body.meta === "object" && !Array.isArray(body.meta)
      ? (body.meta as Record<string, unknown>)
      : null;
  const existingWarnings = existingMeta && Array.isArray(existingMeta.warnings) ? existingMeta.warnings : [];
  body.meta = {
    ...(existingMeta || {}),
    warnings: [...existingWarnings, ...resolverWarnings],
  };
}

const FIELD_WINDOW_KEYS = [
  "complete",
  "end_chars",
  "has_more",
  "limit_chars",
  "match_end_chars",
  "match_start_chars",
  "next_offset_chars",
  "previous_offset_chars",
  "start_chars",
  "text",
  "total_chars",
] as const;

function projectPairwiseFieldWindowResult(
  value: unknown,
  requestedRecordId: string,
  fieldPath: string,
): { fieldType: string; window: Record<string, unknown>; warnings: unknown } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw Object.assign(new Error("Field-window result is invalid"), {
      code: "grant_invalid",
    });
  }
  const result = value as Record<string, unknown>;
  const rawWindow = result.window;
  if (
    result.record_key !== requestedRecordId ||
    result.field_path !== fieldPath ||
    result.field_type !== "string" ||
    !rawWindow ||
    typeof rawWindow !== "object" ||
    Array.isArray(rawWindow)
  ) {
    throw Object.assign(new Error("Field-window result does not match its request"), {
      code: "grant_invalid",
    });
  }
  const source = rawWindow as Record<string, unknown>;
  const integer = (candidate: unknown, positive = false) =>
    typeof candidate === "number" &&
    Number.isInteger(candidate) &&
    (positive ? candidate > 0 : candidate >= 0);
  const nullableInteger = (candidate: unknown) =>
    candidate === null || integer(candidate);
  if (
    Object.keys(source).some((key) => !FIELD_WINDOW_KEYS.includes(key as (typeof FIELD_WINDOW_KEYS)[number])) ||
    FIELD_WINDOW_KEYS.some((key) => !Object.hasOwn(source, key)) ||
    typeof source.complete !== "boolean" ||
    !integer(source.end_chars) ||
    typeof source.has_more !== "boolean" ||
    !integer(source.limit_chars, true) ||
    !nullableInteger(source.match_end_chars) ||
    !nullableInteger(source.match_start_chars) ||
    !nullableInteger(source.next_offset_chars) ||
    !nullableInteger(source.previous_offset_chars) ||
    !integer(source.start_chars) ||
    typeof source.text !== "string" ||
    !integer(source.total_chars)
  ) {
    throw Object.assign(new Error("Field-window result shape is invalid"), {
      code: "grant_invalid",
    });
  }
  const window = Object.fromEntries(
    FIELD_WINDOW_KEYS.map((key) => [key, source[key]]),
  );
  return { fieldType: result.field_type, warnings: result.warnings, window };
}

// The owner/client actor block shared by the record-reading routes.
function buildReadActor(tokenInfo: TokenInfo): Record<string, unknown> {
  return tokenInfo.pdpp_token_kind === "owner"
    ? { kind: "owner", subject_id: tokenInfo.subject_id || null }
    : {
        client_id: tokenInfo.client_id || null,
        grant_id: tokenInfo.grant_id || null,
        kind: "client",
        subject_id: tokenInfo.subject_id || null,
      };
}

// GET /v1/connectors — bearer-scoped connector/source discovery
export function mountRsConnectors(app: AppLike, ctx: MountRsReadContext): void {
  app.get(
    "/v1/connectors",
    { contract: "listConnectors" },
    ctx.requireToken,
    ctx.requireCoreEndpointToken,
    async (req: RouteRequest, res: RouteResponse) => {
      let queryContext: QueryContext | null = null;
      try {
        const { tokenInfo } = req;
        const queryId = ctx.ensureRequestId(res);
        const { actorType, actorId, traceId, scenarioId } = ctx.buildQueryActorContext(tokenInfo);
        ctx.setReferenceTraceId(res, traceId);

        queryContext = {
          actorId,
          actorType,
          queryData: { query_shape: "connector_list" },
          queryId,
          scenarioId,
          sourceDescriptor:
            tokenInfo.pdpp_token_kind === "owner"
              ? ctx.buildOwnerQuerySourceDescriptor(req, ctx.opts)
              : ctx.buildClientSourceDescriptor(tokenInfo),
          tokenInfo,
          traceId,
        };

        let operationInput: Record<string, unknown>;
        let dependencies: Record<string, unknown>;
        if (tokenInfo.pdpp_token_kind === "owner") {
          operationInput = {
            actor: { kind: "owner", subject_id: tokenInfo.subject_id || null },
          };
          const nativeManifest = ctx.resolveNativeManifest(ctx.opts);
          const nativeStorageBinding = ctx.resolveNativeStorageBinding(ctx.opts);
          if (nativeManifest && nativeStorageBinding) {
            const source = ctx.buildSourceDescriptor(nativeManifest.source_declaration?.source);
            queryContext.sourceDescriptor = source;
            dependencies = {
              getSourceDescriptor: () => source,
              listConnectorItems: async () => {
                const item = await ctx.buildConnectorDiscoveryItem({
                  manifest: nativeManifest,
                  ownerSubjectId: ctx.ownerSubjectIdForBindings(tokenInfo),
                  source,
                  storageBinding: nativeStorageBinding,
                });
                return [item];
              },
            };
          } else {
            // Multiple registered connectors: no single source descriptor; the
            // disclosure event has historically emitted `source: null` for this
            // branch. The operation propagates `null` through verbatim.
            dependencies = {
              getSourceDescriptor: () => null,
              listConnectorItems: async () => {
                const connectorIds = await ctx.listRegisteredConnectorIds();
                return Promise.all(
                  connectorIds.map(async (connectorId) => {
                    const manifest = await ctx.resolveRegisteredConnectorManifest(connectorId);
                    return ctx.buildConnectorDiscoveryItem({
                      manifest,
                      ownerSubjectId: ctx.ownerSubjectIdForBindings(tokenInfo),
                      source: ctx.buildSourceDescriptor({ id: connectorId, kind: "connector" }),
                      storageBinding: { connector_id: connectorId },
                    });
                  })
                );
              },
            };
          }
        } else {
          operationInput = {
            actor: {
              client_id: tokenInfo.client_id || null,
              grant_id: tokenInfo.grant_id || null,
              kind: "client",
              subject_id: tokenInfo.subject_id || null,
            },
          };
          // Eagerly resolve the grant so the rejected-query path has the
          // correct source descriptor even if connector-item assembly throws.
          const grantResolved = await ctx.resolveGrantManifest(tokenInfo, ctx.opts);
          // biome-ignore lint/style/useDestructuring: Explicit property or positional access documents this compatibility boundary.
          const source = grantResolved.source;
          queryContext.sourceDescriptor = source;
          dependencies = {
            getSourceDescriptor: () => source,
            listConnectorItems: async () => {
              const item = await ctx.buildConnectorDiscoveryItem({
                grant: tokenInfo.grant,
                manifest: grantResolved.manifest,
                ownerSubjectId: ctx.ownerSubjectIdForBindings(tokenInfo),
                source,
                storageBinding: grantResolved.storageBinding,
              });
              return [item];
            },
          };
        }

        const result = await executeConnectorsList(
          operationInput as unknown as ConnectorsListInput,
          dependencies as unknown as ConnectorsListDependencies
        );

        await ctx.emitQueryReceived(queryContext, req);

        await emitDisclosureServed(ctx, {
          actorId,
          actorType,
          data: {
            connector_count: result.disclosureTotals.connector_count,
            query_shape: "connector_list",
            source: result.sourceDescriptor,
            stream_count: result.disclosureTotals.stream_count,
          },
          queryId,
          req,
          scenarioId,
          tokenInfo,
          traceId,
        });

        return res.json(result.envelope);
      } catch (err) {
        if (queryContext) {
          await ctx.emitQueryReceived(queryContext, req);
          return await ctx.rejectQuery(res, req, queryContext, err);
        }
        return ctx.handleError(res, err);
      }
    }
  );
}

// Read the `view` selector off the schema query. `qs.parse` may produce a
// string, an array (repeated params), or an object (bracketed params); only a
// plain string is meaningful here, and it is compared case-insensitively after
// trimming. Anything else is treated as "no view" so the full body is served.
function readSchemaView(query: Readonly<Record<string, unknown>>): string | null {
  // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
  const raw = query?.view;
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

// Explicit detail selector for agent-facing schema discovery. The legacy REST
// default remains full/current-compatible when this selector is omitted.
function readSchemaDetail(query: Readonly<Record<string, unknown>>): string | null {
  // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
  const raw = query?.detail;
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

// Read the optional `stream` scope off the schema query. Only a non-empty
// plain string narrows the document; any other shape leaves the document
// unscoped.
function readSchemaStreamScope(query: Readonly<Record<string, unknown>>): string | null {
  // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
  const raw = query?.stream;
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// Read the optional canonical source scope off the schema query. This mirrors
// the public read selector used by records/search without accepting the
// deprecated alias on this discovery path.
function readSchemaConnectionScope(query: Readonly<Record<string, unknown>>): string | null {
  // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
  const raw = query?.connection_id;
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

interface SchemaGetPlan {
  dependencies: Record<string, unknown>;
  operationInput: Record<string, unknown>;
}

// Owner branch: native single-connector binding when present, else fan out over
// every registered connector with a null source descriptor (the historical
// shape). Mutates `queryContext.sourceDescriptor` for the native case.
function buildOwnerSchemaGetPlan(
  ctx: MountRsReadContext,
  tokenInfo: TokenInfo,
  queryContext: QueryContext
): SchemaGetPlan {
  const operationInput = {
    actor: { kind: "owner", subject_id: tokenInfo.subject_id || null },
  };
  const ownerSubjectId = ctx.ownerSubjectIdForBindings(tokenInfo);
  const nativeManifest = ctx.resolveNativeManifest(ctx.opts);
  const nativeStorageBinding = ctx.resolveNativeStorageBinding(ctx.opts);
  if (nativeManifest && nativeStorageBinding) {
    const source = ctx.buildSourceDescriptor(nativeManifest.source_declaration?.source);
    queryContext.sourceDescriptor = source;
    return {
      dependencies: {
        getSourceDescriptor: () => source,
        listConnectorItems: async () => [
          await ctx.buildConnectorSchemaItem({
            manifest: nativeManifest,
            ownerSubjectId,
            source,
            storageBinding: nativeStorageBinding,
          }),
        ],
      },
      operationInput,
    };
  }
  // Multiple registered connectors: no single source descriptor, the disclosure
  // event has historically emitted `source: null` for this branch. Operation
  // propagates `null` through verbatim.
  return {
    dependencies: {
      getSourceDescriptor: () => null,
      listConnectorItems: async () => {
        const connectorIds = await ctx.listRegisteredConnectorIds();
        return Promise.all(
          connectorIds.map(async (connectorId) => {
            const manifest = await ctx.resolveRegisteredConnectorManifest(connectorId);
            return ctx.buildConnectorSchemaItem({
              manifest,
              ownerSubjectId,
              source: ctx.buildSourceDescriptor({ id: connectorId, kind: "connector" }),
              storageBinding: { connector_id: connectorId },
            });
          })
        );
      },
    },
    operationInput,
  };
}

// Client branch: resolve the grant eagerly so the rejected-query path has the
// correct source descriptor even if connector-item assembly throws. Mutates
// `queryContext.sourceDescriptor`.
async function buildClientSchemaGetPlan(
  ctx: MountRsReadContext,
  tokenInfo: TokenInfo,
  queryContext: QueryContext
): Promise<SchemaGetPlan> {
  const operationInput = {
    actor: {
      client_id: tokenInfo.client_id || null,
      grant_id: tokenInfo.grant_id || null,
      kind: "client",
      subject_id: tokenInfo.subject_id || null,
    },
  };
  const grantResolved = await ctx.resolveGrantManifest(tokenInfo, ctx.opts);
  // biome-ignore lint/style/useDestructuring: Explicit property or positional access documents this compatibility boundary.
  const source = grantResolved.source;
  queryContext.sourceDescriptor = source;
  const ownerSubjectId = ctx.ownerSubjectIdForBindings(tokenInfo);
  return {
    dependencies: {
      getSourceDescriptor: () => source,
      listConnectorItems: async () => [
        await ctx.buildConnectorSchemaItem({
          grant: tokenInfo.grant,
          manifest: grantResolved.manifest,
          ownerSubjectId,
          source,
          storageBinding: grantResolved.storageBinding,
        }),
      ],
    },
    operationInput,
  };
}

function buildSchemaGetPlan(
  ctx: MountRsReadContext,
  tokenInfo: TokenInfo,
  queryContext: QueryContext
): Promise<SchemaGetPlan> {
  return tokenInfo.pdpp_token_kind === "owner"
    ? Promise.resolve(buildOwnerSchemaGetPlan(ctx, tokenInfo, queryContext))
    : buildClientSchemaGetPlan(ctx, tokenInfo, queryContext);
}

// Derive the connector/stream counts that match the body actually served. When
// the compact view scopes to a stream (or omits connectors), the served counts
// differ from the operation's full-body counts; this recomputes them from the
// served body and falls back to the operation counts for a non-list shape.
function deriveServedSchemaCounts(
  responseBody: { connectors?: unknown },
  fallback: { connector_count: number; stream_count: number }
): { connector_count: number; stream_count: number } {
  // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
  const connectors = responseBody?.connectors;
  if (!Array.isArray(connectors)) {
    return fallback;
  }
  const stream_count = connectors.reduce((sum: number, connector) => {
    // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
    const streams = (connector as { streams?: unknown })?.streams;
    return sum + (Array.isArray(streams) ? streams.length : 0);
  }, 0);
  return { connector_count: connectors.length, stream_count };
}

// Returns a structured error if `detail=full` constraints are violated, null otherwise.
function buildFullDetailConstraintError(
  explicitFullDetail: boolean,
  streamScope: string | null,
  connectionScope: string | null,
  schemaResponse: unknown
): (Error & { code?: string; param?: string; retry_with?: string; available_connections?: unknown[] }) | null {
  if (!explicitFullDetail) {
    return null;
  }
  if (!streamScope) {
    const err = new Error(
      'schema detail "full" requires `stream`; call /v1/schema?view=compact for global discovery, then /v1/schema?stream=<name>&connection_id=<cin>&detail=full for exhaustive detail.'
    ) as Error & { code?: string; param?: string };
    err.code = "invalid_request";
    err.param = "detail";
    return err;
  }
  if (!connectionScope) {
    const sources = schemaSourceOptions(schemaResponse as Parameters<typeof schemaSourceOptions>[0], {
      stream: streamScope,
    });
    if (sources.length > 1) {
      const err = new Error(
        `schema detail "full" for stream "${streamScope}" matches ${sources.length} sources; retry with connection_id to fetch one source's exhaustive schema.`
      ) as Error & {
        code?: string;
        param?: string;
        retry_with?: string;
        available_connections?: unknown[];
      };
      err.code = "ambiguous_schema_detail";
      err.param = "connection_id";
      err.retry_with = "connection_id";
      err.available_connections = sources;
      return err;
    }
  }
  return null;
}

// Request-shaping selectors read off the `/v1/schema` query string. Grouped so
// the route handler resolves them in one call and stays under the complexity bar.
interface SchemaRequestSelectors {
  compactView: boolean;
  connectionScope: string | null;
  explicitFullDetail: boolean;
  streamScope: string | null;
}

// Pure: the additive `query_shape: "schema"` telemetry body for the request.
// Only present selectors are attached, mirroring the prior inline spreads.
function buildSchemaQueryData(selectors: SchemaRequestSelectors): Record<string, unknown> {
  const { compactView, explicitFullDetail, streamScope, connectionScope } = selectors;
  return {
    query_shape: "schema",
    ...(compactView ? { requested_view: "compact" } : {}),
    ...(explicitFullDetail ? { requested_detail: "full" } : {}),
    ...(streamScope ? { requested_stream: streamScope } : {}),
    ...(connectionScope ? { requested_connection_id: connectionScope } : {}),
  };
}

// GET /v1/schema — one-shot capability/schema discovery for the bearer
export function mountRsSchema(app: AppLike, ctx: MountRsReadContext): void {
  app.get("/v1/schema", { contract: "getSchema" }, ctx.requireToken, ctx.requireCoreEndpointToken, async (req: RouteRequest, res: RouteResponse) => {
    let queryContext: QueryContext | null = null;
    try {
      const { tokenInfo } = req;
      const queryId = ctx.ensureRequestId(res);
      const { actorType, actorId, traceId, scenarioId } = ctx.buildQueryActorContext(tokenInfo);
      ctx.setReferenceTraceId(res, traceId);

      // `view=compact` selects the additive, token-efficient schema projection;
      // any other (or omitted) `view` preserves the current full body. `stream`
      // narrows the document to one stream for the cheap `schema(stream)`
      // discovery middle step. `connection_id` narrows common stream names to
      // one configured source. These are read-only request shaping selectors:
      // they never change visibility, only the rendered detail level / scope.
      const compactView = readSchemaView(req.query) === "compact";
      const explicitFullDetail = !compactView && readSchemaDetail(req.query) === "full";
      const streamScope = readSchemaStreamScope(req.query);
      const connectionScope = readSchemaConnectionScope(req.query);
      const selectors: SchemaRequestSelectors = { compactView, connectionScope, explicitFullDetail, streamScope };

      queryContext = {
        actorId,
        actorType,
        queryData: buildSchemaQueryData(selectors),
        queryId,
        scenarioId,
        sourceDescriptor:
          tokenInfo.pdpp_token_kind === "owner"
            ? ctx.buildOwnerQuerySourceDescriptor(req, ctx.opts)
            : ctx.buildClientSourceDescriptor(tokenInfo),
        tokenInfo,
        traceId,
      };

      // Build the actor input + connector-item dependencies for this bearer.
      // Mutates `queryContext.sourceDescriptor` to the resolved source (mirrors
      // the inline behavior the route previously had and the `resolveReadScope`
      // convention used by the records routes).
      const { operationInput, dependencies } = await buildSchemaGetPlan(ctx, tokenInfo, queryContext);

      const result = await executeSchemaGet(
        operationInput as unknown as SchemaGetInput,
        dependencies as unknown as SchemaGetDependencies
      );

      const fullDetailErr = buildFullDetailConstraintError(
        explicitFullDetail,
        streamScope,
        connectionScope,
        result.response
      );
      if (fullDetailErr) {
        await ctx.emitQueryReceived(queryContext, req);
        return await ctx.rejectQuery(res, req, queryContext, fullDetailErr);
      }

      // Apply the compact projection (and optional stream scope) as a pure,
      // post-operation transform. The operation owns visibility/grant scope and
      // emits the full body; the route only down-projects the rendered detail.
      const responseBody = compactView
        ? projectSchemaCompactView(result.response, { connectionId: connectionScope, stream: streamScope })
        : projectSchemaStreamScope(result.response, { connectionId: connectionScope, stream: streamScope });
      const servedCounts = deriveServedSchemaCounts(responseBody, result.counts);

      await ctx.emitQueryReceived(queryContext, req);

      await emitDisclosureServed(ctx, {
        actorId,
        actorType,
        data: {
          connector_count: servedCounts.connector_count,
          query_shape: "schema",
          source: result.sourceDescriptor,
          stream_count: servedCounts.stream_count,
          ...(compactView ? { requested_view: "compact" } : {}),
          ...(streamScope ? { requested_stream: streamScope } : {}),
          ...(connectionScope ? { requested_connection_id: connectionScope } : {}),
        },
        queryId,
        req,
        scenarioId,
        tokenInfo,
        traceId,
      });

      return res.json(ctx.finalizeCanonicalEnvelope(responseBody, req));
    } catch (err) {
      if (queryContext) {
        await ctx.emitQueryReceived(queryContext, req);
        return await ctx.rejectQuery(res, req, queryContext, err);
      }
      return ctx.handleError(res, err);
    }
  });
}

// The owner/client branch of `/v1/streams` builds the operation input and
// dependencies; extracted to module-level helpers so the route handler stays
// under the cognitive-complexity bar.
interface StreamsListPlan {
  dependencies: Record<string, unknown>;
  operationInput: Record<string, unknown>;
  streamListFreshnessEvidence: unknown;
}

function hasExplicitOwnerConnectorScope(query: Readonly<Record<string, unknown>>): boolean {
  // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
  return Object.hasOwn(query || {}, "connector_id");
}

function buildOwnerReadGrantForManifest(manifest: ManifestLike): GrantLike {
  return {
    // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
    streams: (manifest?.streams || [])
      .map((stream) => (typeof stream?.name === "string" && stream.name ? { name: stream.name } : null))
      .filter(Boolean) as GrantStreamLike[],
  };
}

function buildPolyfillOwnerScope(ctx: MountRsReadContext, req: RouteRequest, connectorId: string): OwnerScopeLike {
  const connectorKey = ctx.canonicalConnectorKey(connectorId) ?? connectorId;
  return {
    owner_subject_id: ctx.getOwnerTokenSubjectId(req),
    public_scope: "polyfill",
    source: { id: connectorKey, kind: "connector" },
    storage_binding: { connector_id: connectorKey },
  };
}

async function listOwnerStreamsForConnector(
  ctx: MountRsReadContext,
  req: RouteRequest,
  connectorId: string
): Promise<Record<string, unknown>[]> {
  const requestParams = (req.query as Record<string, unknown>) || {};
  const ownerSubjectId = ctx.getOwnerTokenSubjectId(req);
  const ownerScope = buildPolyfillOwnerScope(ctx, req, connectorId);
  const ownerResolved = await ctx.resolveOwnerManifestFromScope(ownerScope, ctx.opts);
  const source = ctx.buildSourceDescriptor(ownerScope.source);
  const grant = buildOwnerReadGrantForManifest(ownerResolved.manifest);
  const firstStream = Array.isArray(grant.streams) ? grant.streams[0]?.name : null;
  const { bindings, warnings: resolverWarnings } = await ctx.resolveReadRequestBindings({
    grant,
    ownerRead: true,
    ownerSubjectId,
    requestParams,
    storageBinding: ownerResolved.storageBinding,
    streamName: firstStream ?? null,
  });
  req._pdpp_resolver_warnings = [...(req._pdpp_resolver_warnings || []), ...(resolverWarnings || [])];
  const summaries = await ctx.listStreamsAcrossBindings(bindings, grant, ownerResolved.manifest, {
    resolveBindingsForStream: async (streamGrant: GrantStreamLike) => {
      const { bindings: streamBindings } = await ctx.resolveReadRequestBindings({
        grant,
        ownerRead: true,
        ownerSubjectId,
        requestParams,
        storageBinding: ownerResolved.storageBinding,
        // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
        streamName: streamGrant?.name || null,
      });
      return streamBindings;
    },
  });
  return summaries.map((summary) => ({
    ...summary,
    connector_id: connectorId,
    source,
  }));
}

async function listExplicitPolyfillOwnerStreams(
  ctx: MountRsReadContext,
  req: RouteRequest,
  ownerResolved: ResolvedManifest
): Promise<Record<string, unknown>[]> {
  const requestParams = (req.query as Record<string, unknown>) || {};
  const ownerSubjectId = ctx.getOwnerTokenSubjectId(req);
  const grant = buildOwnerReadGrantForManifest(ownerResolved.manifest);
  const firstStream = Array.isArray(grant.streams) ? grant.streams[0]?.name : null;
  const { bindings, warnings: resolverWarnings } = await ctx.resolveReadRequestBindings({
    grant,
    ownerRead: true,
    ownerSubjectId,
    requestParams,
    storageBinding: ownerResolved.storageBinding,
    streamName: firstStream ?? null,
  });
  req._pdpp_resolver_warnings = [...(req._pdpp_resolver_warnings || []), ...(resolverWarnings || [])];
  return await ctx.listStreamsAcrossBindings(bindings, grant, ownerResolved.manifest, {
    resolveBindingsForStream: async (streamGrant: GrantStreamLike) => {
      const { bindings: streamBindings } = await ctx.resolveReadRequestBindings({
        grant,
        ownerRead: true,
        ownerSubjectId,
        requestParams,
        storageBinding: ownerResolved.storageBinding,
        // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
        streamName: streamGrant?.name || null,
      });
      return streamBindings;
    },
  });
}

async function listOwnerStreamsAcrossRegisteredConnectors(
  ctx: MountRsReadContext,
  req: RouteRequest
): Promise<Record<string, unknown>[]> {
  const connectorIds = await ctx.listRegisteredConnectorIds();
  const requestedConnectionId = resolveRequestConnectionId(req.query);
  const skippedConnectionErrors: Error[] = [];
  const streamsByConnector = await Promise.all(
    connectorIds.map(async (connectorId) => {
      try {
        return await listOwnerStreamsForConnector(ctx, req, connectorId);
      } catch (err) {
        if (err instanceof Error && (err as Error & { code?: string }).code === "connection_not_found") {
          skippedConnectionErrors.push(err);
          return [];
        }
        throw err;
      }
    })
  );
  if (
    requestedConnectionId &&
    skippedConnectionErrors.length > 0 &&
    skippedConnectionErrors.length === connectorIds.length
  ) {
    throw skippedConnectionErrors[0];
  }
  return streamsByConnector.flat();
}

async function buildStreamsListOwnerPlan(
  ctx: MountRsReadContext,
  req: RouteRequest,
  queryContext: QueryContext,
  tokenInfo: TokenInfo
): Promise<StreamsListPlan> {
  const nativeManifest = ctx.resolveNativeManifest(ctx.opts);
  const nativeStorageBinding = ctx.resolveNativeStorageBinding(ctx.opts);
  if (!((nativeManifest && nativeStorageBinding) || hasExplicitOwnerConnectorScope(req.query))) {
    queryContext.sourceDescriptor = null;
    return {
      dependencies: {
        getSourceDescriptor: () => null,
        listSummaries: async () => listOwnerStreamsAcrossRegisteredConnectors(ctx, req),
      },
      operationInput: {
        actor: { kind: "owner", subject_id: tokenInfo.subject_id || null },
        connection_id: resolveRequestConnectionId(req.query),
      },
      streamListFreshnessEvidence: null,
    };
  }

  const ownerScope = await ctx.resolveOwnerReadScope(req, ctx.opts);
  // Set source before manifest resolution so malformed connector failures
  // remain attributable in query.received/query.rejected.
  queryContext.sourceDescriptor = ctx.buildSourceDescriptor(ownerScope.source);
  const ownerResolved = await ctx.resolveOwnerManifest(req, ctx.opts);
  const streamListFreshnessEvidence = await ctx.getConnectorFreshnessEvidence({
    manifest: ownerResolved.manifest,
    storageBinding: ownerResolved.storageBinding,
  });
  return {
    dependencies: {
      getSourceDescriptor: () => queryContext.sourceDescriptor,
      listSummaries: () => listExplicitPolyfillOwnerStreams(ctx, req, ownerResolved),
    },
    operationInput: {
      actor: { kind: "owner", subject_id: tokenInfo.subject_id || null },
      connection_id: resolveRequestConnectionId(req.query),
    },
    streamListFreshnessEvidence,
  };
}

async function buildStreamsListClientPlan(
  ctx: MountRsReadContext,
  req: RouteRequest,
  queryContext: QueryContext,
  tokenInfo: TokenInfo
): Promise<StreamsListPlan> {
  // biome-ignore lint/style/useDestructuring: Explicit property or positional access documents this compatibility boundary.
  const grant = tokenInfo.grant;
  const grantResolved = await ctx.resolveGrantManifest(tokenInfo, ctx.opts);
  const streamListFreshnessEvidence = await ctx.getConnectorFreshnessEvidence({
    manifest: grantResolved.manifest,
    storageBinding: grantResolved.storageBinding,
  });
  const streamCountLimit = Array.isArray(grant?.streams) ? grant.streams.length : null;
  queryContext.sourceDescriptor = grantResolved.source;
  queryContext.queryData.stream_count_limit = streamCountLimit;
  const ownerSubjectId = ctx.ownerSubjectIdForBindings(tokenInfo);
  const requestParams = (req.query as Record<string, unknown>) || {};
  return {
    dependencies: {
      getSourceDescriptor: () => queryContext.sourceDescriptor,
      listSummaries: async () => {
        // The grant's closed instance_ids are the fan-in upper bound. A
        // request-time connection_id may only narrow that set. Resolve each
        // stream independently because its authorized instance set may differ.
        const { bindings, warnings: resolverWarnings } = await ctx.resolveReadRequestBindings({
          grant: grant ?? null,
          ownerRead: tokenInfo.pdpp_token_kind === "owner",
          ownerSubjectId,
          requestParams,
          storageBinding: grantResolved.storageBinding,
          streamName: null,
        });
        // Stash resolver warnings on the request scope so the route body can
        // thread them into `meta.warnings` (P3 fix).
        req._pdpp_resolver_warnings = resolverWarnings;
        return await ctx.listStreamsAcrossBindings(bindings, grant ?? null, grantResolved.manifest, {
          resolveBindingsForStream: (streamGrant: GrantStreamLike) =>
            resolveClientStreamListBindingsOrEmpty(() =>
              ctx.resolveReadRequestBindings({
                grant: grant ?? null,
                ownerRead: tokenInfo.pdpp_token_kind === "owner",
                ownerSubjectId,
                requestParams,
                storageBinding: grantResolved.storageBinding,
                // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
                streamName: streamGrant?.name || null,
              })
            ),
        });
      },
    },
    operationInput: {
      actor: {
        client_id: tokenInfo.client_id || null,
        grant_id: tokenInfo.grant_id || null,
        kind: "client",
        stream_count_limit: streamCountLimit,
        subject_id: tokenInfo.subject_id || null,
      },
      connection_id: resolveRequestConnectionId(req.query),
    },
    streamListFreshnessEvidence,
  };
}

export async function resolveClientStreamListBindingsOrEmpty(
  resolve: () => Promise<{ bindings: ReadRequestBinding[] }>
): Promise<ReadRequestBinding[]> {
  try {
    return (await resolve()).bindings;
  } catch (error) {
    if (error instanceof Error && (error as Error & { code?: string }).code === "connection_not_found") {
      return [];
    }
    throw error;
  }
}

// GET /v1/streams — list streams (client or owner)
export function mountRsStreamsList(app: AppLike, ctx: MountRsReadContext): void {
  app.get(
    "/v1/streams",
    { contract: "listStreams" },
    ctx.requireToken,
    ctx.requireCoreEndpointToken,
    async (req: RouteRequest, res: RouteResponse) => {
      let queryContext: QueryContext | null = null;
      try {
        const { tokenInfo } = req;
        const queryId = ctx.ensureRequestId(res);
        const { actorType, actorId, traceId, scenarioId } = ctx.buildQueryActorContext(tokenInfo);
        ctx.setReferenceTraceId(res, traceId);

        queryContext = {
          actorId,
          actorType,
          queryData: { query_shape: "stream_list" },
          queryId,
          scenarioId,
          sourceDescriptor:
            tokenInfo.pdpp_token_kind === "owner"
              ? ctx.buildOwnerQuerySourceDescriptor(req, ctx.opts)
              : ctx.buildClientSourceDescriptor(tokenInfo),
          tokenInfo,
          traceId,
        };

        const plan =
          tokenInfo.pdpp_token_kind === "owner"
            ? await buildStreamsListOwnerPlan(ctx, req, queryContext, tokenInfo)
            : await buildStreamsListClientPlan(ctx, req, queryContext, tokenInfo);
        const { operationInput, dependencies, streamListFreshnessEvidence } = plan;

        const result = await executeStreamsList(
          operationInput as unknown as StreamsListInput,
          dependencies as unknown as StreamsListDependencies
        );

        await ctx.emitQueryReceived(queryContext, req);

        await emitDisclosureServed(ctx, {
          actorId,
          actorType,
          data: {
            query_shape: "stream_list",
            source: result.sourceDescriptor,
            stream_count: result.streams.length,
          },
          queryId,
          req,
          scenarioId,
          tokenInfo,
          traceId,
        });

        const streamsListBody: Record<string, unknown> = {
          data: result.streams.map((summary) => ({
            ...summary,
            freshness: ctx.buildConnectorAwareFreshness(
              streamListFreshnessEvidence,
              ((summary as unknown as Record<string, unknown>).last_updated as string | null) || null
            ),
          })),
          has_more: false,
          object: "list",
        };
        mergeResolverWarningsIntoBody(streamsListBody, req._pdpp_resolver_warnings);
        return res.json(ctx.finalizeCanonicalEnvelope(streamsListBody, req));
      } catch (err) {
        if (queryContext) {
          await ctx.emitQueryReceived(queryContext, req);
          return await ctx.rejectQuery(res, req, queryContext, err);
        }
        return ctx.handleError(res, err);
      }
    }
  );
}

// GET /v1/streams/:stream — stream metadata
export function mountRsStreamDetail(app: AppLike, ctx: MountRsReadContext): void {
  app.get(
    "/v1/streams/:stream",
    { contract: "getStreamMetadata" },
    ctx.requireToken,
    ctx.requireCoreEndpointToken,
    async (req: RouteRequest, res: RouteResponse) => {
      let queryContext: QueryContext | null = null;
      try {
        const { tokenInfo } = req;
        const queryId = ctx.ensureRequestId(res);
        const { actorType, actorId, traceId, scenarioId } = ctx.buildQueryActorContext(tokenInfo);
        ctx.setReferenceTraceId(res, traceId);

        let manifest: ManifestLike;
        let storageBinding: StorageBindingLike;
        let sourceDescriptor: SourceDescriptorLike | null =
          tokenInfo.pdpp_token_kind === "owner"
            ? ctx.buildOwnerQuerySourceDescriptor(req, ctx.opts)
            : ctx.buildClientSourceDescriptor(tokenInfo);

        queryContext = {
          actorId,
          actorType,
          queryData: { query_shape: "stream_metadata" },
          queryId,
          scenarioId,
          sourceDescriptor,
          streamId: req.params.stream,
          tokenInfo,
          traceId,
        };

        ({ storageBinding, manifest, sourceDescriptor } = await resolveReadScope(ctx, req, tokenInfo, queryContext));

        await ctx.emitQueryReceived(queryContext, req);

        const operationInput = {
          actor: buildReadActor(tokenInfo),
          streamName: req.params.stream,
        };

        const dependencies = {
          buildStreamMetadata: async (name: string) => {
            const manifestStream = manifest.streams?.find((s) => s.name === name);
            const streamGrant =
              tokenInfo.pdpp_token_kind === "client" ? tokenInfo.grant?.streams?.find((s) => s.name === name) : null;
            const freshness = await ctx.getVisibleStreamFreshness({
              manifest,
              source: sourceDescriptor,
              storageBinding,
              stream: name,
              tokenInfo,
            });
            return ctx.buildStreamMetadataEntry({
              freshness,
              grantStreams: tokenInfo.grant?.streams || [],
              manifestStream,
              manifestStreamNames: new Set(
                (manifest.streams || [])
                  .map((s: ManifestStreamLike) => s.name)
                  // biome-ignore lint/suspicious/noShadow: The local name follows the external payload vocabulary at this boundary.
                  .filter((name): name is string => typeof name === "string")
              ),
              streamGrant,
            });
          },
          getSourceDescriptor: () => sourceDescriptor,
          hasManifestStream: async (name: string) =>
            // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
            Array.isArray(manifest?.streams) && manifest.streams.some((s) => s.name === name),
          isStreamInGrant: (name: string) =>
            Array.isArray(tokenInfo.grant?.streams) && tokenInfo.grant.streams.some((s) => s.name === name),
        };

        let result: Awaited<ReturnType<typeof executeStreamDetail>>;
        try {
          result = await executeStreamDetail(
            operationInput as unknown as StreamDetailInput,
            dependencies as unknown as StreamDetailDependencies
          );
        } catch (err) {
          if (err instanceof StreamDetailVisibilityError) {
            const visibilityErr = new Error(err.message) as Error & { code?: string };
            visibilityErr.code = err.code;
            return await ctx.rejectQuery(res, req, queryContext, visibilityErr);
          }
          throw err;
        }

        const metadataBody = result.metadata as unknown as {
          views: unknown[];
          relationships: unknown[];
        } & Record<string, unknown>;

        await emitDisclosureServed(ctx, {
          actorId,
          actorType,
          data: {
            query_shape: "stream_metadata",
            relationship_count: metadataBody.relationships.length,
            source: result.sourceDescriptor,
            view_count: metadataBody.views.length,
          },
          queryId,
          req,
          scenarioId,
          // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
          streamId: req.params.stream ?? null,
          tokenInfo,
          traceId,
        });

        return res.json(ctx.finalizeCanonicalEnvelope(metadataBody, req));
      } catch (err) {
        if (queryContext) {
          await ctx.emitQueryReceived(queryContext, req);
          return await ctx.rejectQuery(res, req, queryContext, err);
        }
        return ctx.handleError(res, err);
      }
    }
  );
}

// GET /v1/streams/:stream/aggregate
// Aggregate dependency object, extracted so the route handler stays under the
// cognitive-complexity bar. Accessors are passed as thunks because the route
// resolves `manifest` / `storageBinding` / `sourceDescriptor` / `grant` across
// the owner/client branch after this object would otherwise be built.
function buildStreamAggregateDeps(
  ctx: MountRsReadContext,
  tokenInfo: TokenInfo,
  refs: {
    streamName: string;
    manifest: ManifestLike;
    storageBinding: StorageBindingLike;
    sourceDescriptor: SourceDescriptorLike | null;
    grant: GrantLike | null;
  }
): Record<string, unknown> {
  const { streamName, manifest, storageBinding, sourceDescriptor, grant } = refs;
  return {
    aggregate: async (params: Record<string, unknown>) => {
      const { bindings, warnings: resolverWarnings } = await ctx.resolveReadRequestBindings({
        grant,
        ownerRead: tokenInfo.pdpp_token_kind === "owner",
        ownerSubjectId: ctx.ownerSubjectIdForBindings(tokenInfo),
        requestParams: params,
        storageBinding,
        streamName,
      });
      // P3: thread resolver-level warnings (deprecated alias) into the
      // multi-binding aggregate envelope. The helper folds them into
      // `meta.warnings[]` whether the dispatch hits the single-binding fast
      // path or the multi-binding fan-in path.
      return await ctx.aggregateRecordsAcrossBindings(bindings, streamName, grant, params, manifest, {
        extraWarnings: resolverWarnings || [],
      });
    },
    getSourceDescriptor: () => sourceDescriptor,
    // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
    hasManifestStream: (candidate: string) => Boolean(manifest?.streams?.find((stream) => stream.name === candidate)),
    validateRequest: (params: Record<string, unknown>) => {
      // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
      const mStream = manifest?.streams?.find((stream) => stream.name === streamName);
      ctx.validateRequestedQueryFieldParams(params, mStream);
    },
  };
}

export function mountRsStreamAggregate(app: AppLike, ctx: MountRsReadContext): void {
  app.get(
    "/v1/streams/:stream/aggregate",
    { contract: "aggregateStream" },
    ctx.requireToken,
    ctx.requireCoreEndpointToken,
    async (req: RouteRequest, res: RouteResponse) => {
      let queryContext: QueryContext | null = null;
      try {
        const { tokenInfo } = req;
        const queryId = ctx.ensureRequestId(res);
        const { actorType, actorId, traceId, scenarioId } = ctx.buildQueryActorContext(tokenInfo);
        ctx.setReferenceTraceId(res, traceId);

        const isOwner = tokenInfo.pdpp_token_kind === "owner";
        // The `:stream` segment is always present for this route; capture it as
        // a non-optional string so the downstream operation/binding calls keep
        // their `string` contracts under `noUncheckedIndexedAccess`.
        const streamName = req.params.stream as string;
        const requestParams = { ...req.query } as Record<string, unknown>;
        // Pre-emit query data block matches the operation's shape so the
        // rejected-query path emits the same fields whether the failure happens
        // before or after the operation runs.
        const queryEventData = buildAggregateQueryEventData(requestParams);
        queryContext = {
          actorId,
          actorType,
          queryData: { ...queryEventData },
          queryId,
          scenarioId,
          sourceDescriptor: isOwner
            ? ctx.buildOwnerQuerySourceDescriptor(req, ctx.opts)
            : ctx.buildClientSourceDescriptor(tokenInfo),
          streamId: streamName,
          tokenInfo,
          traceId,
        };

        rejectUnsupportedClientQuery(tokenInfo.pdpp_token_kind, requestParams);

        const scope = await resolveReadScope(ctx, req, tokenInfo, queryContext);
        const { storageBinding, manifest } = scope;
        // biome-ignore lint/style/useDestructuring: Explicit property or positional access documents this compatibility boundary.
        const sourceDescriptor = scope.sourceDescriptor;
        // Owner aggregate runs against a synthetic single-stream read grant;
        // client aggregate uses the bearer's grant.
        const grant: GrantLike | null = isOwner ? ctx.buildOwnerReadGrant(streamName) : (tokenInfo.grant ?? null);

        const operationInput = {
          actor: buildReadActor(tokenInfo),
          requestParams,
          streamName,
        };

        await ctx.emitQueryReceived(queryContext, req);

        const dependencies = buildStreamAggregateDeps(ctx, tokenInfo, {
          grant,
          manifest,
          sourceDescriptor,
          storageBinding,
          streamName,
        });

        const outcome = await runWithVisibilityRejection(
          () =>
            executeStreamsAggregate(
              operationInput as unknown as StreamsAggregateInput,
              dependencies as unknown as StreamsAggregateDependencies
            ),
          StreamsAggregateVisibilityError,
          (mapped) => ctx.rejectQuery(res, req, queryContext as QueryContext, mapped)
        );
        if (outcome.rejected) {
          return;
        }
        // biome-ignore lint/style/useDestructuring: Explicit property or positional access documents this compatibility boundary.
        const result = outcome.result;

        await emitDisclosureServed(ctx, {
          actorId,
          actorType,
          data: {
            field: result.disclosureTotals.field,
            filtered_record_count: result.disclosureTotals.filtered_record_count,
            group_by: result.disclosureTotals.group_by,
            group_count: result.disclosureTotals.group_count,
            metric: result.disclosureTotals.metric,
            query_shape: "stream_aggregate",
            source: result.sourceDescriptor,
          },
          queryId,
          req,
          scenarioId,
          streamId: streamName,
          tokenInfo,
          traceId,
        });

        return res.json(ctx.finalizeCanonicalEnvelope(result.result, req));
      } catch (err) {
        if (queryContext) {
          await ctx.emitQueryReceived(queryContext, req);
          return await ctx.rejectQuery(res, req, queryContext, err);
        }
        return ctx.handleError(res, err);
      }
    }
  );
}

// GET /v1/streams/:stream/records
// Records-list dependency object, extracted so the route handler stays under
// the cognitive-complexity bar. Behaviour-identical to the previous inline
// object; manifest / storage-binding / source-descriptor are read through
// thunks because the route resolves them across the owner/client branch.
function buildRecordsListDeps(
  ctx: MountRsReadContext,
  tokenInfo: TokenInfo,
  refs: {
    manifest: ManifestLike;
    storageBinding: StorageBindingLike;
    sourceDescriptor: SourceDescriptorLike | null;
  }
): Record<string, unknown> {
  const { manifest, storageBinding, sourceDescriptor } = refs;
  return {
    decorateRecord: (record: unknown) => ctx.decorateRecordBlobRefs(record),
    getGrant: () => tokenInfo.grant || { streams: [] },
    getManifest: () => manifest,
    getSourceDescriptor: () => sourceDescriptor,
    queryRecords: async (stream: string, grant: GrantLike | null, params: Record<string, unknown>, m: ManifestLike) => {
      const { bindings, warnings: resolverWarnings } = await ctx.resolveReadRequestBindings({
        grant,
        ownerRead: tokenInfo.pdpp_token_kind === "owner",
        ownerSubjectId: ctx.ownerSubjectIdForBindings(tokenInfo),
        requestParams: params,
        storageBinding,
        streamName: stream,
      });
      return await ctx.queryRecordsAcrossBindings(bindings, stream, grant, params, m, {
        extraWarnings: resolverWarnings || [],
      });
    },
    validateRequestFields: (params: Record<string, unknown>, manifestStream: ManifestStreamLike | undefined) =>
      ctx.validateRequestedQueryFieldParams(params, manifestStream),
  };
}

export function mountRsRecordsList(app: AppLike, ctx: MountRsReadContext): void {
  app.get(
    "/v1/streams/:stream/records",
    { contract: "listRecords" },
    ctx.requireToken,
    ctx.requireCoreEndpointToken,
    async (req: RouteRequest, res: RouteResponse) => {
      let queryContext: QueryContext | null = null;
      try {
        const { tokenInfo } = req;
        const queryId = ctx.ensureRequestId(res);
        const { actorType, actorId, traceId, scenarioId } = ctx.buildQueryActorContext(tokenInfo);
        ctx.setReferenceTraceId(res, traceId);

        const requestParams = { ...req.query } as Record<string, unknown>;
        const rawView = req.query.view;
        const queryEventData = {
          has_changes_since: !!requestParams.changes_since,
          limit: requestParams.limit ? Number(requestParams.limit) : null,
          query_shape: "record_list",
          ...(typeof rawView === "string" && rawView.trim() ? { requested_view: rawView.trim() } : {}),
        };
        queryContext = {
          actorId,
          actorType,
          queryData: { ...queryEventData },
          queryId,
          scenarioId,
          sourceDescriptor:
            tokenInfo.pdpp_token_kind === "owner"
              ? ctx.buildOwnerQuerySourceDescriptor(req, ctx.opts)
              : ctx.buildClientSourceDescriptor(tokenInfo),
          streamId: req.params.stream,
          tokenInfo,
          traceId,
        };

        rejectUnsupportedClientQuery(tokenInfo.pdpp_token_kind, requestParams);

        // Self-export: owner can query without a client grant. `resolveReadScope`
        // sets `queryContext.sourceDescriptor` and returns the resolved trio.
        const { storageBinding, manifest, sourceDescriptor } = await resolveReadScope(
          ctx,
          req,
          tokenInfo,
          queryContext
        );

        await ctx.emitQueryReceived(queryContext, req);

        const operationInput = {
          actor: buildReadActor(tokenInfo),
          rawQueryFields: req.query.fields,
          // Forward the raw `view` / `fields` values without coercion so the
          // operation can apply the previous native truthiness test
          // (`if (req.query.view && req.query.fields)`). `qs.parse` may
          // produce strings, arrays (repeated params), or objects (bracketed
          // params); the operation handles each shape per its boundary
          // contract.
          rawQueryView: req.query.view,
          requestParams,
          streamName: req.params.stream,
        };

        const dependencies = buildRecordsListDeps(ctx, tokenInfo, {
          manifest,
          sourceDescriptor,
          storageBinding,
        });

        let result: Awaited<ReturnType<typeof executeRecordsList>>;
        try {
          result = await executeRecordsList(
            operationInput as unknown as RecordsListInput,
            dependencies as unknown as RecordsListDependencies
          );
        } catch (err) {
          if (err instanceof RecordsListVisibilityError) {
            const mappedErr = new Error(err.message) as Error & { code?: string };
            mappedErr.code = err.code;
            return await ctx.rejectQuery(res, req, queryContext, mappedErr);
          }
          throw err;
        }

        await emitDisclosureServed(ctx, {
          actorId,
          actorType,
          data: { source: result.sourceDescriptor, ...result.disclosureData },
          queryId,
          req,
          scenarioId,
          // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
          streamId: req.params.stream ?? null,
          tokenInfo,
          traceId,
        });

        return res.json(
          ctx.finalizeCanonicalEnvelope(
            {
              ...result.result,
              url: req.path,
            },
            req
          )
        );
      } catch (err) {
        if (queryContext) {
          await ctx.emitQueryReceived(queryContext, req);
          return await ctx.rejectQuery(res, req, queryContext, err);
        }
        return ctx.handleError(res, err);
      }
    }
  );
}

// GET /v1/streams/:stream/records/:id
export function mountRsRecordDetail(
  app: AppLike,
  ctx: MountRsReadContext,
): void {
  app.get(
    "/v1/streams/:stream/records/:id",
    { contract: "getRecord" },
    pairwiseSelectorPrelude(ctx, safePairwiseDetailError),
    ctx.requireToken,
    ctx.requireCoreEndpointToken,
    async (req: RouteRequest, res: RouteResponse) => {
      let queryContext: QueryContext | null = null;
      try {
        const { tokenInfo } = req;
        const queryId = ctx.ensureRequestId(res);
        const { actorType, actorId, traceId, scenarioId } =
          ctx.buildQueryActorContext(tokenInfo);
        ctx.setReferenceTraceId(res, traceId);
        const initialSourceDescriptor: SourceDescriptorLike | null =
          tokenInfo.pdpp_token_kind === "owner"
            ? ctx.buildOwnerQuerySourceDescriptor(req, ctx.opts)
            : ctx.buildClientSourceDescriptor(tokenInfo);
        const streamName = req.params.stream as string;
        const requestedRecordId = decodeURIComponent(req.params.id as string);
        queryContext = {
          actorId,
          actorType,
          queryData: {
            has_changes_since: false,
            limit: null,
            query_shape: "record_detail",
            requested_record_id: requestedRecordId,
          },
          queryId,
          scenarioId,
          sourceDescriptor: initialSourceDescriptor,
          streamId: req.params.stream,
          tokenInfo,
          traceId,
        };

        rejectUnsupportedClientQuery(tokenInfo.pdpp_token_kind, req.query);
        const pairwiseContext = await preparePairwiseSingleRecordContext(
          ctx,
          req,
          tokenInfo,
          queryContext,
          streamName,
        );
        const {
          grant: detailGrant,
          manifest,
          ownerRead,
          ownerSubjectId,
          readMap,
          requestParams,
          selection,
          sourceDescriptor,
          storageBinding,
        } = pairwiseContext;
        await ctx.emitQueryReceived(queryContext, req);

        const operationInput = {
          actor: buildReadActor(tokenInfo),
          expandOptions: {
            expand: req.query.expand,
            expand_limit: req.query.expand_limit,
            fields: req.query.fields,
          },
          recordId: requestedRecordId,
          streamName,
        };

        const dependencies = {
          decorateRecord: (record: unknown) =>
            ctx.decorateRecordBlobRefs(record),
          getGrant: () => detailGrant,
          getManifest: () => manifest,
          getRecord: async (
            stream: string,
            recordId: string,
            grant: GrantLike | null,
            m: ManifestLike,
            options: Record<string, unknown>,
          ) => {
            // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
            const mergedParams = { ...requestParams, ...(options || {}) };
            const { bindings, warnings: resolverWarnings } =
              await ctx.resolveReadRequestBindings({
                grant,
                ownerRead,
                ownerSubjectId,
                requestParams: mergedParams,
                storageBinding: storageBinding as StorageBindingLike,
                streamName: stream,
              });
            return await ctx.getRecordAcrossBindings(
              bindings,
              stream,
              recordId,
              grant,
              m,
              mergedParams,
              {
                extraWarnings: resolverWarnings || [],
              },
            );
          },
          getSourceDescriptor: () => sourceDescriptor,
          validateRequestFields: (
            requestParams: Record<string, unknown>,
            manifestStream: ManifestStreamLike | null,
          ) =>
            ctx.validateRequestedQueryFieldParams(
              requestParams,
              manifestStream ?? undefined,
            ),
        };

        // The native `getRecord` capability throws an `Error` carrying
        // `code: 'not_found'` for missing or grant-filtered records, so the
        // operation's null-record check is unreachable here — that branch
        // only fires for hosts whose `getRecord` returns null on miss
        // (e.g., the sandbox fixture). Native `not_found` errors flow
        // through the existing outer catch into `rejectQuery`.
        let result: Awaited<ReturnType<typeof executeRecordDetail>>;
        try {
          result = await executeRecordDetail(
            operationInput as unknown as RecordDetailInput,
            dependencies as unknown as RecordDetailDependencies,
          );
        } catch (err) {
          if (err instanceof RecordDetailVisibilityError) {
            const mappedErr = new Error(err.message) as Error & {
              code?: string;
            };
            mappedErr.code = err.code;
            return await ctx.rejectQuery(
              res,
              req,
              queryContext,
              safePairwiseDetailError(mappedErr),
            );
          }
          throw err;
        }

        const projectedRecord = projectPairwiseDetailRecord(
          result.record,
          readMap,
        );
        if (
          !projectedRecord ||
          typeof projectedRecord !== "object" ||
          (projectedRecord as Record<string, unknown>).instance_id !==
            selection.handle
        ) {
          throw Object.assign(
            new Error("Stored record is outside its selected instance"),
            { code: "grant_invalid" },
          );
        }

        const response = ctx.finalizeCanonicalEnvelope(
          withRecordSourceIdentity(projectedRecord, {
            sourceDescriptor,
            storageBinding,
          }),
          {
            ...req,
            query: { ...req.query, instance_id: selection.handle },
            url: canonicalDetailUrl(req, selection.handle),
          },
        );

        await emitDisclosureServed(ctx, {
          actorId,
          actorType,
          data: { source: result.sourceDescriptor, ...result.disclosureData },
          queryId,
          req,
          scenarioId,
          // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
          streamId: req.params.stream ?? null,
          tokenInfo,
          traceId,
        });
        return res.json(response);
      } catch (err) {
        if (queryContext) {
          await ctx.emitQueryReceived(queryContext, req);
          return await ctx.rejectQuery(
            res,
            req,
            queryContext,
            safePairwiseDetailError(err),
          );
        }
        return ctx.handleError(res, safePairwiseDetailError(err));
      }
    },
  );
}

// GET /v1/streams/:stream/records/:id/field-window
//
// Bounded field-window read — the HTTP surface of the MCP content-ladder
// substrate (`getRecordFieldWindow`). Returns a grant-enforced character window
// of one top-level string field WITHOUT hydrating the whole field into a
// response: the resource server is the authority that clamps the window and
// enforces stream/field/resource/time/connection scope before any field bytes
// are read.
//
// This route deliberately mirrors `mountRsRecordDetail`'s auth, scope
// resolution, binding resolution, spine emission, and error-> HTTP mapping. It
// adds only the field-window selector (`field`, `offset_chars`, `limit_chars`)
// and a window-shaped envelope. It does NOT recompute visibility — every
// authorization decision lives inside the injected
// `getRecordFieldWindowAcrossBindings` capability.
//
// Spec: openspec/changes/add-mcp-content-ladder/specs/mcp-adapter/spec.md
//       (#"MCP bounded field reads SHALL be served by a grant-enforced
//        resource-server path")
export function mountRsRecordFieldWindow(app: AppLike, ctx: MountRsReadContext): void {
  app.get(
    "/v1/streams/:stream/records/:id/field-window",
    // No `contract` op-id yet: the field-window operation is not in
    // `@pdpp/reference-contract`, and registering an unknown op-id throws at
    // startup (see transport.registerRoute). Adding the contract operation +
    // its request/response JSON Schema is a follow-up tracked in the MCP
    // content-ladder change; this route does its own selector validation and
    // returns through the shared canonical envelope until then.
    pairwiseSelectorPrelude(ctx, safePairwiseFieldWindowError),
    ctx.requireToken,
    ctx.requireCoreEndpointToken,
    async (req: RouteRequest, res: RouteResponse) => {
      let queryContext: QueryContext | null = null;
      try {
        const { tokenInfo } = req;
        const queryId = ctx.ensureRequestId(res);
        const { actorType, actorId, traceId, scenarioId } = ctx.buildQueryActorContext(tokenInfo);
        ctx.setReferenceTraceId(res, traceId);

        const streamName = req.params.stream as string;
        const requestedRecordId = decodeURIComponent(req.params.id as string);
        const rawField = req.query.field;
        const fieldPath = typeof rawField === "string" ? rawField : "";

        queryContext = {
          actorId,
          actorType,
          queryData: {
            field_path: fieldPath || null,
            has_changes_since: false,
            limit: null,
            query_shape: "field_window",
            requested_record_id: requestedRecordId,
          },
          queryId,
          scenarioId,
          sourceDescriptor:
            tokenInfo.pdpp_token_kind === "owner"
              ? ctx.buildOwnerQuerySourceDescriptor(req, ctx.opts)
              : ctx.buildClientSourceDescriptor(tokenInfo),
          streamId: streamName,
          tokenInfo,
          traceId,
        };

        // `field` is required and selector-shaped before we resolve any scope,
        // so a malformed request fails fast with the same typed-error vocabulary
        // the substrate uses (`invalid_field_path` -> 400).
        if (!fieldPath) {
          const err = new Error("field is required and must be a non-empty string") as Error & {
            code?: string;
            param?: string;
          };
          err.code = "invalid_field_path";
          err.param = "field";
          await ctx.emitQueryReceived(queryContext, req);
          return await ctx.rejectQuery(res, req, queryContext, err);
        }

        const pairwiseContext = await preparePairwiseSingleRecordContext(
          ctx,
          req,
          tokenInfo,
          queryContext,
          streamName,
        );
        const {
          grant,
          manifest,
          ownerRead,
          ownerSubjectId,
          requestParams,
          selection,
          sourceDescriptor,
          storageBinding,
        } = pairwiseContext;

        await ctx.emitQueryReceived(queryContext, req);

        if (
          await rejectInvalidWindowParams(
            ctx,
            res,
            req,
            queryContext,
            requestParams,
            safePairwiseFieldWindowError,
          )
        ) {
          return;
        }

        const { bindings, warnings: resolverWarnings } =
          await ctx.resolveReadRequestBindings({
            grant,
            ownerRead,
            ownerSubjectId,
            requestParams,
            storageBinding,
            streamName,
          });
        const expectedConnectorId = storageBinding.connector_id
          ? ctx.canonicalConnectorKey(storageBinding.connector_id) ??
            storageBinding.connector_id
          : null;
        if (
          bindings.length !== 1 ||
          bindings[0]?.connectorInstanceId !== selection.internalId ||
          (expectedConnectorId &&
            bindings[0]?.connectorId !== expectedConnectorId)
        ) {
          throw Object.assign(
            new Error(
              "Resolved field-window binding differs from the selected instance",
            ),
            { code: "grant_invalid" },
          );
        }

        const windowResult = projectPairwiseFieldWindowResult(
          await ctx.getRecordFieldWindowAcrossBindings(
            bindings,
            streamName,
            requestedRecordId,
            fieldPath,
            grant,
            manifest,
            requestParams,
            { extraWarnings: resolverWarnings || [] },
          ),
          requestedRecordId,
          fieldPath,
        );

        const responseBody: Record<string, unknown> = {
          field: { path: fieldPath, type: windowResult.fieldType },
          instance_id: selection.handle,
          object: "field_window",
          record_id: requestedRecordId,
          stream: streamName,
          url: canonicalDetailUrl(req, selection.handle),
          window: windowResult.window,
        };
        mergeResolverWarningsIntoBody(
          responseBody,
          safePairwiseFieldWindowWarnings(windowResult.warnings),
        );
        const response = ctx.finalizeCanonicalEnvelope(responseBody, {
          ...req,
          query: { ...req.query, instance_id: selection.handle },
          url: canonicalDetailUrl(req, selection.handle),
        });

        await emitDisclosureServed(ctx, {
          actorId,
          actorType,
          data: {
            field_path: fieldPath,
            query_shape: "field_window",
            source: sourceDescriptor,
          },
          queryId,
          req,
          scenarioId,
          streamId: streamName,
          tokenInfo,
          traceId,
        });

        return res.json(response);
      } catch (err) {
        if (queryContext) {
          await ctx.emitQueryReceived(queryContext, req);
          return await ctx.rejectQuery(
            res,
            req,
            queryContext,
            safePairwiseFieldWindowError(err),
          );
        }
        return ctx.handleError(res, safePairwiseFieldWindowError(err));
      }
    }
  );
}

// Shared owner-mode search wiring. The three search routes pass an identical
// set of owner/client resolver closures into their respective `run*Search`
// helper; this keeps the duplication to one place exactly as the inline
// handlers expressed it (per-route literal objects).
function buildSearchHelpers(req: RouteRequest, ctx: MountRsReadContext): Record<string, unknown> {
  return {
    // Synthetic owner read grant covering every stream of the manifest;
    // fields = undefined ⇒ "all fields authorized" per
    // buildSearchPlanForGrant semantics.
    buildOwnerReadGrantForManifest: (manifest: ManifestLike) => ({
      // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
      streams: (manifest?.streams || []).map((s) => ({ name: s.name })),
    }),
    getOwnerSubjectId: () => ctx.getOwnerTokenSubjectId(req),
    // Client-mode resolver
    resolveGrantManifest: (info: TokenInfo) => ctx.resolveGrantManifest(info, ctx.opts),
    resolveOwnerManifestFromScope: (ownerScope: unknown) => ctx.resolveOwnerManifestFromScope(ownerScope, ctx.opts),
    resolveOwnerScopeForConnector: (connectorId: string) => ({
      owner_subject_id: ctx.getOwnerTokenSubjectId(req),
      public_scope: "polyfill",
      source: { id: connectorId, kind: "connector" },
      storage_binding: { connector_id: connectorId },
    }),
    resolveOwnerVisibleConnectorIds: async () => {
      const native = ctx.resolveNativeManifest(ctx.opts);
      if (native?.storage_binding?.connector_id) {
        // Native mode: a single owner-visible connector identity.
        return [native.storage_binding.connector_id];
      }
      // Polyfill mode: every registered connector is owner-visible.
      return await ctx.listRegisteredConnectorIds();
    },
  };
}

// Shared inner handler for all three search routes (lexical, semantic, hybrid).
// The only differences between the three are the `query_shape` label stored in
// `queryContext.queryData` and the `ctx.run*Search` method invoked — both are
// supplied via `opts`.  Everything else (header setup, queryContext construction,
// emitQueryReceived, emitDisclosureServed, res.json, catch block) is identical.
async function runSearchRouteHandler(
  ctx: MountRsReadContext,
  req: RouteRequest,
  res: RouteResponse,
  opts: {
    queryShape: string;
    runSearch: (args: Record<string, unknown>) => Promise<{ envelope: unknown; disclosureData: unknown }>;
  }
): Promise<unknown> {
  let queryContext: QueryContext | null = null;
  try {
    const { tokenInfo } = req;
    const queryId = ctx.ensureRequestId(res);
    const { actorType, actorId, traceId, scenarioId } = ctx.buildQueryActorContext(tokenInfo);
    ctx.setReferenceTraceId(res, traceId);

    const isOwner = tokenInfo.pdpp_token_kind === "owner";
    queryContext = {
      actorId,
      actorType,
      queryData: { query_shape: opts.queryShape },
      queryId,
      scenarioId,
      sourceDescriptor: isOwner ? null : ctx.buildClientSourceDescriptor(tokenInfo),
      streamId: null,
      tokenInfo,
      traceId,
    };
    rejectUnsupportedClientQuery(tokenInfo.pdpp_token_kind, req.query);
    await ctx.emitQueryReceived(queryContext, req);

    // I3 read-time self-heal: fire-and-forget, cooldown- and in-flight-
    // deduplicated. MUST NOT be awaited -- a single dirty scope's backfill
    // has no internal wall-clock bound (only the reconcile ROUND checks a
    // deadline BETWEEN scopes, not within one), so awaiting this here could
    // block an ordinary search request for an unbounded duration. The
    // periodic maintenance sweep is still the authoritative convergence
    // path; this only accelerates it opportunistically.
    ctx.triggerSearchIndexDirtySelfHeal?.();

    const { envelope, disclosureData } = await opts.runSearch({
      opts: ctx.opts,
      req,
      tokenInfo,
      ...buildSearchHelpers(req, ctx),
    });

    await emitDisclosureServed(ctx, {
      actorId,
      actorType,
      data: disclosureData as Record<string, unknown>,
      queryId,
      req,
      scenarioId,
      streamId: null,
      tokenInfo,
      traceId,
    });

    // Honest global-backlog disclosure: a nonzero search_index_dirty
    // backlog means SOME scope somewhere may be under-indexed right now.
    // This is deliberately coarse (process-wide, not scoped to this
    // query's specific connector instances/streams -- doing that
    // precisely would require the search execution path itself to report
    // which scopes it actually touched, which it does not today) but it
    // is never wrong in the direction that matters: it only ever ADDS a
    // "results may be incomplete" signal, never removes one, and it never
    // fires when the backlog is actually empty. Silence is not a claim of
    // completeness on its own (see the existing count_accuracy/recall
    // disclosure for the query-scoped signal); this augments that with
    // the one honest thing this layer can cheaply prove.
    const envelopeWithMeta = envelope as { meta?: Record<string, unknown> };
    if (envelopeWithMeta.meta) {
      const dirtyCount = await ctx.countSearchIndexDirtyScopes?.().catch(() => 0);
      if (dirtyCount) {
        envelopeWithMeta.meta.index_maintenance = {
          note: "a background index-maintenance backlog exists somewhere on this server; some results elsewhere may be temporarily under-indexed. This is not scoped to this specific query.",
          pending_scopes: dirtyCount,
        };
      }
    }

    return res.json(ctx.finalizeCanonicalEnvelope(envelope, req));
  } catch (err) {
    if (queryContext) {
      return await ctx.rejectQuery(res, req, queryContext, err);
    }
    return ctx.handleError(res, err);
  }
}

// GET /v1/search — public lexical retrieval extension.
export function mountRsSearchLexical(app: AppLike, ctx: MountRsReadContext): void {
  app.get(
    "/v1/search",
    { contract: "searchRecordsLexical" },
    ctx.requireToken,
    ctx.requireCoreEndpointToken,
    (req: RouteRequest, res: RouteResponse) =>
      runSearchRouteHandler(ctx, req, res, {
        queryShape: "search",
        runSearch: (args) => ctx.runLexicalSearch(args),
      })
  );
}

// GET /v1/search/semantic — experimental public semantic retrieval. Unstable.
//
// Only registered when a real embedding backend is configured. When no
// backend is configured, the advertisement is also omitted (see the RS
// metadata route handler) and requests fall through to the default 404 —
// which is what the spec scenario "A client encounters a server that does
// not advertise the extension" expects. The gate is evaluated here at mount
// time, identical to the inline `if (...) { app.get(...) }` guard.
export function mountRsSearchSemantic(app: AppLike, ctx: MountRsReadContext): void {
  const semanticBackendAtRegistration = ctx.getSemanticBackend();
  if (!(semanticBackendAtRegistration?.available() && ctx.opts.semanticRetrievalSupported !== false)) {
    return;
  }
  app.get(
    "/v1/search/semantic",
    { contract: "searchRecordsSemantic" },
    ctx.requireToken,
    ctx.requireCoreEndpointToken,
    (req: RouteRequest, res: RouteResponse) =>
      runSearchRouteHandler(ctx, req, res, {
        queryShape: "search_semantic",
        runSearch: (args) => ctx.runSemanticSearch(args),
      })
  );
}

// GET /v1/search/hybrid — experimental public hybrid retrieval. Composes
// lexical + semantic under the same grant; deduplicates by
// (connector_id, stream, record_key); emits per-source provenance and score
// objects. Registered only when BOTH underlying surfaces are active on this
// server. The gate is evaluated here at mount time, identical to the inline
// guard.
export function mountRsSearchHybrid(app: AppLike, ctx: MountRsReadContext): void {
  const hybridBackendAtRegistration = ctx.getSemanticBackend();
  const hybridSemanticAvailable = !!(
    hybridBackendAtRegistration?.available() && ctx.opts.semanticRetrievalSupported !== false
  );
  const hybridLexicalAvailable = ctx.opts.lexicalRetrievalSupported !== false;
  if (!(ctx.opts.hybridRetrievalSupported !== false && hybridLexicalAvailable && hybridSemanticAvailable)) {
    return;
  }
  app.get(
    "/v1/search/hybrid",
    { contract: "searchRecordsHybrid" },
    ctx.requireToken,
    ctx.requireCoreEndpointToken,
    (req: RouteRequest, res: RouteResponse) =>
      runSearchRouteHandler(ctx, req, res, {
        queryShape: "search_hybrid",
        runSearch: (args) => ctx.runHybridSearch(args),
      })
  );
}

// Pipe the resolved (single) binding through the canonical `executeBlobsRead`
// operation and write the response: content headers, the deprecated-alias
// warning header (P3 — the raw-bytes response has no JSON envelope to carry
// `meta.warnings[]`), and the bytes. Behaviour-identical to the previous inline
// tail.
const INLINE_BLOB_MEDIA_TYPES = new Set([
  "application/pdf",
  "image/avif",
  "image/bmp",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/tiff",
  "image/webp",
  "image/x-icon",
]);

async function serveResolvedBlob(
  res: RouteResponse,
  args: {
    blobId: string;
    blobRow: BlobRow;
    actorConnectorId: string | null;
    resolvedMatch: { binding: BlobBindingRow; record: unknown };
    resolverWarnings: ResolverWarning[] | undefined;
  }
): Promise<void> {
  const { blobId, blobRow, actorConnectorId, resolvedMatch, resolverWarnings } = args;
  const dependencies = {
    getActorConnectorId: () => actorConnectorId,
    getVisibleRecord: () => resolvedMatch.record,
    loadBindings: () => [resolvedMatch.binding],
    loadBlob: () => blobRow,
  };
  let output: Awaited<ReturnType<typeof executeBlobsRead>>;
  try {
    output = await executeBlobsRead(
      { blobId } as unknown as BlobsReadInput,
      dependencies as unknown as BlobsReadDependencies
    );
  } catch (opErr) {
    if (opErr instanceof BlobsReadNotFoundError) {
      const mapped = new Error(opErr.message) as Error & { code?: string };
      mapped.code = opErr.code;
      throw mapped;
    }
    throw opErr;
  }
  // biome-ignore lint/style/useDestructuring: Explicit property or positional access documents this compatibility boundary.
  const blob = output.blob;
  res.setHeader("Content-Type", blob.mime_type);
  res.setHeader("Content-Length", String(blob.size_bytes));
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  const mediaType = blob.mime_type.split(";", 1)[0]?.trim().toLowerCase();
  if (!INLINE_BLOB_MEDIA_TYPES.has(mediaType ?? "")) {
    res.setHeader("Content-Disposition", "attachment");
  }
  // P3: when the resolver observed deprecated alias use, surface it as a
  // structured response header so callers see migration signal.
  if (Array.isArray(resolverWarnings) && resolverWarnings.some((w) => w?.code === "deprecated_alias_used")) {
    res.setHeader("PDPP-Warning", "deprecated_alias_used: connection_id");
  }
  res.send(Buffer.isBuffer(blob.data) ? blob.data : Buffer.from(blob.data || ""));
}

// GET /v1/blobs/:blob_id — per-binding blob-visibility read. Storage reads
// flow through the `BlobStore` capability (server/stores/blob-store.ts),
// constructed once via `ctx.createBlobStore()` at mount time exactly as the
// inline `const blobStore = createBlobStore()` did. The route owns the
// binding scan and the per-stream closed `instance_ids` re-check (P1/P2
// fixes); `executeBlobsRead` owns the 404 / 200 shape and error mapping.
export function mountRsBlobRead(app: AppLike, ctx: MountRsReadContext): void {
  const blobStore = ctx.createBlobStore();
  app.get(
    "/v1/blobs/:blob_id",
    { contract: "getBlob" },
    pairwiseSelectorPrelude(ctx, safePairwiseBlobError, true),
    ctx.requireToken,
    ctx.requireCoreEndpointToken,
    async (req: RouteRequest, res: RouteResponse) => {
      try {
        const blobId = decodeURIComponent(req.params.blob_id as string);
        const { tokenInfo } = req;
        const ownerRead = tokenInfo.pdpp_token_kind === "owner";
        const ownerSubjectId = ctx.ownerSubjectIdForBindings(tokenInfo);
        if (!ownerSubjectId) {
          throw Object.assign(
            new Error("Authenticated instance subject is unavailable"),
            {
              code: "grant_invalid",
            },
          );
        }

        let identityMap: PairwiseReadMap;
        let clientContext: ReturnType<typeof pairwiseClientReadContext> | null =
          null;
        let selection: ReturnType<typeof parsePairwiseReadSelector>;
        let storageBinding: StorageBindingLike;
        let manifest: ManifestLike;
        if (ownerRead) {
          const ownerMap = pairwiseOwnerReadMap(tokenInfo);
          await ctx.validatePairwiseReadBindingOwnership({
            ownerSubjectId,
            bindings: ownerMap.bindings,
          });
          identityMap = { ...ownerMap, stream: "*" };
          selection = parsePairwiseReadSelector(req.query, identityMap, {
            requireSelector: true,
          });
          const selectedBinding = ownerMap.bindings.find(
            (binding) => binding.instance_id === selection.handle,
          );
          if (!selectedBinding) {
            throw Object.assign(
              new Error("Instance is not available under this authorization"),
              {
                code: "not_found",
              },
            );
          }
          const requestedSourceId = await ownerDetailSourceId(ctx, req);
          if (
            requestedSourceId &&
            requestedSourceId !== selectedBinding.source_id
          ) {
            throw Object.assign(
              new Error("Instance is not available under this authorization"),
              {
                code: "not_found",
              },
            );
          }
          const ownerScopeQuery = { ...(req.query as Record<string, unknown>) };
          delete ownerScopeQuery.instance_id;
          delete ownerScopeQuery.connection_id;
          delete ownerScopeQuery.connector_instance_id;
          ownerScopeQuery.connection_id = selection.internalId;
          const scopeReq = { ...req, query: ownerScopeQuery };
          const ownerScope = await ctx.resolveOwnerReadScope(
            scopeReq,
            ctx.opts,
          );
          const ownerResolved = await ctx.resolveOwnerManifestFromScope(
            ownerScope,
            ctx.opts,
          );
          storageBinding = ownerResolved.storageBinding;
          manifest = ownerResolved.manifest;
        } else {
          const sourceId = (
            tokenInfo.grant as unknown as { source?: { id?: unknown } } | null
          )?.source?.id;
          clientContext = pairwiseClientReadContext(
            tokenInfo as Parameters<typeof pairwiseClientReadContext>[0],
            typeof sourceId === "string" ? sourceId : "",
          );
          await ctx.validatePairwiseReadBindingOwnership({
            ownerSubjectId,
            bindings: clientContext.bindings,
          });
          identityMap = { ...clientContext, stream: "*" };
          selection = parsePairwiseReadSelector(req.query, identityMap, {
            requireSelector: true,
          });
          const grantResolved = await ctx.resolveGrantManifest(
            tokenInfo,
            ctx.opts,
          );
          storageBinding = grantResolved.storageBinding;
          manifest = grantResolved.manifest;
        }

        // Selector resolution and complete private-binding validation precede
        // content and binding lookup. Blob visibility remains record based.
        const blobRow = await blobStore.loadContentAddressedBlob(blobId);
        if (!blobRow) {
          throw Object.assign(new Error("Blob not found"), {
            code: "blob_not_found",
          });
        }
        const rawActorConnectorId = storageBinding.connector_id ?? null;
        const actorConnectorId = rawActorConnectorId
          ? (ctx.canonicalConnectorKey(rawActorConnectorId) ??
            rawActorConnectorId)
          : null;
        const requestParams = { ...(req.query as Record<string, unknown>) };
        delete requestParams.instance_id;
        delete requestParams.connection_id;
        delete requestParams.connector_instance_id;
        requestParams.connection_id = selection.internalId;
        let resolverWarnings: ResolverWarning[] | undefined =
          req._pdpp_deprecated_instance_alias
            ? [{ code: "deprecated_alias_used" }]
            : undefined;
        let resolvedMatch: { binding: BlobBindingRow; record: unknown } | null =
          null;
        let cursor: { record_key: string; stream: string } | null = null;

        while (actorConnectorId && !resolvedMatch) {
          const page = await blobStore.listBlobBindingsPage({
            blobId,
            connectorId: actorConnectorId,
            connectorInstanceId: selection.internalId,
            cursor,
          });
          for (const binding of page.rows) {
            if (
              clientContext &&
              !clientContext.handlesByStream
                .get(binding.stream)
                ?.has(selection.handle)
            ) {
              continue;
            }

            const grant = ownerRead
              ? ctx.buildOwnerReadGrant(binding.stream)
              : (clientGrantForPairwiseDetail(
                  (tokenInfo.grant ?? { streams: [] }) as unknown as Record<
                    string,
                    unknown
                  >,
                  binding.stream,
                  selection.internalId,
                ) as GrantLike);
            const requestBindings = await ctx.resolveReadRequestBindings({
              grant,
              ownerRead,
              ownerSubjectId,
              requestParams,
              storageBinding,
              streamName: binding.stream,
            });
            const bindingIsAddressable = requestBindings.bindings.some(
              (candidate) =>
                candidate.connectorInstanceId === selection.internalId &&
                (ctx.canonicalConnectorKey(candidate.connectorId) ??
                  candidate.connectorId) === binding.connector_id,
            );
            if (!bindingIsAddressable) continue;
            resolverWarnings = [
              ...(resolverWarnings ?? []),
              ...(requestBindings.warnings ?? []),
            ];

            let record: Awaited<ReturnType<typeof ctx.getRecord>>;
            try {
              record = await ctx.getRecord(
                {
                  connector_id: binding.connector_id,
                  connector_instance_id: selection.internalId,
                },
                binding.stream,
                binding.record_key,
                grant,
                manifest,
              );
            } catch (error) {
              if ((error as { code?: unknown })?.code === "not_found") continue;
              throw error;
            }
            if (record?.data?.blob_ref?.blob_id === blobId) {
              resolvedMatch = { binding, record };
              break;
            }
          }
          if (resolvedMatch || !page.nextCursor) break;
          cursor = page.nextCursor;
        }
        if (!resolvedMatch) {
          throw Object.assign(new Error("Blob not found"), {
            code: "blob_not_found",
          });
        }
        await serveResolvedBlob(res, {
          actorConnectorId,
          blobId,
          blobRow,
          resolvedMatch,
          resolverWarnings: resolverWarnings?.length
            ? resolverWarnings
            : undefined,
        });
      } catch (err) {
        ctx.handleError(res, safePairwiseBlobError(err));
      }
    },
  );
}

// Mount the entire RS read family in the same registration order the inline
// handlers used in `buildRsApp`: connectors, schema, streams list, stream
// detail, aggregate, records list, record detail, lexical search,
// semantic search (gated), hybrid search (gated). The blob-read route mounts
// last because in `server/index.js` it is registered immediately after the
// `POST /v1/blobs` mutation route (§4); the host call site mounts it at that
// same point.
export function mountRsReadQueries(app: AppLike, ctx: MountRsReadContext): void {
  mountRsConnectors(app, ctx);
  mountRsSchema(app, ctx);
  mountRsStreamsList(app, ctx);
  mountRsStreamDetail(app, ctx);
  mountRsStreamAggregate(app, ctx);
  mountRsRecordsList(app, ctx);
  mountRsRecordDetail(app, ctx);
  mountRsRecordFieldWindow(app, ctx);
  mountRsSearchLexical(app, ctx);
  mountRsSearchSemantic(app, ctx);
  mountRsSearchHybrid(app, ctx);
}
