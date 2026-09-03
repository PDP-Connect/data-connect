// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// HTTP adapter for the AS OAuth authorize route family.
//
// Behaviour-preserving extraction from `server/index.js` per the OpenSpec
// change `split-reference-server-by-route-family`.
//
// Covers:
//   GET  /oauth/authorize             — initiate OAuth flow; shows hosted MCP
//                                       picker for multi-source grants or
//                                       redirects to consent for single-source
//   POST /oauth/authorize/mcp-package — hosted MCP picker submission: builds a
//                                       package grant and issues an auth code
//
// Auth posture:
//   Both routes — ownerAuth.requireOwnerSession (owner-cookie enforcement).
//   POST /oauth/authorize/mcp-package additionally requires ownerAuth.requireCsrf.
//
// Canonical operations delegated to injected capabilities:
//   consentStore.initiateGrant     — initiate a pending-consent device-code flow
//   createHostedMcpGrantPackage    — create a package grant for multi-source picker
//   stageOAuthAuthorizationCodeRequest — stage the PKCE authorization code
//   issueOAuthAuthorizationCodeForPackageDeviceCode — issue code for package

import { randomBytes } from "node:crypto";
import type { MiddlewareHandler, RouteArg } from "./_route-contract.ts";
import type {
  ConsentPickerBinding,
  ConsentPickerCapabilities,
  ConsentPickerManifest,
  ConsentUiRenderer,
  PendingGrantRequest,
} from "./as-consent-ui-helpers.ts";
import { resolveGrantExpiry } from "../hosted-mcp-grant-expiry.ts";
import {
  type StreamScopeError,
  type StreamScopeSelection,
  parseSubmittedStreamScopes,
  resolveStreamScopeSelection,
  scopeFieldsInputName,
  scopeSinceInputName,
  scopeUntilInputName,
} from "../hosted-mcp-stream-scope.ts";
import {
  ActiveBindingLookupError,
  buildConsentClientDisplay,
  buildHostedMcpConsentChallengeModel,
  buildHostedMcpAuthorizationDetailForConnector,
  buildHostedMcpAuthorizationDetailsForConnector,
  computeHostedMcpDecisionDigest,
  computeHostedMcpPickerReviewDigest,
  HOSTED_MCP_PICKER_DEFAULT_ACCESS_MODE,
  HOSTED_MCP_PICKER_SUPPORTED_ACCESS_MODES,
  parseAuthorizeAuthorizationDetails,
  renderHostedMcpSourceSelection,
  requireAuthorizeString,
  requireRegisteredRedirectUri,
  resolveHostedMcpPickerSnapshotDigest,
  resolveHostedMcpSourceDescriptor,
  validateAuthorizePkce,
} from "./as-consent-ui-helpers.ts";
import type { FetchClientLogoOptions } from "../client-logo-cache.ts";

// ─── Minimal structural types ────────────────────────────────────────────────

interface RouteRequest {
  readonly body: Record<string, unknown> | null | undefined;
  ownerAuth?: { subjectId?: string };
  readonly params?: Record<string, unknown>;
  readonly query: Record<string, unknown>;
  /**
   * True when this request came through the console's challenge API and so
   * expects a typed JSON envelope rather than a re-rendered HTML page. Set by
   * the challenge routes on the body they synthesize, never read from the
   * wire — a client cannot ask the form path to answer in JSON.
   */
  readonly wantsJson?: boolean;
}

interface RouteResponse {
  json: (body: unknown) => unknown;
  redirect: (status: number, url: string) => unknown;
  send: (body: string) => unknown;
  status: (status: number) => RouteResponse;
}

// ─── Consent challenge store (Ory-Hydra-shaped login-and-consent handoff) ────
//
// The authorize request pauses here. Everything the owner is about to be
// asked — which client, which authorize params, which eligibility snapshot —
// is held server-side under an opaque id, and only that id travels to the
// console. The console renders the decision and posts it back; the AS keeps
// the protocol.
//
// Holding the params server-side (rather than re-passing them through the
// browser) is the security property that matters: the owner's browser cannot
// alter `client_id`, `redirect_uri`, or the PKCE challenge between the
// authorize request and the approval, because it never carries them.
//
// PROCESS-LOCAL AND DELIBERATELY SO, FOR NOW. A challenge lives seconds to
// minutes and is consumed once; losing the map on restart costs the owner a
// re-click of an authorize link that is itself still valid. That is the same
// durability the staged PKCE shell already has. It does mean a multi-process
// or multi-replica deployment MUST pin the authorize and approve requests to
// one process, or move this to the same store that backs pending consent —
// see CONSENT-REAL-FLOW-REPORT.md.
const CONSENT_CHALLENGE_TTL_MS = 30 * 60 * 1000;
const CONSENT_CHALLENGE_MAX = 256;

interface ConsentChallengeRecord {
  readonly authorizeParams: Record<string, string | null>;
  readonly client: OAuthClient;
  readonly createdAt: number;
  readonly id: string;
  readonly ownerSubjectId: string;
}

const consentChallenges = new Map<string, ConsentChallengeRecord>();

// Bounded on write, so an unauthenticated flood of authorize requests cannot
// grow this map without limit. Expiry first (a challenge older than the TTL is
// gone whether or not there is pressure), then oldest-first eviction — Map
// preserves insertion order, and inserts here are monotonic in `createdAt`.
function sweepConsentChallenges(now: number): void {
  for (const [id, record] of consentChallenges) {
    if (now - record.createdAt >= CONSENT_CHALLENGE_TTL_MS) {
      consentChallenges.delete(id);
    }
  }
  while (consentChallenges.size >= CONSENT_CHALLENGE_MAX) {
    const oldest = consentChallenges.keys().next();
    if (oldest.done) {
      return;
    }
    consentChallenges.delete(oldest.value);
  }
}

/**
 * Reads a live challenge, treating an expired one as absent so a stale id can
 * never be approved. Callers map `null` to the same 404 an unknown id gets:
 * "expired" and "never existed" are one answer to anyone holding an id.
 */
function readConsentChallenge(id: string): ConsentChallengeRecord | null {
  const record = consentChallenges.get(id);
  if (!record) {
    return null;
  }
  if (Date.now() - record.createdAt >= CONSENT_CHALLENGE_TTL_MS) {
    consentChallenges.delete(id);
    return null;
  }
  return record;
}

function challengeIdFromParams(req: RouteRequest): string {
  const raw = req.params?.challenge;
  return typeof raw === "string" ? raw : "";
}

// The authorize params the approval path re-reads. `scope` and `resource` ride
// along untouched so a later change to what the approval consumes does not
// silently drop a param the client sent.
const CARRIED_AUTHORIZE_PARAMS = [
  "client_id",
  "code_challenge",
  "code_challenge_method",
  "redirect_uri",
  "resource",
  "response_type",
  "scope",
  "state",
] as const;

function serializeAuthorizeParams(query: Record<string, unknown>): Record<string, string | null> {
  const params: Record<string, string | null> = {};
  for (const name of CARRIED_AUTHORIZE_PARAMS) {
    params[name] = typeof query[name] === "string" ? query[name] : null;
  }
  return params;
}

/**
 * Where the owner decides. The console renders the consent screen; this server
 * keeps the protocol. Configured with the console's public origin, defaulting
 * to the composed-mode dev origin the reference topology already assumes.
 */
function consentConsoleUrl(challenge: string): string {
  const base = process.env.PDPP_REFERENCE_ORIGIN || process.env.CONSOLE_PUBLIC_URL || "http://localhost:3000";
  const url = new URL("/consent", base);
  url.searchParams.set("challenge", challenge);
  return url.toString();
}

interface ClientResolutionCorrelation {
  requestId: string | null;
  traceId: string | null;
}

type RouteHandler = (req: RouteRequest, res: RouteResponse) => Promise<unknown>;

interface AppLike {
  get: (path: string, ...args: RouteArg<RouteHandler | MiddlewareHandler>[]) => AppLike;
  post: (path: string, ...args: RouteArg<RouteHandler | MiddlewareHandler>[]) => AppLike;
}

const OAUTH_AUTHORIZATION_ERROR_CODES: Readonly<Record<string, string>> = {
  "source.authorization_details_invalid": "invalid_authorization_details",
  undefined: "invalid_request",
};

// Shape expected by requireRegisteredRedirectUri (mirrors as-consent-ui-helpers.ts internal type).
// Widened (beyond just redirect_uris) so the picker can also resolve and
// render client identity (client-display:672-677) — the same
// `getRegisteredClient` result the redirect-URI check already fetches.
interface OAuthClient {
  readonly client_id?: string | null;
  readonly metadata?: {
    client_name?: string | null;
    client_uri?: string | null;
    logo_uri?: string | null;
    policy_uri?: string | null;
    redirect_uris?: string[];
    tos_uri?: string | null;
  } | null;
  readonly registration_mode?: string | null;
}

/**
 * Maps a resolved `OAuthClient` (from `getRegisteredClient`) into the
 * `PendingGrantRequest["client"]` shape `buildConsentClientDisplay` expects —
 * mirrors `applyRegisteredClientToPendingRequestClient` in auth.ts, which is
 * not exported for route-layer use.
 */
function toPendingGrantRequestClient(client: OAuthClient): NonNullable<PendingGrantRequest["client"]> {
  return {
    client_display: {
      logo_uri: client.metadata?.logo_uri ?? null,
      name: client.metadata?.client_name ?? null,
      policy_uri: client.metadata?.policy_uri ?? null,
      tos_uri: client.metadata?.tos_uri ?? null,
      uri: client.metadata?.client_uri ?? null,
    },
    client_id: client.client_id ?? null,
    registration_mode: client.registration_mode ?? "pre_registered_public",
  };
}

interface ConsentStoreOutput {
  authorization_url: string;
  expires_in?: number;
  request_uri: string;
}

interface ConsentStore {
  initiateGrant: (
    params: { client_id: string; authorization_details: unknown },
    opts: { baseUrl: string; nativeManifest: unknown }
  ) => Promise<ConsentStoreOutput>;
  parseRequestUri: (requestUri: string) => string | null;
}

interface PackageGrantResult {
  package_id: string;
  token: string;
}

interface IssuedCode {
  code: string;
  redirect_uri: string;
  state?: string | null;
}

// Hosted-MCP selection parsers live in hosted-mcp-selection.js. They are not
// part of ConsentPickerCapabilities (that interface covers picker-page rendering
// capabilities), so they are injected separately.
interface HostedMcpSelectionParsers {
  parseHostedMcpSelections: (raw: unknown) => Array<{ connectorId: string; connectionId: string | null }>;
  parseHostedMcpStreamSelections: (raw: unknown) => {
    bySource: Map<string, Set<string>>;
  };
}

// ─── Injected capabilities ───────────────────────────────────────────────────

export interface MountAsAuthorizeContext {
  /** Explicit AS public URL override, or null. */
  asPublicUrl: string | null;
  /** The hosted MCP source picker capabilities (rendering + registry lookups). */
  consentPickerCaps: ConsentPickerCapabilities;
  /** Safe server-side logo fetch dependencies; test-only overrides keep logo tests offline. */
  clientLogoFetchOptions?: FetchClientLogoOptions;
  /** Consent store for pending-grant lifecycle. */
  consentStore: ConsentStore;
  /** The consent/authorize UI rendering helpers. */
  consentUi: ConsentUiRenderer;
  /** Creates a hosted MCP multi-source package grant. */
  createHostedMcpGrantPackage: (args: {
    authorizationDetails: unknown[];
    clientId: string;
    connectionIds: Array<string | null>;
    /**
     * `reviewDigest` binds the final-approval digest (AS-conformance #15) onto every child grant's `grant.issued` event.
     * `grantExpiresAt` is the owner's chosen expiry, applied to continuous child grants.
     */
    opts: { reviewDigest?: string | null; grantExpiresAt?: string | null };
    sourceMetadata: Array<{ connector_display_name: string; display_name: string | null }>;
    storageBindings: Array<{ connector_id: string }>;
    subjectId: string;
  }) => Promise<PackageGrantResult>;
  /** Reads the owner CSRF token from session, setting a new one if absent. */
  ensureCsrfToken: (req: RouteRequest, res: RouteResponse) => string;
  /** Reads the Request-Id set by AS middleware for causal transport-event correlation. */
  ensureRequestId: (res: RouteResponse) => string;
  /** Retrieves a registered OAuth client by client_id, or null if not found. */
  getRegisteredClient: (clientId: string, correlation: ClientResolutionCorrelation) => Promise<OAuthClient | null>;
  /** Whether to ignore ambient PUBLIC_URL env vars when resolving the base URL. */
  ignoreAmbientPublicUrls: boolean;
  /** Issues an OAuth authorization code bound to a package device-code. */
  issueOAuthAuthorizationCodeForPackageDeviceCode: (
    deviceCode: string,
    args: { packageId: string; token: string }
  ) => Promise<IssuedCode | null>;
  /** Resolved native manifest for this server instance, or null. */
  nativeManifest: unknown;
  /**
   * Writes an OAuth error envelope and returns. `extras` is merged into the
   * top-level envelope so a resolvable client/scope condition (e.g. a stream
   * with no eligible connector instance) can name the affected stream(s) in
   * structured form, not only inside `message` prose.
   */
  oauthError: (
    res: unknown,
    status: number,
    code: string,
    message: string,
    extras?: Readonly<Record<string, unknown>>
  ) => unknown;
  /** Provider name for picker HTML rendering. */
  providerName: string;
  /** CSRF enforcement middleware. */
  requireCsrf: MiddlewareHandler;
  /** Owner-session enforcement middleware. */
  requireOwnerSession: MiddlewareHandler;
  /** Resolves the public base URL from the request and any explicit override. */
  resolvePublicUrl: (req: RouteRequest, explicitBaseUrl: string | null) => string;
  /** Hosted-MCP selection parsers (from hosted-mcp-selection.js). */
  selectionParsers: HostedMcpSelectionParsers;
  /** Stages an OAuth authorization code request (PKCE device-code shell). */
  stageOAuthAuthorizationCodeRequest: (args: {
    clientId: string;
    codeChallenge: string;
    codeChallengeMethod: string;
    deviceCode: string;
    expiresInSeconds: number;
    redirectUri: string;
    state: string | null;
  }) => Promise<void>;
}

// ─── Per-source entry builder (extracted to reduce POST handler complexity) ──

interface SourceEntryAccumulator {
  authorizationDetails: unknown[];
  connectionIds: Array<string | null>;
  /**
   * The exact decision this POST resolved, in the same shape the picker's
   * review panel displayed and digested. Accumulated from the server's own
   * manifest re-resolution, never from anything the form supplied beyond the
   * selections themselves, so the digest comparison in
   * `rejectIfHostedMcpDecisionUnbound` compares what the owner said they
   * approved against what would actually be granted.
   */
  decisionSources: Array<{ sourceKey: string; streamNames: string[] }>;
  seenChildKeys: Set<string>;
  sourceMetadata: Array<{ connector_display_name: string; display_name: string | null }>;
  sourcesWithEmptyStreams: Array<{ connectorId: string; connectionId: string | null; connectorLabel: string }>;
  storageBindings: Array<{ connector_id: string }>;
}

// Decides whether the owner's selected connection should be pinned as an
// enforceable `grant.streams[].connection_id` constraint on the issued child
// grant, versus omitted to preserve fan-in.
//
// Pin iff the owner selected a specific connection AND the connector has more
// than one active binding — i.e. the picker presented sibling connections and
// the owner disambiguated among them. When the connector has exactly one active
// binding (or none), "selecting" it is not a disambiguating choice: fan-in over
// a set of one already resolves to that connection, auto-select covers it, and
// stamping a `connection_id` would only add a brittle stored id that pressures
// existing grants without changing what the read returns. This keeps
// single-connection deployments and existing grants byte-for-byte unchanged.
//
// Pure and side-effect free so the pin policy is unit-testable in isolation.
export function shouldPinSelectedConnection(
  connectionId: string | null | undefined,
  activeBindingCount: number
): boolean {
  if (typeof connectionId !== "string" || !connectionId.trim()) {
    return false;
  }
  return activeBindingCount > 1;
}

// Returns true if the entry was added, false if it was skipped/deduped.
// Mutates acc in place. Extracted to reduce cognitive complexity of the POST handler.
async function accumulateSourceEntry(
  selection: { connectorId: string; connectionId: string | null },
  streamSelectionsBySource: Map<string, Set<string>>,
  packageAccessMode: string,
  ownerSubjectId: string,
  acc: SourceEntryAccumulator,
  caps: ConsentPickerCapabilities,
  oauthError: MountAsAuthorizeContext["oauthError"],
  res: RouteResponse,
  /** The raw POST body, read only for this source's per-stream scope inputs. */
  submittedBody: Record<string, unknown> | null | undefined
): Promise<"added" | "skipped" | "rejected"> {
  const { connectorId, connectionId } = selection;
  const manifest = await caps.getConnectorManifest(connectorId).catch(() => null);
  if (!manifest) {
    oauthError(res, 400, "invalid_request", `Unknown connector: ${connectorId}`);
    return "rejected";
  }
  const source = resolveHostedMcpSourceDescriptor(manifest);
  if (!source) {
    oauthError(res, 400, "invalid_request", `Connector ${connectorId} has no valid public source identity`);
    return "rejected";
  }

  const sourceKey = caps.hostedMcpSourceKey({ connectionId, connectorId });
  const narrowedStreamNames = resolveNarrowedStreams(manifest, sourceKey, streamSelectionsBySource);

  if (narrowedStreamNames === "deselected") {
    // Owner deliberately unchecked every declared stream — track for the
    // picker error before looking up eligibility. This keeps a forged stream
    // name from bypassing the manifest boundary or creating a package.
    acc.sourcesWithEmptyStreams.push({
      connectionId: connectionId || null,
      connectorId,
      connectorLabel: manifest.display_name || manifest.name || connectorId,
    });
    return "skipped";
  }

  // Verify the connector has at least one active connection for this owner,
  // whether or not a specific connection was selected. The picker only ever
  // renders rows for connectors the owner actually holds (see
  // `buildConnectorPickerRows`), so this rejects a stale or forged selection
  // — e.g. a source removed since the page was rendered, or a manufactured
  // connector_id — before it can reach the grant engine and hard-fail the
  // whole package with `source.authorization_details_invalid` for every
  // other legitimately-selected source in the same submission. The active
  // set also drives the pin-vs-fan-in decision below: a chosen connection is
  // only an enforceable constraint when there is more than one to choose
  // among.
  let active: ConsentPickerBinding[];
  try {
    active = await caps.listActiveBindingsForGrant({ connectorId, ownerSubjectId });
  } catch {
    oauthError(res, 500, "server_error", "Unable to verify active connection state");
    return "rejected";
  }
  const activeBindingCount = active.length;
  if (activeBindingCount === 0) {
    oauthError(res, 400, "invalid_request", `No active connection for ${connectorId}`, {
      streams: narrowedStreamNames ?? manifest.streams?.map((stream) => stream.name).filter(Boolean) ?? [],
    });
    return "rejected";
  }
  let matchedBinding: ConsentPickerBinding | null = null;
  if (connectionId) {
    // Reject silently-pinning a stale connection: the id must still be one
    // of the connector's currently active bindings.
    matchedBinding = active.find((row) => row.connectorInstanceId === connectionId) || null;
    if (!matchedBinding) {
      oauthError(res, 400, "invalid_request", `Connection ${connectionId} is not active for ${connectorId}`);
      return "rejected";
    }
  }

  const childKey = `${connectorId}|${connectionId || ""}`;
  if (acc.seenChildKeys.has(childKey)) {
    return "skipped";
  }
  acc.seenChildKeys.add(childKey);

  // Pin the validated connection onto the issued child grant only when it
  // disambiguates among sibling connections; otherwise omit it to preserve
  // fan-in. The same value already flows to the package member audit metadata
  // below via acc.connectionIds, so "what the owner saw" and "what is enforced"
  // agree when pinned.
  const pinnedConnectionId = shouldPinSelectedConnection(connectionId, activeBindingCount) ? connectionId : null;

  // Per-stream field/date narrowing, validated against this source's own
  // declaration before it can reach the grant engine. Rejecting here rather
  // than downstream means an impossible narrowing surfaces as a correction on
  // the page the owner is looking at, instead of an opaque 400 after they
  // pressed Allow. See resolveSubmittedStreamScopes.
  const scopeResult = resolveSubmittedStreamScopes(manifest, sourceKey, narrowedStreamNames, submittedBody);
  if ("error" in scopeResult) {
    oauthError(res, 400, "invalid_request", scopeResult.error.message);
    return "rejected";
  }

  acc.authorizationDetails.push(
    buildHostedMcpAuthorizationDetailForConnector(
      connectorId,
      narrowedStreamNames,
      packageAccessMode,
      pinnedConnectionId,
      source,
      scopeResult.scopes
    )
  );
  acc.storageBindings.push({ connector_id: connectorId });
  acc.connectionIds.push(connectionId || null);
  // `narrowedStreamNames === null` is the canonical wildcard: every stream
  // the manifest declares. The decision digest must name them explicitly,
  // because "all of them" is not a term the owner can review — and because a
  // manifest that gained a stream between render and submit would otherwise
  // silently widen what "all" means.
  acc.decisionSources.push({
    sourceKey: caps.hostedMcpSourceKey({ connectionId, connectorId }),
    streamNames: [
      ...(narrowedStreamNames ??
        (manifest.streams ?? []).map((stream) => stream.name).filter((name): name is string => typeof name === "string")),
    ].sort(),
  });
  acc.sourceMetadata.push({
    connector_display_name: manifest.display_name || manifest.name || connectorId,
    display_name: caps.projectBindingForWire(matchedBinding as ConsentPickerBinding)?.display_name ?? null,
  });
  return "added";
}

/**
 * Validate this source's submitted per-stream narrowing against its own
 * declaration.
 *
 * Only streams that survived selection are considered: a scope submitted for
 * a stream the owner did not check is ignored rather than rejected, because an
 * unchecked stream grants nothing and its leftover date input is noise, not an
 * attempt at anything. A scope for a stream the manifest does not declare is
 * likewise ignored — `resolveNarrowedStreams` has already bounded the grant to
 * declared names, so there is nothing for it to attach to.
 *
 * Wildcard selections (`narrowedStreamNames === null`, meaning every stream)
 * still resolve scopes by name, so narrowing survives the wildcard being
 * expanded against the retained snapshot at issuance.
 */
function resolveSubmittedStreamScopes(
  manifest: ConsentPickerManifest,
  sourceKey: string,
  narrowedStreamNames: string[] | null,
  body: Record<string, unknown> | null | undefined
): { error: StreamScopeError } | { scopes: Map<string, StreamScopeSelection> } {
  const submitted = parseSubmittedStreamScopes(body, sourceKey);
  const scopes = new Map<string, StreamScopeSelection>();
  if (submitted.size === 0) {
    return { scopes };
  }
  const selectedNames = narrowedStreamNames ? new Set(narrowedStreamNames) : null;
  for (const stream of manifest.streams ?? []) {
    if (selectedNames && !selectedNames.has(stream.name)) {
      continue;
    }
    const streamSubmission = submitted.get(stream.name);
    if (!streamSubmission) {
      continue;
    }
    const resolved = resolveStreamScopeSelection(stream, streamSubmission);
    if ("error" in resolved) {
      return { error: resolved.error };
    }
    // Only record an actual narrowing; "everything, all dates" is the default
    // and stays represented by absence.
    if (resolved.selection.fields || resolved.selection.timeRange) {
      scopes.set(stream.name, resolved.selection);
    }
  }
  return { scopes };
}

// Resolves the narrowed stream name list for a source, accounting for:
//   (a) no manifest streams  → null (wildcard preserved)
//   (b) owner deselected all → "deselected" sentinel
//   (c) all streams selected → null (canonical wildcard)
//   (d) subset selected      → the filtered list
// Extracted to reduce cognitive complexity of accumulateSourceEntry.
function resolveNarrowedStreams(
  manifest: { streams?: Array<{ name?: string }> | null } | null,
  sourceKey: string,
  streamSelectionsBySource: Map<string, Set<string>>
): string[] | null | "deselected" {
  const manifestStreamNames = Array.isArray(manifest?.streams)
    ? manifest.streams.map((s) => s.name).filter((n): n is string => typeof n === "string")
    : [];
  if (manifestStreamNames.length === 0) {
    return null; // (a)
  }

  const selectedStreamSet = streamSelectionsBySource.get(sourceKey) || new Set<string>();
  const validStreamNames = manifestStreamNames.filter((n) => selectedStreamSet.has(n));

  if (validStreamNames.length === 0) {
    return "deselected"; // (b)
  }
  if (validStreamNames.length === manifestStreamNames.length) {
    return null; // (c)
  }
  return validStreamNames; // (d)
}

// ─── PAR-redirect helper (extracted to reduce GET handler complexity) ─────────

// Initiates a pending-consent grant and redirects to its authorization_url.
// Called when authorization_details or connector_id is present on GET /oauth/authorize.
async function initiateGrantAndRedirect(
  res: RouteResponse,
  authorizationDetails: unknown[] | null,
  selectedConnectorId: string | null,
  pkce: {
    clientId: string;
    codeChallenge: string;
    codeChallengeMethod: string;
    redirectUri: string;
    state: string | null;
  },
  ctx: MountAsAuthorizeContext,
  req: RouteRequest
): Promise<unknown> {
  let details = authorizationDetails;
  if (!details) {
    const connectorId = selectedConnectorId as string;
    const manifest = await ctx.consentPickerCaps.getConnectorManifest(connectorId).catch(() => null);
    if (!manifest) {
      return ctx.oauthError(res, 400, "invalid_request", `Unknown connector: ${connectorId}`);
    }
    const source = resolveHostedMcpSourceDescriptor(manifest);
    if (!source) {
      return ctx.oauthError(
        res,
        400,
        "invalid_request",
        `Connector ${connectorId} has no valid public source identity`
      );
    }
    details = buildHostedMcpAuthorizationDetailsForConnector(connectorId, source);
  }
  const explicitBaseUrl = ctx.asPublicUrl || (ctx.ignoreAmbientPublicUrls ? null : (process.env.AS_PUBLIC_URL ?? null));
  const output = await ctx.consentStore.initiateGrant(
    { authorization_details: details, client_id: pkce.clientId },
    { baseUrl: ctx.resolvePublicUrl(req, explicitBaseUrl), nativeManifest: ctx.nativeManifest }
  );
  const deviceCode = ctx.consentStore.parseRequestUri(output.request_uri);
  await ctx.stageOAuthAuthorizationCodeRequest({
    clientId: pkce.clientId,
    codeChallenge: pkce.codeChallenge,
    codeChallengeMethod: pkce.codeChallengeMethod,
    deviceCode: deviceCode as string,
    expiresInSeconds: output.expires_in || 300,
    redirectUri: pkce.redirectUri,
    state: pkce.state,
  });
  return res.redirect(302, output.authorization_url);
}

// ─── Source-loop helper (extracted to reduce POST handler complexity) ─────────

// Iterates all picker selections, calling accumulateSourceEntry for each.
// Returns the filled accumulator, or null if any source was rejected (response already sent).
async function buildSourceAccumulator(
  selections: Array<{ connectorId: string; connectionId: string | null }>,
  streamSelectionsBySource: Map<string, Set<string>>,
  packageAccessMode: string,
  ownerSubjectId: string,
  caps: ConsentPickerCapabilities,
  oauthError: MountAsAuthorizeContext["oauthError"],
  res: RouteResponse,
  submittedBody: Record<string, unknown> | null | undefined
): Promise<SourceEntryAccumulator | null> {
  const acc: SourceEntryAccumulator = {
    authorizationDetails: [],
    connectionIds: [],
    decisionSources: [],
    seenChildKeys: new Set(),
    sourceMetadata: [],
    sourcesWithEmptyStreams: [],
    storageBindings: [],
  };
  for (const selection of selections) {
    // biome-ignore lint/performance/noAwaitInLoops: Work is intentionally sequential to preserve ordering and state transitions.
    const result = await accumulateSourceEntry(
      selection,
      streamSelectionsBySource,
      packageAccessMode,
      ownerSubjectId,
      acc,
      caps,
      oauthError,
      res,
      submittedBody
    );
    if (result === "rejected") {
      return null;
    }
  }
  return acc;
}

// ─── Package auth-code issuance (extracted to reduce POST handler complexity) ─

// Stages a package device-code, issues an auth code, and redirects the client.
// Extracted to reduce cognitive complexity of the POST /oauth/authorize/mcp-package handler.
async function issuePackageAuthCodeRedirect(
  res: RouteResponse,
  packageResult: PackageGrantResult,
  pkce: {
    clientId: string;
    codeChallenge: string;
    codeChallengeMethod: string;
    redirectUri: string;
    state: string | null;
  },
  ctx: Pick<
    MountAsAuthorizeContext,
    "stageOAuthAuthorizationCodeRequest" | "issueOAuthAuthorizationCodeForPackageDeviceCode" | "oauthError"
  >
): Promise<unknown> {
  const deviceCode = `mcpdev_${randomBytes(16).toString("hex")}`;
  await ctx.stageOAuthAuthorizationCodeRequest({
    clientId: pkce.clientId,
    codeChallenge: pkce.codeChallenge,
    codeChallengeMethod: pkce.codeChallengeMethod,
    deviceCode,
    expiresInSeconds: 300,
    redirectUri: pkce.redirectUri,
    state: pkce.state,
  });
  const issued = await ctx.issueOAuthAuthorizationCodeForPackageDeviceCode(deviceCode, {
    packageId: packageResult.package_id,
    token: packageResult.token,
  });
  if (!issued) {
    return ctx.oauthError(res, 500, "server_error", "Failed to issue authorization code for package");
  }
  const redirectUrl = new URL(issued.redirect_uri);
  redirectUrl.searchParams.set("code", issued.code);
  if (issued.state) {
    redirectUrl.searchParams.set("state", issued.state);
  }
  return res.redirect(302, redirectUrl.toString());
}

// Resolves the package access mode from the raw body value.
// Returns the mode string, or null if the value is unknown (caller should reject).
function resolvePackageAccessMode(rawAccessMode: string): string | null {
  if (!rawAccessMode) {
    return HOSTED_MCP_PICKER_DEFAULT_ACCESS_MODE;
  }
  if (!HOSTED_MCP_PICKER_SUPPORTED_ACCESS_MODES.has(rawAccessMode)) {
    return null;
  }
  return rawAccessMode;
}

function hasSubmittedSelectionInput(raw: unknown): boolean {
  if (typeof raw === "string") {
    return raw.trim().length > 0;
  }
  if (Array.isArray(raw)) {
    return raw.some((value) => hasSubmittedSelectionInput(value));
  }
  if (raw && typeof raw === "object") {
    return Object.values(raw as Record<string, unknown>).some((value) => hasSubmittedSelectionInput(value));
  }
  return false;
}

/**
 * Rejects a picker submission with an owner-readable reason, in whichever
 * medium the caller speaks.
 *
 * There are two approving surfaces now — the server-rendered form and the
 * console's challenge API — and they need the SAME rejection decisions
 * (`decision`, below) delivered two different ways. Re-rendering the picker
 * HTML into a JSON response would hand the console a page it cannot use; so
 * the medium is a property of the request, not of the validation.
 *
 * `req.wantsJson` is set only by the challenge routes, so the form path's
 * behavior is byte-identical to before: a 400 carrying the re-rendered picker
 * with the message inline, CSRF token refreshed, and the owner's inputs
 * preserved.
 */
async function renderHostedMcpPickerValidationPage(
  req: RouteRequest,
  res: RouteResponse,
  ctx: Pick<MountAsAuthorizeContext, "consentPickerCaps" | "consentUi" | "ensureCsrfToken" | "providerName">,
  message: string,
  client: OAuthClient | null = null
): Promise<unknown> {
  if (req.wantsJson) {
    // Same status and same owner-facing sentence, as a typed envelope. The
    // console renders this beside the controls the owner just used, so it
    // needs the reason, not a replacement page.
    return res.status(400).json({ error: "invalid_request", error_description: message });
  }
  // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
  const ownerSubjectId = req?.ownerAuth?.subjectId || "owner_local";
  const csrfToken = ctx.ensureCsrfToken(req, res);
  const html = await renderHostedMcpSourceSelection(
    ownerSubjectId,
    req.body || {},
    csrfToken,
    ctx.providerName,
    ctx.consentPickerCaps,
    ctx.consentUi,
    { client: client ? toPendingGrantRequestClient(client) : null, validationError: message }
  );
  return res.status(400).send(html);
}

function rejectMissingHostedMcpSelection(
  req: RouteRequest,
  res: RouteResponse,
  ctx: Pick<
    MountAsAuthorizeContext,
    "consentPickerCaps" | "consentUi" | "ensureCsrfToken" | "oauthError" | "providerName"
  >,
  rawSelection: unknown,
  client: OAuthClient | null = null
): Promise<unknown> | unknown {
  if (hasSubmittedSelectionInput(rawSelection)) {
    return ctx.oauthError(res, 400, "invalid_request", "At least one source must be selected");
  }
  return renderHostedMcpPickerValidationPage(
    req,
    res,
    ctx,
    "Choose at least one data type to continue.",
    client
  );
}

// ─── Stale-review-revision rejection ───────────────────────────────────────
//
// The picker GET stamps a `review_digest` hidden field over exactly what it
// rendered as choosable (see `resolveHostedMcpPickerSnapshotDigest` in
// as-consent-ui-helpers.ts). Every real hosted-MCP client (ChatGPT, Claude,
// any MCP connector) reaches the POST only via that GET, so every real
// submission carries one. Before any source is validated or accumulated,
// re-resolve that same snapshot FRESH — a real second read of connector
// manifests and active bindings, not a reuse of anything from the GET — and
// require the freshly computed digest to match what the POST carried.
// Reject if the carried digest is present but tampered/mismatched, or if the
// fresh re-resolve itself fails: a failed re-resolve is not evidence the
// original digest was still valid, so it must not silently pass through to
// minting. On rejection: typed re-render with a digest for the CURRENT
// state (so the owner's next submission binds to what's actually there
// now), nothing minted, no side effect has run yet.
//
// A submission with NO `review_digest` field at all skips this check
// entirely rather than being rejected as stale — "absent" and "stale" are
// different failures with different existing contracts (a request missing
// required picker fields already fails downstream, e.g.
// `rejectMissingHostedMcpSelection`; a request whose active-binding lookup
// itself fails already has its own typed 500 in `accumulateSourceEntry`).
// Conflating "never carried a digest" with "carried a stale one" would
// duplicate and reshape those existing, independently-tested error
// contracts. This keeps the guard strictly additive: it can only make a
// request that DID carry a digest fail closed when that digest turns out
// to be wrong; it never changes what happens to a request that never
// claimed to have reviewed anything.
async function rejectIfHostedMcpReviewDigestStale(
  req: RouteRequest,
  res: RouteResponse,
  body: Record<string, unknown>,
  ownerSubjectId: string,
  client: OAuthClient,
  ctx: Pick<MountAsAuthorizeContext, "consentPickerCaps" | "consentUi" | "ensureCsrfToken" | "providerName">
): Promise<boolean> {
  const carriedDigest = typeof body.review_digest === "string" ? body.review_digest : null;
  if (!carriedDigest) {
    return false;
  }
  const clientDisplay = buildConsentClientDisplay(toPendingGrantRequestClient(client), ctx.consentUi);
  let freshDigest: string;
  try {
    freshDigest = await resolveHostedMcpPickerSnapshotDigest(ctx.consentPickerCaps, ownerSubjectId, clientDisplay);
  } catch {
    await renderHostedMcpPickerValidationPage(
      req,
      res,
      ctx,
      "Unable to verify this request is still current. Review and approve again.",
      client
    );
    return true;
  }
  if (carriedDigest !== freshDigest) {
    await renderHostedMcpPickerValidationPage(
      req,
      res,
      ctx,
      "This request changed since you loaded the page — review and approve again.",
      client
    );
    return true;
  }
  return false;
}

// Builds the package grant and issues the auth code redirect.
// Extracted to reduce cognitive complexity of the POST handler.
async function buildPackageAndRedirect(
  req: RouteRequest,
  res: RouteResponse,
  acc: SourceEntryAccumulator,
  pkce: {
    clientId: string;
    codeChallenge: string;
    codeChallengeMethod: string;
    redirectUri: string;
    state: string | null;
  },
  ownerSubjectId: string,
  ctx: Pick<
    MountAsAuthorizeContext,
    | "createHostedMcpGrantPackage"
    | "consentPickerCaps"
    | "consentUi"
    | "ensureCsrfToken"
    | "issueOAuthAuthorizationCodeForPackageDeviceCode"
    | "oauthError"
    | "providerName"
    | "stageOAuthAuthorizationCodeRequest"
  >,
  client: OAuthClient | null,
  // Required, with no default: a default would silently disable the approval
  // binding for any future caller that forgot it — the exact fail-open shape
  // this check exists to remove.
  approval: { body: Record<string, unknown>; packageAccessMode: string },
  /** Owner-chosen grant expiry; null means no scheduled end date. */
  grantExpiresAt: string | null = null
): Promise<unknown> {
  const { body, packageAccessMode } = approval;
  if (acc.sourcesWithEmptyStreams.length > 0) {
    // A checked source without checked streams is ambiguous owner intent. Re-render
    // the picker instead of silently dropping it or returning a raw JSON error.
    const labels = acc.sourcesWithEmptyStreams.map((e) => e.connectorLabel).join(", ");
    return renderHostedMcpPickerValidationPage(
      req,
      res,
      ctx,
      labels
        ? `Choose data from ${labels}, or clear the source.`
        : "Choose data from each selected source, or clear the source.",
      client
    );
  }
  if (acc.authorizationDetails.length === 0) {
    return renderHostedMcpPickerValidationPage(req, res, ctx, "Choose at least one data source to continue.", client);
  }

  // Approval binding (spec-core.md:873-877, :881-885, AS-conformance #15).
  //
  // The owner's submitted `decision_digest` covers the exact terms the review
  // panel displayed. Recompute it here from the decision this request
  // independently RESOLVED — the manifests it re-read, the streams it
  // narrowed to — and require a match before anything is minted. A missing
  // digest fails closed: an approval that never claimed to have reviewed
  // anything is exactly the approval that must not mint a grant.
  //
  // This is the check the old guard could not perform. `review_digest` covers
  // the menu of available choices, so checking three streams or thirty
  // produced the same value; and its handler opened with
  // `if (!carriedDigest) return false;`, so omitting the field skipped the
  // check entirely rather than failing.
  const submittedDecisionDigest = typeof body.decision_digest === "string" ? body.decision_digest.trim() : "";
  const resolvedDecisionDigest = computeHostedMcpDecisionDigest({
    accessMode: packageAccessMode,
    clientId: pkce.clientId,
    sources: acc.decisionSources,
  });
  if (submittedDecisionDigest !== resolvedDecisionDigest) {
    return renderHostedMcpPickerValidationPage(
      req,
      res,
      ctx,
      submittedDecisionDigest
        ? "This request changed since you reviewed it. Check what you're allowing and approve again."
        : "We couldn't confirm what you approved. Review this request and approve again.",
      client
    );
  }

  // The audit-trail digest over the full resolved authorization_details —
  // richer than the decision digest (it carries resolved instance_ids and the
  // minted entries verbatim) and bound into every child grant's `grant.issued`
  // spine event, so "what was resolved" stays reconstructable.
  const reviewDigest = computeHostedMcpPickerReviewDigest({
    authorizationDetails: acc.authorizationDetails,
    clientId: pkce.clientId,
  });

  const packageResult = await ctx.createHostedMcpGrantPackage({
    authorizationDetails: acc.authorizationDetails,
    clientId: pkce.clientId,
    connectionIds: acc.connectionIds,
    opts: { grantExpiresAt, reviewDigest },
    sourceMetadata: acc.sourceMetadata,
    storageBindings: acc.storageBindings,
    subjectId: ownerSubjectId,
  });
  return issuePackageAuthCodeRedirect(res, packageResult, pkce, ctx);
}

// ─── Request-intake resolution (extracted to reduce POST handler complexity) ─

interface McpPackageIntake {
  client: OAuthClient;
  packageAccessMode: string;
  selections: Array<{ connectorId: string; connectionId: string | null }>;
  streamSelectionsBySource: Map<string, Set<string>>;
}

// Resolves the client, decodes the picker selections/streams, and validates
// the access_mode for the POST /oauth/authorize/mcp-package body. Returns
// null once it has already written a response (unknown client, missing
// selection, or an unsupported access_mode) — the caller must stop.
// Extracted to reduce cognitive complexity of the POST handler.
async function resolveMcpPackageIntake(
  req: RouteRequest,
  res: RouteResponse,
  body: Record<string, unknown>,
  pkce: { clientId: string; redirectUri: string },
  ctx: Pick<
    MountAsAuthorizeContext,
    | "consentPickerCaps"
    | "consentUi"
    | "ensureCsrfToken"
    | "ensureRequestId"
    | "getRegisteredClient"
    | "oauthError"
    | "providerName"
    | "selectionParsers"
  >
): Promise<McpPackageIntake | null> {
  const client = await ctx.getRegisteredClient(pkce.clientId, {
    requestId: ctx.ensureRequestId(res),
    traceId: null,
  });
  if (!client) {
    ctx.oauthError(res, 400, "invalid_client", "Unknown client_id");
    return null;
  }
  requireRegisteredRedirectUri(client, pkce.redirectUri);

  const selections = ctx.selectionParsers.parseHostedMcpSelections(body.selection);
  if (selections.length === 0) {
    await rejectMissingHostedMcpSelection(req, res, ctx, body.selection, client);
    return null;
  }

  // Per-source stream subsets submitted by the picker. Each entry is a
  // base64url(JSON) payload identifying `(connector, connection, stream)`;
  // stream entries whose source was not also checked are ignored so an
  // orphaned stream toggle cannot smuggle authority into a deselected source.
  const { bySource: streamSelectionsBySource } = ctx.selectionParsers.parseHostedMcpStreamSelections(body.stream);

  // Package-level access mode: absent → "continuous" default, unknown → 400.
  const rawAccessMode = typeof body.access_mode === "string" ? body.access_mode.trim() : "";
  const packageAccessMode = resolvePackageAccessMode(rawAccessMode);
  if (!packageAccessMode) {
    ctx.oauthError(res, 400, "invalid_request", "access_mode must be 'single_use' or 'continuous'");
    return null;
  }

  return { client, packageAccessMode, selections, streamSelectionsBySource };
}

async function handleHostedMcpPackageApproval(
  req: RouteRequest,
  res: RouteResponse,
  ctx: MountAsAuthorizeContext
): Promise<unknown> {
  const body = req.body || {};
  const clientId = requireAuthorizeString(body, "client_id");
  const redirectUri = requireAuthorizeString(body, "redirect_uri");
  const responseType = requireAuthorizeString(body, "response_type");
  const codeChallenge = requireAuthorizeString(body, "code_challenge");
  const codeChallengeMethod = requireAuthorizeString(body, "code_challenge_method");
  const state = typeof body.state === "string" ? body.state : null;
  validateAuthorizePkce({ codeChallenge, codeChallengeMethod, responseType });

  const intake = await resolveMcpPackageIntake(req, res, body, { clientId, redirectUri }, ctx);
  if (!intake) {
    return;
  }
  const { client, selections, streamSelectionsBySource, packageAccessMode } = intake;

  // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
  const ownerSubjectId = req?.ownerAuth?.subjectId || "owner_local";

  if (await rejectIfHostedMcpReviewDigestStale(req, res, body, ownerSubjectId, client, ctx)) {
    return;
  }

  const acc = await buildSourceAccumulator(
    selections,
    streamSelectionsBySource,
    packageAccessMode,
    ownerSubjectId,
    ctx.consentPickerCaps,
    ctx.oauthError,
    res,
    body
  );
  if (!acc) {
    return;
  }

  const expiryResult = resolveGrantExpiry(body.grant_expiry, packageAccessMode);
  if ("error" in expiryResult) {
    return ctx.oauthError(res, 400, "invalid_request", expiryResult.error);
  }

  return await buildPackageAndRedirect(
    req,
    res,
    acc,
    { clientId, codeChallenge, codeChallengeMethod, redirectUri, state },
    ownerSubjectId,
    ctx,
    client,
    { body, packageAccessMode },
    expiryResult.expiresAt
  );
}

/**
 * Runs a redirect-issuing handler and captures its redirect instead of
 * emitting it, so the same handler can serve both a form POST (302) and the
 * challenge API (`{ redirect_url }` for the console to follow).
 *
 * This is what keeps the challenge routes from forking the protocol: accept
 * and reject run the EXACT approval and refusal code the form POST runs —
 * every validation, the grant creation, the audit events — and differ only in
 * how the final redirect reaches the browser. A second implementation of the
 * mint path is the bug this avoids.
 *
 * Errors are not captured: `ctx.oauthError` writes through to the real `res`,
 * so a rejected approval still produces its own typed envelope and this
 * returns no URL.
 */
function captureRedirectResponse(res: RouteResponse): { response: RouteResponse; redirectUrl: () => string | null } {
  let redirectUrl: string | null = null;
  return {
    redirectUrl: () => redirectUrl,
    response: {
      ...res,
      redirect: (_status: number, url: string) => {
        redirectUrl = url;
        return undefined;
      },
    },
  };
}

function submittedStrings(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string");
  }
  return typeof value === "string" ? [value] : [];
}

/**
 * Reads the console's `stream_range` object — `{ "<sourceKey>:<stream>": {
 * since?, until? } }` — into a map keyed by the model's own stream id.
 *
 * Shape-checking only. Whether a date is VALID, whether the stream even has a
 * time axis to narrow, and whether `since` precedes `until` are all decided
 * downstream by `resolveStreamScopeSelection` against the manifest's own
 * declaration; duplicating any of that here would create a second opinion
 * about the same question.
 */
function submittedStreamRanges(value: unknown): Map<string, { since?: string; until?: string }> {
  const ranges = new Map<string, { since?: string; until?: string }>();
  if (!(value && typeof value === "object") || Array.isArray(value)) {
    return ranges;
  }
  for (const [streamId, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!(raw && typeof raw === "object")) {
      continue;
    }
    const { since, until } = raw as { since?: unknown; until?: unknown };
    const entry: { since?: string; until?: string } = {};
    if (typeof since === "string" && since.trim()) {
      entry.since = since.trim();
    }
    if (typeof until === "string" && until.trim()) {
      entry.until = until.trim();
    }
    if (entry.since || entry.until) {
      ranges.set(streamId, entry);
    }
  }
  return ranges;
}

function submittedStreamFields(value: unknown): Map<string, string[]> {
  const fields = new Map<string, string[]>();
  if (!(value && typeof value === "object") || Array.isArray(value)) {
    return fields;
  }
  for (const [streamId, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(raw)) {
      continue;
    }
    fields.set(
      streamId,
      raw.filter((field): field is string => typeof field === "string" && field.trim().length > 0).map((field) => field.trim())
    );
  }
  return fields;
}

/**
 * Translates the console's decision into the body the form POST handler
 * already validates.
 *
 * This is a TRANSLATION, not a validation: it maps `source_id` / `stream`
 * (owner-facing ids the challenge model published) onto the opaque
 * `selection` / `stream` encodings the approval path expects, and passes
 * `access_mode`, `grant_expiry`, `review_digest`, and `decision_digest`
 * straight through. Everything that decides whether this approval is
 * ALLOWED — digest freshness, access-mode vocabulary, expiry bounds, stream
 * eligibility — is checked downstream against a fresh resolve, exactly as it
 * is for the form POST.
 *
 * Two consequences are deliberate:
 *
 *  - A `source_id` or `stream` the model did not publish maps to nothing and
 *    is dropped, so a tampered id cannot widen the grant. It can only narrow
 *    it, which the owner is always entitled to do.
 *
 *  - `decision_digest` is the CONSOLE's, never recomputed here. The whole
 *    point of AS-conformance #15 is that the approving surface commits to
 *    what it displayed and the AS independently recomputes it from what it
 *    resolved; a server-minted digest would always match its own
 *    recomputation and bind nothing.
 */
async function buildChallengeApprovalBody(
  challenge: ConsentChallengeRecord,
  submitted: Record<string, unknown>,
  ctx: MountAsAuthorizeContext
): Promise<Record<string, unknown>> {
  const model = await buildHostedMcpConsentChallengeModel(
    challenge.id,
    challenge.ownerSubjectId,
    ctx.consentPickerCaps,
    ctx.consentUi,
    toPendingGrantRequestClient(challenge.client),
    challenge.authorizeParams.redirect_uri,
    ctx.clientLogoFetchOptions
  );
  const chosenSourceIds = new Set(submittedStrings(submitted.source_id));
  const chosenStreamIds = new Set(submittedStrings(submitted.stream));
  const fields = submittedStreamFields(submitted.stream_fields);
  const ranges = submittedStreamRanges(submitted.stream_range);

  const selection: string[] = [];
  const stream: string[] = [];
  // Per-stream data ranges, emitted as the flat `narrow_since_/narrow_until_`
  // keys `parseSubmittedStreamScopes` already reads. Translating into the form
  // vocabulary rather than adding a second one means the console's dates go
  // through the SAME declaration-checked path as the form's — stamped with the
  // manifest's own `consent_time_field`, rejected if the stream declares no
  // time axis — instead of a parallel route that could diverge.
  const scopeInputs: Record<string, string | string[]> = {};
  for (const source of model.sources) {
    if (!chosenSourceIds.has(source.id)) {
      continue;
    }
    selection.push(source.selectionValue);
    for (const modelStream of source.streams) {
      if (!chosenStreamIds.has(modelStream.id)) {
        continue;
      }
      stream.push(modelStream.selectionValue);
      const selectedFields = fields.get(modelStream.id);
      if (selectedFields) {
        scopeInputs[scopeFieldsInputName(source.id, modelStream.name)] = selectedFields;
      }
      // Keyed by the model's own `stream.id`, so a range for a stream the
      // owner did not choose is ignored rather than applied — the same
      // posture resolveSubmittedStreamScopes takes for the form.
      const range = ranges.get(modelStream.id);
      if (range?.since) {
        scopeInputs[scopeSinceInputName(source.id, modelStream.name)] = range.since;
      }
      if (range?.until) {
        scopeInputs[scopeUntilInputName(source.id, modelStream.name)] = range.until;
      }
    }
  }

  return {
    ...challenge.authorizeParams,
    ...scopeInputs,
    access_mode: submitted.access_mode,
    decision_digest: submitted.decision_digest,
    grant_expiry: submitted.grant_expiry,
    review_digest: submitted.review_digest,
    selection,
    stream,
  };
}

// ─── Refusal (RFC 6749 §4.1.2.1) ─────────────────────────────────────────────
//
// When the owner declines, the AS MUST redirect back to the client's
// `redirect_uri` with `error=access_denied` and the original `state`. Before
// this route existed, the reference implementation could not return an OAuth
// error to a client at all — both redirect builders set only `code` and
// `state`, so an owner who refused had no action to take but close the tab,
// leaving the client waiting for a response that never came.
//
// `/consent/deny` does exist, but it operates on a pending-consent row that
// the picker flow never writes (the picker mints straight from its POST), so
// it cannot serve this surface. The refusal is validated exactly as hard as
// an approval: same owner session, same CSRF token, same client and
// redirect_uri registration checks. An unregistered redirect_uri must never
// receive a redirect, error or otherwise — that is an open-redirect vector,
// and the check is what makes it safe to echo the client's own URI back.
async function handleHostedMcpCancel(
  req: RouteRequest,
  res: RouteResponse,
  ctx: Pick<MountAsAuthorizeContext, "ensureRequestId" | "getRegisteredClient" | "oauthError">
): Promise<unknown> {
  const body = req.body || {};
  const clientId = requireAuthorizeString(body, "client_id");
  const redirectUri = requireAuthorizeString(body, "redirect_uri");
  const state = typeof body.state === "string" ? body.state : null;

  const client = await ctx.getRegisteredClient(clientId, {
    requestId: ctx.ensureRequestId(res),
    traceId: null,
  });
  if (!client) {
    return ctx.oauthError(res, 400, "invalid_client", "Unknown client_id");
  }
  // Throws `invalid_request` (caught by the route's handler) rather than
  // redirecting, so a forged redirect_uri never becomes a redirect target.
  requireRegisteredRedirectUri(client, redirectUri);

  const redirectUrl = new URL(redirectUri);
  redirectUrl.searchParams.set("error", "access_denied");
  redirectUrl.searchParams.set("error_description", "The owner denied the request");
  if (state) {
    redirectUrl.searchParams.set("state", state);
  }
  return res.redirect(302, redirectUrl.toString());
}

// ─── Route mount ─────────────────────────────────────────────────────────────

export function mountAsAuthorize(app: AppLike, ctx: MountAsAuthorizeContext): void {
  // GET /oauth/authorize
  //
  // Entry point for the OAuth authorization flow. Three paths:
  //   1. No authorization_details and no connector_id — show the hosted MCP
  //      multi-source picker page (consentPickerCaps populates the rows).
  //   2. authorization_details present — PAR-redirect path; initiate a pending
  //      grant and redirect to its authorization_url.
  //   3. connector_id present — shortcut for single-source connector grant;
  //      build authorization_details synthetically and take path 2.
  app.get("/oauth/authorize", ctx.requireOwnerSession, async (req: RouteRequest, res: RouteResponse) => {
    try {
      const clientId = requireAuthorizeString(req.query, "client_id");
      const redirectUri = requireAuthorizeString(req.query, "redirect_uri");
      const responseType = requireAuthorizeString(req.query, "response_type");
      const codeChallenge = requireAuthorizeString(req.query, "code_challenge");
      const codeChallengeMethod = requireAuthorizeString(req.query, "code_challenge_method");
      // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
      const state = typeof req.query?.state === "string" ? req.query.state : null;
      validateAuthorizePkce({ codeChallenge, codeChallengeMethod, responseType });

      const client = await ctx.getRegisteredClient(clientId, {
        requestId: ctx.ensureRequestId(res),
        traceId: null,
      });
      if (!client) {
        return ctx.oauthError(res, 400, "invalid_client", "Unknown client_id");
      }
      requireRegisteredRedirectUri(client, redirectUri);

      const authorizationDetails = parseAuthorizeAuthorizationDetails(req.query);
      const rawConnectorId =
        // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
        typeof req.query?.connector_id === "string" && req.query.connector_id.trim()
          ? req.query.connector_id.trim()
          : null;
      // Normalize at the boundary: a URL-shaped first-party connector id
      // (e.g. `https://registry.pdpp.dev/connectors/gmail`) must resolve to
      // its canonical short key (`gmail`) so the pending consent and issued
      // grant store a canonical connector_id, not a registry URL. Unknown or
      // custom ids are preserved as-is so third-party connectors still work.
      const selectedConnectorId = rawConnectorId
        ? (ctx.consentPickerCaps.canonicalConnectorKey(rawConnectorId) ?? rawConnectorId)
        : null;

      if (!(authorizationDetails || selectedConnectorId)) {
        // The hosted-MCP picker branch: the client named no sources, so the
        // owner chooses. Park the request under an opaque challenge id and
        // hand the decision to the console, which renders the consent screen
        // and posts the result back to the challenge API below.
        //
        // No render model is built here. The model is resolved fresh on the
        // GET the console makes, so what the owner sees reflects their
        // connections at the moment they look — not at the moment the client
        // happened to redirect.
        // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
        const ownerSubjectId = req?.ownerAuth?.subjectId || "owner_local";
        const now = Date.now();
        sweepConsentChallenges(now);
        const id = `cc_${randomBytes(18).toString("base64url")}`;
        consentChallenges.set(id, {
          authorizeParams: serializeAuthorizeParams(req.query),
          client,
          createdAt: now,
          id,
          ownerSubjectId,
        });
        return res.redirect(302, consentConsoleUrl(id));
      }

      return await initiateGrantAndRedirect(
        res,
        authorizationDetails,
        selectedConnectorId,
        { clientId, codeChallenge, codeChallengeMethod, redirectUri, state },
        ctx,
        req
      );
    } catch (err) {
      if (err instanceof ActiveBindingLookupError) {
        return ctx.oauthError(res, 500, "server_error", "Unable to load active connection state");
      }
      const errorCode = (err as { code?: string }).code;
      return ctx.oauthError(
        res,
        400,
        OAUTH_AUTHORIZATION_ERROR_CODES[String(errorCode)] ?? String(errorCode),
        (err as Error).message || "Authorization request rejected"
      );
    }
  });

  // POST /oauth/authorize/mcp-package/cancel
  //
  // The owner's refusal. Redirects to the client's registered redirect_uri
  // with `error=access_denied` and the original `state` (RFC 6749 §4.1.2.1).
  // Nothing is minted and no grant state is touched — the picker never wrote
  // any.
  app.post(
    "/oauth/authorize/mcp-package/cancel",
    ctx.requireOwnerSession,
    ctx.requireCsrf,
    async (req: RouteRequest, res: RouteResponse) => {
      try {
        return await handleHostedMcpCancel(req, res, ctx);
      } catch (err) {
        return ctx.oauthError(
          res,
          400,
          (err as { code?: string }).code || "invalid_request",
          (err as Error).message || "Authorization refusal rejected"
        );
      }
    }
  );

  // POST /oauth/authorize/mcp-package
  //
  // Hosted MCP multi-source consent POST. The picker submits checked
  // `selection=` values as opaque base64url(JSON) payloads — see
  // server/hosted-mcp-selection.js — plus the PKCE-mirrored authorize
  // params. The handler:
  //   1. Validates the PKCE/authorize params (same shape as GET /oauth/authorize).
  //   2. Decodes each selection structurally to one source-bounded
  //      authorization_details[] entry. No delimiter splitting; URL-shaped
  //      connector ids cannot collapse.
  //   3. Calls createHostedMcpGrantPackage: one independent child grant per source
  //      plus a single package-bound access token.
  //   4. Stages a package-bound OAuth authorization code and redirects the
  //      client back to its redirect_uri with `code=...`.
  // Spec: openspec/changes/canonicalize-connector-keys/specs/agent-consent-bundling/spec.md
  app.post(
    "/oauth/authorize/mcp-package",
    ctx.requireOwnerSession,
    ctx.requireCsrf,
    async (req: RouteRequest, res: RouteResponse) => {
      try {
        return await handleHostedMcpPackageApproval(req, res, ctx);
      } catch (err) {
        const { streams } = err as { streams?: readonly string[] };
        return ctx.oauthError(
          res,
          400,
          (err as { code?: string }).code || "invalid_request",
          (err as Error).message || "Hosted MCP package authorization rejected",
          Array.isArray(streams) && streams.length > 0 ? { streams } : undefined
        );
      }
    }
  );

  // ─── Consent challenge API ─────────────────────────────────────────────────
  //
  // The console's half of the handoff. Every route here is owner-session
  // authenticated, and both mutating routes additionally require CSRF — the
  // same posture as the form POSTs they stand in for. Owner auth alone is not
  // enough for a state-changing request reachable from a browser: without the
  // CSRF check, a page on another origin could drive an approval using the
  // owner's ambient cookie.
  //
  // An unknown, expired, or already-consumed challenge is one answer — 404 —
  // to anyone holding an id.

  app.get(
    "/oauth/authorize/consent-challenges/:challenge",
    ctx.requireOwnerSession,
    async (req: RouteRequest, res: RouteResponse) => {
      const challenge = readConsentChallenge(challengeIdFromParams(req));
      if (!challenge) {
        return ctx.oauthError(res, 404, "not_found", "Unknown or expired consent challenge");
      }
      const model = await buildHostedMcpConsentChallengeModel(
        challenge.id,
        challenge.ownerSubjectId,
        ctx.consentPickerCaps,
        ctx.consentUi,
        toPendingGrantRequestClient(challenge.client),
        challenge.authorizeParams.redirect_uri,
        ctx.clientLogoFetchOptions
      );
      return res.json(model);
    }
  );

  app.post(
    "/oauth/authorize/consent-challenges/:challenge/accept",
    ctx.requireOwnerSession,
    ctx.requireCsrf,
    async (req: RouteRequest, res: RouteResponse) => {
      const id = challengeIdFromParams(req);
      try {
        const challenge = readConsentChallenge(id);
        if (!challenge) {
          return ctx.oauthError(res, 404, "not_found", "Unknown or expired consent challenge");
        }
        // Consume BEFORE minting. An approval is single-use: two concurrent
        // accepts on one challenge must not both reach the mint path and
        // issue two grants for one authorize request. If the approval is
        // rejected downstream the challenge is gone and the owner restarts
        // from the client — the safe direction to fail.
        consentChallenges.delete(id);
        const body = await buildChallengeApprovalBody(challenge, req.body || {}, ctx);
        const { response, redirectUrl } = captureRedirectResponse(res);
        await handleHostedMcpPackageApproval({ ...req, body, wantsJson: true }, response, ctx);
        const url = redirectUrl();
        if (!url) {
          // The approval path already wrote its own typed error envelope
          // (stale digest, empty selection, bad expiry, ...) through to the
          // real response. Returning here leaves that as the reply.
          return;
        }
        return res.json({ redirect_url: url });
      } catch (err) {
        const { streams } = err as { streams?: readonly string[] };
        return ctx.oauthError(
          res,
          400,
          (err as { code?: string }).code || "invalid_request",
          (err as Error).message || "Consent challenge approval rejected",
          Array.isArray(streams) && streams.length > 0 ? { streams } : undefined
        );
      }
    }
  );

  app.post(
    "/oauth/authorize/consent-challenges/:challenge/reject",
    ctx.requireOwnerSession,
    ctx.requireCsrf,
    async (req: RouteRequest, res: RouteResponse) => {
      const id = challengeIdFromParams(req);
      try {
        const challenge = readConsentChallenge(id);
        if (!challenge) {
          return ctx.oauthError(res, 404, "not_found", "Unknown or expired consent challenge");
        }
        consentChallenges.delete(id);
        // The refusal params are the server's own record of the authorize
        // request, never the owner's browser: `handleHostedMcpCancel` still
        // re-resolves the client and re-checks the redirect_uri against its
        // registration, so this cannot be steered into an open redirect.
        const { response, redirectUrl } = captureRedirectResponse(res);
        await handleHostedMcpCancel({ ...req, body: { ...challenge.authorizeParams }, wantsJson: true }, response, ctx);
        const url = redirectUrl();
        if (!url) {
          return;
        }
        return res.json({ redirect_url: url });
      } catch (err) {
        return ctx.oauthError(
          res,
          400,
          (err as { code?: string }).code || "invalid_request",
          (err as Error).message || "Consent challenge refusal rejected"
        );
      }
    }
  );
}
