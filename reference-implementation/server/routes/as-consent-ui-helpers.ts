// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Pure rendering and normalization helpers for the AS consent/authorize UI.
//
// Extracted from `server/index.js` per the OpenSpec change
// `split-reference-server-by-route-family`. These are the presentational and
// input-normalization functions that sit in front of the consent and authorize
// route handlers. They carry no route registration, no auth enforcement, no
// CSRF, no state writes, and no closure captures from `buildAsApp`.
//
// Covered by the consent/authorize route test suites:
//   test/hosted-mcp-oauth.test.js
//   test/hosted-mcp-picker-canonical-collapse.test.js
//   test/security-consent-risk-disclosure.test.js
//   test/security-consent-token-handoff.test.js

import { base64UrlSha256 } from "../oauth-substrate/primitives.ts";

// Hosted-UI rendering surface (injected to avoid importing .js directly).

export interface ConsentUiRenderer {
  escapeHtml: (input: unknown) => string;
  renderActionRow: (
    actions: Array<{
      label: string;
      variant: string;
      method: string;
      action: string;
      hidden: Array<{ name: string; value: string }>;
    }>
  ) => string;
  renderHostedDocument: (opts: { title: string; providerName: string; body: string }) => string;
  renderKeyValueList: (items: Array<{ label: string; value?: unknown; html?: string }>) => string;
  renderPageIntro: (opts: { eyebrow: string; title: string; lede?: string }) => string;
  renderResultState: (opts: { tone: string; title: string; body: string }) => string;
  renderSurface: (opts: { surface?: string; ariaLabel?: string; children: string }) => string;
}

// Picker data capabilities (injected; async store reads).

export interface ConsentPickerCapabilities {
  canonicalConnectorKey: (connectorId: string) => string | null;
  encodeHostedMcpSelection: (opts: { connectorId: string; connectionId: string | null }) => string;
  encodeHostedMcpStreamSelection: (opts: {
    connectorId: string;
    connectionId: string | null;
    streamName: string;
  }) => string;
  getConnectorManifest: (connectorId: string) => Promise<ConsentPickerManifest | null>;
  hostedMcpSourceKey: (opts: { connectorId: string; connectionId: string | null }) => string;
  isInternalConnectorId: (connectorId: string) => boolean;
  listActiveBindingsForGrant: (opts: {
    ownerSubjectId: string;
    connectorId: string;
  }) => Promise<ConsentPickerBinding[]>;
  listRegisteredConnectorIds: () => Promise<string[]>;
  /**
   * Names of streams that actually hold at least one record for a connector
   * (optionally narrowed to one connection). Backs the picker's owner-facing
   * "N streams available" claim, which must describe what the owner HOLDS,
   * not the manifest's full catalog of grantable stream names — see
   * `buildConnectorPickerRows`. Does not affect which streams remain
   * grantable (`HostedMcpPickerRow.streams` stays the full manifest list, so
   * an owner can still pre-authorize a stream with no data yet).
   */
  listStreamsWithRecords: (opts: { connectorId: string; connectorInstanceId: string | null }) => Promise<string[]>;
  projectBindingForWire: (
    conn: ConsentPickerBinding
  ) => { display_name?: string | null; connection_id?: string | null } | null;
}

export interface ConsentPickerManifest {
  readonly connector_id?: string | null;
  readonly display_name?: string | null;
  readonly manifest_uri?: string | null;
  readonly name?: string | null;
  readonly source_declaration?: {
    readonly source?: { readonly id?: string | null; readonly kind?: string | null } | null;
  } | null;
  readonly streams?: Array<{ name: string; description?: string | null }> | null;
}

export interface ConsentPickerBinding {
  readonly connectorInstanceId?: string | null;
  [key: string]: unknown;
}

/**
 * The active-binding store could not answer, so this is not evidence that the
 * owner has no connection. The authorize route maps this private sentinel to
 * its existing safe `server_error` envelope.
 */
export class ActiveBindingLookupError extends Error {
  readonly code = "active_binding_lookup_failed";

  constructor() {
    super("Unable to load active connection state");
    this.name = "ActiveBindingLookupError";
  }
}

// Picker row shape.

export interface HostedMcpPickerRow {
  connectionId: string | null;
  connectionName: string | null;
  connectorId: string;
  connectorTypeLabel: string;
  formValue: string;
  meta: string;
  sourceKey: string;
  /** Resolved public source identity kind (source-kinds:731-743), or null if the manifest has no valid source declaration. */
  sourceKind: string | null;
  streams: Array<{ name: string; description: string | null }>;
}

// Authorization-details constants.

// Registry code (spec-core.md Appendix A) — "Providing context to a personal
// AI agent." This is the closest registered fit for a hosted MCP connector
// (e.g. ChatGPT, Claude) reading data through the picker; the previous value,
// `personal_ai_assistant`, was not a registry code.
export const HOSTED_MCP_PICKER_PURPOSE_CODE = "https://pdpp.dev/purpose/agent_context";
export const HOSTED_MCP_PICKER_PURPOSE_DESCRIPTION =
  "Provide selected personal data as context to this MCP client acting as your personal AI agent.";
export const HOSTED_MCP_PICKER_DEFAULT_ACCESS_MODE = "continuous";
export const HOSTED_MCP_PICKER_SUPPORTED_ACCESS_MODES: ReadonlySet<string> = new Set(["single_use", "continuous"]);

// Retention for hosted-MCP package grants: none, because none was declared.
//
// spec-core.md:951 classes retention as a policy commitment BY THE DATA
// RECIPIENT (the client): "PDPP does not technically enforce retention.
// Enforcement is through legal agreements, contractual obligations, or trust
// registry mechanisms." A hosted-MCP authorize request carries no
// `authorization_details` at all, so the client has declared no retention —
// and this server has no reach into the client's data stores once data
// crosses (spec-core.md:948: "PDPP does not retroactively reach into
// client-side data stores").
//
// This previously held `{ max_duration: "P90D", on_expiry: "delete" }`, which
// was written into every issued grant and rendered to the owner as "data it
// reads is deleted within 90 days". Both were fabrications: the server
// recorded a commitment the client never made, and told the owner the client
// would honor it. Nothing this server can build makes that sentence true.
//
// `null` is the honest resolution — the grant records no recipient
// commitment, and the consent surface states the absence
// (`buildHostedMcpRetentionSentence`). If an operator later wants a retention
// term, it must be described as a requirement THIS SERVER imposes and must
// not be written as the client's commitment until the client has accepted it.
export const HOSTED_MCP_PICKER_RETENTION: { max_duration: string; on_expiry: "anonymize" | "delete" } | null = null;

// Grant expiry (Grant fields: `expires_at`) for every hosted-MCP package
// grant, independent of the chosen access mode: auth.ts's package-minting
// path (`buildPackageAndRedirect` -> child-grant loop) only applies a
// non-null `expires_at` to `single_use` grants from a review-artifact expiry
// this picker flow never sets, so in practice both access modes always issue
// with no expiry. Stated once here, tied to the access-mode control, so this
// copy can never drift into contradicting whichever mode the owner picks.
// Grant expiry (`expires_at`) is its own protocol fact, orthogonal to
// `access_mode` — spec-core.md:889 lists grant validity, data temporal scope,
// and access pattern as three concepts that MUST NOT be conflated.
//
// The prior copy ("No expiry — access lasts until you revoke it, whichever
// access mode you choose above") restated the access mode and contradicted
// the control directly above it: under `One-time access`, "access lasts until
// you revoke it" is false, because a single_use grant is consumed at first
// token issuance (spec-core.md:920). This states the expiry fact alone and
// never mentions the mode.
export const HOSTED_MCP_PICKER_GRANT_EXPIRY_COPY = "This authorization has no scheduled end date.";

// Input normalization helpers.

type OAuthError = Error & { code?: string };

/**
 * Parses the `authorization_details` query/body parameter into an array.
 * Throws a typed `invalid_request` error on malformed input.
 */
export function parseAuthorizeAuthorizationDetails(
  query: Record<string, unknown> | null | undefined
): unknown[] | null {
  const raw = query?.authorization_details;
  if (raw === null || raw === undefined || raw === "") {
    return null;
  }
  if (Array.isArray(raw)) {
    return raw;
  }
  if (typeof raw === "object") {
    return raw as unknown[];
  }
  if (typeof raw !== "string") {
    const err: OAuthError = new Error("authorization_details must be JSON");
    err.code = "invalid_request";
    throw err;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      const err: OAuthError = new Error("authorization_details must decode to an array");
      err.code = "invalid_request";
      throw err;
    }
    return parsed;
  } catch (err) {
    (err as OAuthError).code = (err as OAuthError).code || "invalid_request";
    throw err;
  }
}

/**
 * Asserts that `query[name]` is a non-empty string; throws `invalid_request` otherwise.
 */
export function requireAuthorizeString(query: Record<string, unknown> | null | undefined, name: string): string {
  const value = query?.[name];
  if (typeof value !== "string" || !value.trim()) {
    const err: OAuthError = new Error(`${name} is required`);
    err.code = "invalid_request";
    throw err;
  }
  return value.trim();
}

interface ClientWithRedirectUris {
  readonly metadata?: { redirect_uris?: string[] } | null;
}

const IPV4_OCTET_RE = /^\d{1,3}$/;

function normalizeLoopbackHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, "");
}

function isIpv4LoopbackHost(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4 || parts[0] !== "127") {
    return false;
  }
  return parts.every((part) => {
    if (!IPV4_OCTET_RE.test(part)) {
      return false;
    }
    const n = Number(part);
    return Number.isInteger(n) && n >= 0 && n <= 255;
  });
}

function isHttpLoopbackRedirect(url: URL): boolean {
  if (url.protocol !== "http:") {
    return false;
  }
  const host = normalizeLoopbackHost(url.hostname);
  return host === "localhost" || host === "::1" || isIpv4LoopbackHost(host);
}

function parseRedirectUri(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function loopbackRedirectMatchesExceptPort(registeredUri: string, requestedUri: string): boolean {
  const registered = parseRedirectUri(registeredUri);
  const requested = parseRedirectUri(requestedUri);
  if (!(registered && requested)) {
    return false;
  }
  if (!(isHttpLoopbackRedirect(registered) && isHttpLoopbackRedirect(requested))) {
    return false;
  }
  return (
    normalizeLoopbackHost(registered.hostname) === normalizeLoopbackHost(requested.hostname) &&
    registered.pathname === requested.pathname &&
    registered.search === requested.search &&
    registered.hash === requested.hash
  );
}

function redirectUriMatchesRegisteredUri(registeredUri: string, requestedUri: string): boolean {
  return registeredUri === requestedUri || loopbackRedirectMatchesExceptPort(registeredUri, requestedUri);
}

/**
 * Asserts that `redirectUri` is registered in `client.metadata.redirect_uris`.
 * Throws `invalid_request` if not.
 */
export function requireRegisteredRedirectUri(
  client: ClientWithRedirectUris | null | undefined,
  redirectUri: string
): void {
  const redirectUris =
    client?.metadata !== null && client?.metadata !== undefined && Array.isArray(client.metadata.redirect_uris)
      ? (client.metadata.redirect_uris as string[])
      : [];
  if (!redirectUris.some((registeredUri) => redirectUriMatchesRegisteredUri(registeredUri, redirectUri))) {
    const err: OAuthError = new Error("redirect_uri does not match a registered redirect URI");
    err.code = "invalid_request";
    throw err;
  }
}

interface PkceParams {
  codeChallenge: string;
  codeChallengeMethod: string;
  responseType: string;
}

/**
 * Validates PKCE parameters; throws a typed OAuth error on any violation.
 */
export function validateAuthorizePkce({ responseType, codeChallenge, codeChallengeMethod }: PkceParams): void {
  if (responseType !== "code") {
    const err: OAuthError = new Error("response_type must be code");
    err.code = "unsupported_response_type";
    throw err;
  }
  if (codeChallengeMethod !== "S256") {
    const err: OAuthError = new Error("code_challenge_method must be S256");
    err.code = "invalid_request";
    throw err;
  }
  if (typeof codeChallenge !== "string" || codeChallenge.length < 43 || codeChallenge.length > 128) {
    const err: OAuthError = new Error("code_challenge must be 43-128 characters");
    err.code = "invalid_request";
    throw err;
  }
}

// Authorization-details builders.

/**
 * Builds a single-entry `authorization_details` array for a connector-backed
 * hosted MCP authorize shortcut (wildcard streams, continuous access).
 */
interface HostedMcpSourceDescriptor {
  id: string;
  kind: "connector" | "provider_native";
}

/** Resolve public source identity without leaking the local storage key. */
export function resolveHostedMcpSourceDescriptor(
  manifest: ConsentPickerManifest | null | undefined
): HostedMcpSourceDescriptor | null {
  const declared = manifest?.source_declaration?.source;
  if (
    declared &&
    (declared.kind === "connector" || declared.kind === "provider_native") &&
    typeof declared.id === "string" &&
    URL.canParse(declared.id)
  ) {
    return { id: declared.id, kind: declared.kind };
  }
  const legacyId =
    typeof manifest?.manifest_uri === "string" && manifest.manifest_uri
      ? manifest.manifest_uri
      : manifest?.connector_id;
  return typeof legacyId === "string" && URL.canParse(legacyId) ? { id: legacyId, kind: "connector" } : null;
}

export function buildHostedMcpAuthorizationDetailsForConnector(
  connectorId: string,
  source: HostedMcpSourceDescriptor = { id: connectorId, kind: "connector" }
): unknown[] {
  return [
    {
      access_mode: "continuous",
      purpose_code: HOSTED_MCP_PICKER_PURPOSE_CODE,
      purpose_description: HOSTED_MCP_PICKER_PURPOSE_DESCRIPTION,
      // `retention` is omitted, not nulled, when the client declared none —
      // see HOSTED_MCP_PICKER_RETENTION. An absent key records "no recipient
      // commitment"; a present one would assert a promise nobody made.
      ...(HOSTED_MCP_PICKER_RETENTION ? { retention: HOSTED_MCP_PICKER_RETENTION } : {}),
      source,
      streams: [{ name: "*" }],
      type: "https://pdpp.dev/data-access",
    },
  ];
}

/**
 * Builds one source-bounded `authorization_details` entry for a hosted MCP
 * package. `streamNames` narrows the grant to those streams when provided and
 * non-empty; null preserves the wildcard default. `accessMode` is validated
 * against `HOSTED_MCP_PICKER_SUPPORTED_ACCESS_MODES`; unknown values fall back
 * to `HOSTED_MCP_PICKER_DEFAULT_ACCESS_MODE` (continuous).
 *
 * `connectionId`, when a non-empty string, pins every stream entry to that
 * connector instance by stamping its opaque handle into `instance_ids`.
 * Wildcard stream selections are pinned identically. Callers MUST only pass a
 * `connectionId` the picker presented and
 * validated as active, and MUST omit it when the surface did not present a
 * specific-connection choice (single-connection or unconfigured connector), so
 * fan-in semantics and existing grants are preserved.
 */
export function buildHostedMcpAuthorizationDetailForConnector(
  connectorId: string,
  streamNames: string[] | null = null,
  accessMode: string | null = null,
  connectionId: string | null = null,
  source: HostedMcpSourceDescriptor = { id: connectorId, kind: "connector" }
): {
  type: string;
  source: { kind: string; id: string };
  purpose_code: string;
  purpose_description: string;
  access_mode: string;
  retention?: { max_duration: string; on_expiry: "anonymize" | "delete" };
  streams: Array<{ name: string; instance_ids?: string[] }>;
} {
  const pinnedConnectionId = typeof connectionId === "string" && connectionId.trim() ? connectionId.trim() : null;
  const withPin = (name: string): { name: string; instance_ids?: string[] } =>
    pinnedConnectionId ? { instance_ids: [pinnedConnectionId], name } : { name };
  let streams: Array<{ name: string; instance_ids?: string[] }>;
  if (Array.isArray(streamNames) && streamNames.length > 0) {
    streams = streamNames.map((name) => withPin(name));
  } else {
    streams = [withPin("*")];
  }
  const resolvedAccessMode = HOSTED_MCP_PICKER_SUPPORTED_ACCESS_MODES.has(accessMode ?? "")
    ? (accessMode as string)
    : HOSTED_MCP_PICKER_DEFAULT_ACCESS_MODE;
  return {
    access_mode: resolvedAccessMode,
    purpose_code: HOSTED_MCP_PICKER_PURPOSE_CODE,
    purpose_description: HOSTED_MCP_PICKER_PURPOSE_DESCRIPTION,
    // Omitted when the client declared no retention — see
    // HOSTED_MCP_PICKER_RETENTION.
    ...(HOSTED_MCP_PICKER_RETENTION ? { retention: HOSTED_MCP_PICKER_RETENTION } : {}),
    source,
    streams,
    type: "https://pdpp.dev/data-access",
  };
}

// ─── Picker package review digest ─────────────────────────────────────────
//
// AS-conformance #15 (spec-core.md:1454-1457) requires the AS to resolve
// omitted instance_ids before the final approval surface and bind that
// resolution to an immutable review revision/digest. The non-picker consent
// flow does this with a DB-persisted `approval_review_revision` (see
// `buildApprovalReviewArtifact` in auth.ts); the hosted-MCP picker/package
// flow has no equivalent state to persist into (it never writes a pending
// row before minting the grant). This is a scoped-down, stateless
// equivalent: the exact resolved decision (client identity + every
// authorization_details entry the picker POST produced) is canonicalized and
// hashed; the digest travels in a hidden field on a genuine second
// confirmation POST and is re-verified server-side (recomputed from a fresh
// re-resolution, not merely echoed) before any grant is minted. See
// `renderHostedMcpPackageReviewHtml` and as-authorize.ts's
// `buildPackageAndRedirect`.

function canonicalizeForDigest(value: unknown): unknown {
  if (!value || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeForDigest(item));
  }
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[key] = canonicalizeForDigest((value as Record<string, unknown>)[key]);
  }
  return sorted;
}

export interface HostedMcpPickerReviewDecision {
  authorizationDetails: unknown[];
  clientId: string;
}

// ─── The owner's submitted decision (the approval artifact) ───────────────
//
// spec-core.md:873-877 requires the final approval artifact to carry the
// EXACT resolved terms — instance_ids, stream names, fields, resources,
// temporal field/since/until, purpose, retention, client identity, and grant
// expiry. :881-885 and AS-conformance #15 require the approval to bind to an
// immutable review revision or digest, and require a stale review to fail.
//
// Neither existing digest satisfied that. The snapshot digest below covers
// what the GET rendered as *choosable*, so checking three streams or thirty
// produced an identical value — it detects drift in the menu and is blind to
// the order. `computeHostedMcpPickerReviewDigest` does cover the exact
// selection, but is computed server-side AFTER the POST and its own comment
// concedes it "cannot itself reject anything stale, because nothing is
// compared against it". So no page in the flow was the approval artifact: the
// owner never saw, and never bound to, a statement of what they actually
// granted.
//
// This closes it without adding a round-trip. The page renders a live summary
// of the decision as the owner builds it, and the same script writes the
// canonical decision into a hidden `decision_digest` field. The POST
// recomputes that digest from the decision it actually resolved — never from
// anything the form supplied beyond the selections themselves — and rejects a
// mismatch. Real MCP clients still get one POST and one redirect.
//
// The submitted decision is a binding claim about what the owner reviewed; it
// never widens the grant. Everything minted still derives from the server's
// own re-resolution of the selections.

/** The exact decision the owner reviewed, in the shape the page displayed. */
export interface HostedMcpPickerSubmittedDecision {
  accessMode: string;
  clientId: string;
  /** Sorted `sourceKey -> sorted stream names`, exactly as approved. */
  sources: Array<{ sourceKey: string; streamNames: string[] }>;
}

/**
 * Digest over the owner's exact decision. Stable across key order; any change
 * to the selected sources, the selected streams within them, the access mode,
 * or the client identity changes it.
 */
export function computeHostedMcpDecisionDigest(decision: HostedMcpPickerSubmittedDecision): string {
  const normalized = {
    accessMode: decision.accessMode,
    clientId: decision.clientId,
    sources: [...decision.sources]
      .map((source) => ({ sourceKey: source.sourceKey, streamNames: [...source.streamNames].sort() }))
      .sort((a, b) => a.sourceKey.localeCompare(b.sourceKey)),
  };
  return `sha256:${base64UrlSha256(JSON.stringify(canonicalizeForDigest(normalized)))}`;
}

/**
 * Computes a stable digest over the exact resolved hosted-MCP package
 * decision (client + every source-bounded authorization_details entry,
 * including resolved instance_ids). Two calls with the same resolved
 * decision — regardless of object key order — produce the same digest;
 * any change to what would actually be granted changes it.
 */
export function computeHostedMcpPickerReviewDigest(decision: HostedMcpPickerReviewDecision): string {
  const canonicalJson = JSON.stringify(canonicalizeForDigest(decision));
  return `sha256:${base64UrlSha256(canonicalJson)}`;
}

// ─── Picker snapshot digest (stale-review-revision rejection) ─────────────
//
// AS-conformance #15 requires the final approval artifact's exact resolved
// terms to be bound to an immutable review revision, and requires the AS to
// reject a stale one. `computeHostedMcpPickerReviewDigest` above binds
// AFTER minting, into the audit trail — it cannot itself reject anything
// stale, because nothing is compared against it. This is the actual
// TOCTOU guard: a digest computed over exactly what the picker GET rendered
// as choosable (source/connection/stream eligibility, purpose, retention,
// access modes, client identity) is stamped into a hidden `review_digest`
// form field; the POST re-resolves the same inputs FRESH (a real second
// read of connector manifests and active bindings, not a reuse of anything
// from the GET) and only proceeds to mint if the freshly computed digest
// matches the one the form carried. A mismatch — including a tampered
// field, or a real drift such as a connection revoked between page-load and
// submission — rejects with the same typed re-render path a validation
// error uses; nothing is minted. No interactive round-trip is added: real
// MCP OAuth clients still get their single POST -> redirect.
//
// Time range and per-stream client_claims are not part of this digest: the
// hosted-MCP picker POST has no fields for either (see
// CONSENT-UI-SPEC-GAP-0902.md §3 and §5) — there is nothing resolvable to
// bind. Grant expiry is not a picker input either; it is a property of the
// issued token, not of what the owner reviewed.
export interface HostedMcpPickerSnapshotClientFacts {
  isUnverified: boolean;
  protocolFacts: Array<{ label: string; value?: unknown; html?: string }>;
  titleName: string;
}

function computeHostedMcpPickerSnapshotDigest(
  rows: HostedMcpPickerRow[],
  client: HostedMcpPickerSnapshotClientFacts | null
): string {
  const sortedRows = [...rows]
    .sort((a, b) => a.sourceKey.localeCompare(b.sourceKey))
    .map((row) => ({
      connectionId: row.connectionId,
      connectorId: row.connectorId,
      sourceKey: row.sourceKey,
      sourceKind: row.sourceKind,
      streamNames: [...row.streams.map((stream) => stream.name)].sort(),
    }));
  const snapshot = {
    accessModes: [...HOSTED_MCP_PICKER_SUPPORTED_ACCESS_MODES].sort(),
    client: client
      ? {
          isUnverified: client.isUnverified,
          protocolFacts: client.protocolFacts,
          titleName: client.titleName,
        }
      : null,
    purposeCode: HOSTED_MCP_PICKER_PURPOSE_CODE,
    purposeDescription: HOSTED_MCP_PICKER_PURPOSE_DESCRIPTION,
    retention: HOSTED_MCP_PICKER_RETENTION,
    rows: sortedRows,
  };
  const canonicalJson = JSON.stringify(canonicalizeForDigest(snapshot));
  return `sha256:${base64UrlSha256(canonicalJson)}`;
}

/**
 * Re-resolves the picker's eligibility snapshot fresh (never reusing
 * anything from a prior request) and computes its digest, for comparison
 * against a `review_digest` a picker POST carried. Exported so the
 * route-layer POST handler (as-authorize.ts) can call it without
 * duplicating the row-resolution + digest logic.
 */
export async function resolveHostedMcpPickerSnapshotDigest(
  caps: ConsentPickerCapabilities,
  ownerSubjectId: string,
  client: HostedMcpPickerSnapshotClientFacts | null
): Promise<string> {
  const rows = await listHostedMcpPickerRows(caps, ownerSubjectId);
  return computeHostedMcpPickerSnapshotDigest(rows, client);
}

// Picker data builder.

/**
 * Fetches the hosted MCP picker rows for the given owner. One row per
 * configured connection. A connector the owner has never connected renders
 * no row at all — see `listHostedMcpPickerRows` for why. Sorted by connector
 * type label then connection name.
 */
async function buildConnectorPickerRows(
  connectorId: string,
  ownerSubjectId: string,
  caps: ConsentPickerCapabilities
): Promise<HostedMcpPickerRow[]> {
  const manifest = await caps.getConnectorManifest(connectorId).catch(() => null);
  if (!manifest) {
    return [];
  }
  const connectorMetaToken = ownerFacingConnectorKey(connectorId, caps);
  const connectorLabel = ownerFacingConnectorLabel(manifest.display_name || manifest.name, connectorMetaToken);
  const sourceKind = resolveHostedMcpSourceDescriptor(manifest)?.kind ?? null;
  const manifestStreams = Array.isArray(manifest.streams) ? manifest.streams : [];
  // The manifest list stays the full grantable catalog for the checkbox rows
  // (`HostedMcpPickerRow.streams`): a held connection may pre-authorize a
  // stream that has no data yet, and hiding it here would silently shrink
  // what a continuous grant can ever cover. Only the owner-facing "available"
  // COUNT must reflect real holdings — see `listStreamsWithRecords` below.
  const streamSummaries = manifestStreams.map((stream) => ({
    description: typeof stream.description === "string" ? stream.description : null,
    name: stream.name,
  }));
  let connections: ConsentPickerBinding[];
  try {
    connections = await caps.listActiveBindingsForGrant({ connectorId, ownerSubjectId });
  } catch {
    // Do not render an empty picker as though a failed storage lookup proved
    // that the owner has no active connection.
    throw new ActiveBindingLookupError();
  }
  if (connections.length === 0) {
    // No active connection for this connector at all: the owner has never
    // held any of its data, and the AS has no eligible instance to satisfy a
    // grant against it. Rendering a row here (and letting it into
    // `authorization_details`) is exactly the defect this fixes: the picker
    // offered sources the owner does not have, and a select-all over them
    // hard-failed the whole submission with
    // `source.authorization_details_invalid` once the AS found zero eligible
    // instances. Emit no row — the registry catalog is not the owner's
    // holdings.
    return [];
  }
  return await Promise.all(
    connections.map(async (conn) => {
      const projected = caps.projectBindingForWire(conn);
      const displayName = projected?.display_name;
      const connectionId = projected?.connection_id || conn.connectorInstanceId || null;
      const connectionName = ownerFacingConnectionName(displayName, {
        connectorId,
        connectorKey: connectorMetaToken,
        connectorLabel,
      });
      // Real holdings for THIS connection: count manifest-declared streams
      // that actually have at least one record, never the manifest's full
      // offering. A read failure degrades to "0 held" (honest: we don't know
      // of any held data), never to the manifest count (which would silently
      // resurrect the bug this fixes).
      const heldStreamNames = new Set(
        await caps.listStreamsWithRecords({ connectorId, connectorInstanceId: connectionId ?? null }).catch(() => [])
      );
      const heldStreamCount = manifestStreams.reduce(
        (count, stream) => (heldStreamNames.has(stream.name) ? count + 1 : count),
        0
      );
      return {
        connectionId: connectionId ?? null,
        connectionName,
        connectorId,
        connectorTypeLabel: connectorLabel,
        formValue: caps.encodeHostedMcpSelection({ connectionId: connectionId ?? null, connectorId }),
        meta: buildPickerRowMeta({ streamCount: heldStreamCount }),
        sourceKey: caps.hostedMcpSourceKey({ connectionId: connectionId ?? null, connectorId }),
        sourceKind,
        streams: streamSummaries,
      };
    })
  );
}

function ownerFacingConnectorKey(connectorId: string, caps: ConsentPickerCapabilities): string {
  const canonical = caps.canonicalConnectorKey(connectorId);
  if (canonical) {
    return canonical;
  }
  try {
    const url = new URL(connectorId);
    const lastPathToken = url.pathname
      .split("/")
      .map((part) => part.trim())
      .filter(Boolean)
      .at(-1);
    return lastPathToken || url.hostname || connectorId;
  } catch {
    return connectorId;
  }
}

function ownerFacingConnectorLabel(label: string | null | undefined, fallbackKey: string): string {
  const trimmed = typeof label === "string" ? label.trim() : "";
  if (!trimmed) {
    return fallbackKey;
  }
  try {
    const url = new URL(trimmed);
    return (
      url.pathname
        .split("/")
        .map((part) => part.trim())
        .filter(Boolean)
        .at(-1) || fallbackKey
    );
  } catch {
    return trimmed;
  }
}

function ownerFacingConnectionName(
  displayName: string | null | undefined,
  { connectorId, connectorLabel, connectorKey }: { connectorId: string; connectorLabel: string; connectorKey: string }
): string | null {
  const trimmed = typeof displayName === "string" ? displayName.trim() : "";
  if (!trimmed) {
    return null;
  }
  const normalized = normalizeConnectorLabel(trimmed);
  const redundantLabels = new Set(
    [connectorId, connectorLabel, connectorKey, ownerFacingConnectorLabel(connectorId, connectorKey)]
      .filter(Boolean)
      .map((value) => normalizeConnectorLabel(value))
  );
  if (redundantLabels.has(normalized) || trimmed.startsWith("cin_")) {
    return null;
  }
  try {
    // biome-ignore lint/correctness/noUnusedInstantiation: Construction intentionally triggers the compatibility side effect.
    new URL(trimmed);
    return null;
  } catch {
    return trimmed;
  }
}

function normalizeConnectorLabel(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "-");
}

function buildPickerRowMeta({
  streamCount,
  suffix,
}: {
  streamCount: number;
  suffix?: string;
}): string {
  const parts: string[] = [];
  // `streamCount` here is real holdings (streams with at least one record),
  // never manifest cardinality — see `buildConnectorPickerRows`. Every row
  // reaching this function is for a connection the owner actually holds (a
  // connector with zero active bindings renders no row at all), so a
  // connected-but-not-yet-synced source says "0 streams available": that IS
  // the true current holdings, and "available" there means "available right
  // now", not "will exist".
  // "Data types", not "streams": `stream` is a protocol noun the owner never
  // agreed to learn, and it means nothing on a screen about sharing data.
  const availabilityPhrase = streamCount === 1 ? "1 data type" : `${streamCount} data types`;
  parts.push(availabilityPhrase);
  // The connector key used to be appended here whenever it differed from the
  // display label — so a row read "5 data types · chase-bank". That is a
  // registry identifier, and its audience is a protocol engineer inspecting a
  // registration, not the person deciding whether to share their bank
  // transactions. It is the same defect as the metadata-document URL and the
  // `connector` badge, both already removed from this surface for exactly
  // this reason, just wearing a shorter string.
  //
  // The label alone identifies the source; where two connections of one
  // source need telling apart, `connectionName` does that in the owner's own
  // words. The key stays in the form value (the enforced scope) and the
  // audit record.
  if (suffix) {
    parts.push(suffix);
  }
  return parts.join(" · ");
}

// ─── Owner-facing stream copy ────────────────────────────────────────────────
//
// Manifest `streams[].name` is a schema key (`month_categories`) and
// `streams[].description` is documentation written for connector engineers.
// Neither was authored for the screen where someone decides whether to hand
// their financial history to an AI agent, and both were rendering there
// verbatim — including our own scraping strategy:
//
//   "Chase retail accounts (checking, savings, credit cards). Hybrid-sourced:
//    identity + account type come from the QFX ACCTINFO response; friendly
//    name, open date, and tier come from chase.com dashboard scrape."
//
// The durable fix is a first-class consent-copy field on the manifest,
// reviewed like product copy (P2 in the design spec — real content work
// across 43 manifests and 162 streams). Until that field exists, the honest
// interim is to humanize the label and SUPPRESS the description rather than
// ship it: a missing sentence is a gap, a wrong-register one is a leak.

/** Manifest-key acronyms that must not be title-cased into "Url"/"Id". */
const STREAM_LABEL_ACRONYMS = new Set(["api", "id", "ids", "url", "urls", "ui", "sms", "os", "pr", "prs", "qa"]);

/**
 * Humanizes a manifest stream key for the consent surface: `month_categories`
 * → `Month categories`, `user_stats` → `User stats`. Sentence case, not title
 * case — the corpus writes permissions as human sentences, and Title Case On
 * Every Word reads like a settings menu.
 */
export function humanizeStreamLabel(name: string): string {
  const words = name
    .trim()
    .split(/[\s_-]+/)
    .filter(Boolean);
  if (words.length === 0) {
    return name;
  }
  const spelled = words.map((word) =>
    STREAM_LABEL_ACRONYMS.has(word.toLowerCase()) ? word.toUpperCase() : word.toLowerCase()
  );
  const [first = "", ...rest] = spelled;
  return [first.charAt(0).toUpperCase() + first.slice(1), ...rest].join(" ");
}

// Markers of connector-engineering register. A description carrying any of
// these is documentation for whoever maintains the scraper, not an
// explanation of what sharing this data means. Matching is deliberately
// conservative: suppressing a usable sentence costs the owner a little
// context, but shipping an unusable one leaks implementation detail onto a
// consent screen and mismatches the register entirely.
const ENGINEERING_PROSE_MARKERS: readonly RegExp[] = [
  /\bscrape[ds]?\b|\bscraping\b/i,
  /\bendpoint\b|\bAPI\b|\bpayload\b|\bresponse\b/i,
  /\bmilliunits?\b/i,
  /\bRFC\s*\d+/i,
  /\bschema\b|\bhybrid-sourced\b|\bdenormali[sz]ed\b/i,
  /\bQFX\b|\bACCTINFO\b|\bCardDAV\b|\bJSON\b|\bXML\b/,
  // ALL-CAPS protocol/field tokens (ACCTINFO, HKQuantityTypeIdentifier).
  /\b[A-Z]{4,}\b/,
];

/**
 * Returns a stream description fit for the consent surface, or null when the
 * manifest text is engineering documentation that must not be shown.
 */
export function consentSafeStreamDescription(description: string | null | undefined): string | null {
  const trimmed = typeof description === "string" ? description.trim() : "";
  if (!trimmed) {
    return null;
  }
  if (ENGINEERING_PROSE_MARKERS.some((marker) => marker.test(trimmed))) {
    return null;
  }
  // A paragraph is documentation regardless of vocabulary; consent copy is
  // one plain sentence about what sharing this means.
  if (trimmed.length > 160) {
    return null;
  }
  return trimmed;
}

// A short, owner-readable preview of the data a collapsed source holds, so
// the owner can tell a one-stream grant is possible without opening the row.
// Labels are humanized (never raw manifest keys); we cap the list to keep the
// summary scannable and spell out the tail rather than printing "+N more".
function buildStreamPreview(streams: Array<{ name: string; description: string | null }> | null | undefined): string {
  if (!Array.isArray(streams) || streams.length === 0) {
    return "";
  }
  const labels = streams
    .map((stream) => stream.name)
    .filter((name) => typeof name === "string" && name)
    .map((name) => humanizeStreamLabel(name));
  if (labels.length === 0) {
    return "";
  }
  const MAX_SHOWN = 4;
  if (labels.length <= MAX_SHOWN) {
    return labels.join(", ");
  }
  const shown = labels.slice(0, MAX_SHOWN);
  const remaining = labels.length - shown.length;
  return `${shown.join(", ")}, and ${remaining} more`;
}

export async function listHostedMcpPickerRows(
  caps: ConsentPickerCapabilities,
  ownerSubjectId = "owner_local"
): Promise<HostedMcpPickerRow[]> {
  const connectorIds = await caps.listRegisteredConnectorIds();
  const rows: HostedMcpPickerRow[] = [];
  for (const connectorId of connectorIds) {
    if (caps.isInternalConnectorId(connectorId)) {
      continue;
    }
    // biome-ignore lint/performance/noAwaitInLoops: Work is intentionally sequential to preserve ordering and state transitions.
    rows.push(...(await buildConnectorPickerRows(connectorId, ownerSubjectId, caps)));
  }
  rows.sort((a, b) => {
    const typeOrder = a.connectorTypeLabel.localeCompare(b.connectorTypeLabel);
    if (typeOrder !== 0) {
      return typeOrder;
    }
    return (a.connectionName || "").localeCompare(b.connectionName || "");
  });
  return rows;
}

// Consent page renderers.

/**
 * Renders the "consent request expired / not found" page for GET /consent
 * when the request_uri no longer maps to a live pending-consent row.
 */
export function renderPendingConsentNotFoundHtml(providerName: string, ui: ConsentUiRenderer): string {
  return ui.renderHostedDocument({
    body: [
      ui.renderPageIntro({
        eyebrow: "Data access request",
        title: "This consent request is no longer available",
      }),
      ui.renderSurface({
        ariaLabel: "Consent request expired",
        children: ui.renderResultState({
          body: "This approval link has expired, was already approved or denied, or was created on a different session. Return to the app that asked for access and start the request again to get a fresh link.",
          title: "Link expired or already used",
          tone: "neutral",
        }),
        surface: "human",
      }),
    ].join("\n"),
    providerName,
    title: `${providerName} — Consent request expired`,
  });
}

interface PendingClientClaims {
  commitments?: string[] | null;
  [key: string]: unknown;
}

export interface PendingGrantRequestClientDisplay {
  logo_uri?: string | null;
  name?: string | null;
  policy_uri?: string | null;
  tos_uri?: string | null;
  uri?: string | null;
}

export interface PendingGrantRequest {
  client?: {
    client_display?: PendingGrantRequestClientDisplay | null;
    client_id?: string | null;
    registration_mode?: string | null;
  } | null;
  selection?: {
    client_claims?: PendingClientClaims | null;
    streams?: Array<{
      name: string;
      time_constraint?: { field?: string | null; since?: string | null; until?: string | null } | null;
      time_range?: { since?: string | null } | null;
      fields?: string[] | null;
      instance_ids?: string[] | null;
      resources?: string[] | null;
      view?: string | null;
      necessity?: string | null;
    }> | null;
    access_mode?: string | null;
    purpose_description?: string | null;
    purpose_code?: string | null;
    retention?: {
      max_duration?: string | null;
      on_expiry?: string | null;
    } | null;
  } | null;
  source_binding?: {
    id?: string | null;
    kind?: string | null;
  } | null;
}

interface ApprovalReviewStream {
  fields: string[];
  instance_ids: string[];
  name: string;
  resources?: string[];
  time_constraint?: { field: string; since?: string; until?: string };
}

interface ApprovalReviewClient {
  client_display?: {
    logo_uri?: string | null;
    name?: string | null;
    policy_uri?: string | null;
    tos_uri?: string | null;
    uri?: string | null;
  } | null;
  client_id: string;
  registration_mode: string;
}

interface ApprovalReviewSource {
  id: string;
  kind: string;
}

interface ApprovalReviewSourceDeclaration {
  accepted_revision_reference?: string;
  digest: string;
  publisher_attribution?: { id: string; status: "unverified" };
  resource_authority?: { authority_binding: string; status: "verified" } | { status: "local_operator_provisioned" };
  version: string;
}

interface ApprovalReviewSourceEntry {
  access_mode: string;
  client_claims: PendingClientClaims | null;
  index: number;
  purpose_code: string;
  purpose_description: string | null;
  resolved_streams: ApprovalReviewStream[];
  retention: { max_duration?: string; on_expiry?: string } | null;
  selection_preset: string | null;
  source: ApprovalReviewSource;
  source_declaration: ApprovalReviewSourceDeclaration;
}

interface SingleApprovalReviewArtifact {
  access_mode: string;
  ai_training_consented: boolean | null;
  client: ApprovalReviewClient;
  client_claims: PendingClientClaims | null;
  expires_at: string | null;
  purpose_code: string;
  purpose_description: string | null;
  resolved_streams: ApprovalReviewStream[];
  retention: { max_duration?: string; on_expiry?: string } | null;
  selection_preset: string | null;
  source: ApprovalReviewSource;
  source_declaration: ApprovalReviewSourceDeclaration;
  subject: { id: string };
  version: "reference.approval-review.v1";
}

interface BatchApprovalReviewArtifact {
  access_mode: string | null;
  approved_source_indexes: number[];
  client: ApprovalReviewClient;
  expires_at: string | null;
  parent_package_id: string | null;
  source_narrowing: Record<
    string,
    { fields?: Record<string, string[]>; since?: Record<string, string>; streams?: string[] }
  >;
  sources: ApprovalReviewSourceEntry[];
  subject: { id: string };
  version: "reference.batch-approval-review.v1";
}

type ApprovalReviewArtifact = SingleApprovalReviewArtifact | BatchApprovalReviewArtifact;

export interface PendingGrant {
  approveAllGate?: { approve_all_suppressed: boolean; suppression_reasons: string[] } | null;
  batch?: boolean;
  cards?: PendingConsentCard[];
  cumulativeRisk?: PendingConsentCumulativeRisk | null;
  manifestStreamNames?: string[] | null;
  overCapSources?: Array<{ id?: string | null; kind?: string | null } | null> | null;
  overSoftCap?: boolean;
  request: PendingGrantRequest;
  review?: ApprovalReviewArtifact | null;
  reviewArtifact?: string | null;
  reviewDigest?: string | null;
  reviewRevision?: string | null;
  softCap?: number;
  softCapWarning?: boolean;
  userCode?: string | null;
}

type StreamItem = NonNullable<NonNullable<PendingGrantRequest["selection"]>["streams"]>[number];

interface PendingConsentCard {
  access_mode?: string | null;
  client_claims?: PendingClientClaims | null;
  index: number;
  manifestStreamNames?: string[] | null;
  purpose_code?: string | null;
  resolvedStreams?: StreamItem[] | null;
  retention?: { max_duration?: string | null; on_expiry?: string | null } | null;
  sensitivity?: "standard" | "sensitive" | string | null;
  source?: { id?: string | null; kind?: string | null } | null;
}

interface PendingConsentCumulativeRisk {
  continuous_access_count?: number;
  no_field_projection_count?: number;
  no_time_bound_count?: number;
  sensitive_source_count?: number;
  source_count?: number;
  total_stream_count?: number;
}

// ─── Authorship classes (the three-class trust model) ────────────────────────
//
// The hosted consent HTML keeps protocol facts, manifest-authored descriptions,
// and client-authored claims visually and semantically distinct, so a consumer
// (a standards reviewer, or the authorship-token console card that mirrors this
// surface) can point at any element and name its provenance:
//
//   • PROTOCOL — facts the owner's server enforces/verifies (grant scope,
//     access mode, retention, the source binding, the resolved client-identity
//     origin). Trusted.
//   • MANIFEST — the owner-trusted human descriptions for the requested streams
//     (stream labels/details from the resolved manifest).
//   • CLIENT   — claims the client itself authored (its self-described app name,
//     the purpose_description, and top-level client_claims). Rendered, never
//     trusted: each carries a "they say / not enforced" affordance.
//
// `data-authorship` is the machine-readable provenance hook (one per block),
// matching the operator-ui consent-card contract; `data-surface` keeps the
// existing human/protocol temperature.

type ConsentAuthorship = "protocol" | "manifest" | "client";

const AUTHORSHIP_EYEBROW: Record<ConsentAuthorship, string> = {
  client: "They claim — not verified by your server",
  manifest: "Your server describes",
  protocol: "Your server enforces",
};

/**
 * Wrap a consent block in an authorship-tagged section. `data-authorship` names
 * the block's provenance class; the eyebrow makes the boundary legible without
 * relying on color alone.
 */
function renderAuthorshipBlock(
  authorship: ConsentAuthorship,
  ariaLabel: string,
  childrenHtml: string,
  ui: ConsentUiRenderer
): string {
  return `<div class="hosted-ui-authorship" data-authorship="${authorship}" aria-label="${ui.escapeHtml(
    ariaLabel
  )}"><span class="pdpp-eyebrow hosted-ui-authorship-eyebrow">${ui.escapeHtml(
    AUTHORSHIP_EYEBROW[authorship]
  )}</span>${childrenHtml}</div>`;
}

export interface ConsentClientDisplay {
  // CLIENT: the client's own self-described display (its app name).
  clientFacts: Array<{ label: string; value?: unknown; html?: string }>;
  // Whether to render an "Unverified app" indicator. This reference
  // implementation has no trust-registry source of a positive trust signal
  // for any client, so every client is currently unverified
  // (client-display:675) — this flag exists so callers can render the
  // indicator without re-deriving the (always-true) policy inline.
  isUnverified: boolean;
  // A short text/CSS monogram placeholder for client identity — the spec
  // (client-display:676) prohibits fetching/rendering a remote client-supplied
  // logo for an unverified client; this is the safe fallback, never a URL.
  monogram: string;
  // MAY-level secondary disclosures (client-display:674): the client's own
  // policy_uri/tos_uri, when the resolved metadata carries them.
  policyLinks: Array<{ href: string; label: string }>;
  // PROTOCOL: server-resolved identity facts (the client_id origin / metadata
  // document URL). Empty for pre-registered clients with no derived identity.
  protocolFacts: Array<{ label: string; value?: unknown; html?: string }>;
  // CLIENT: the client's self-described display name, only when it differs
  // from `titleName` (the enforced identity). Callers MAY render this next to
  // `titleName` with an unverified marker (spec-core.md:706-730 allows
  // displaying a resolved name alongside its trust status); it MUST NOT
  // replace `titleName` as the sole identity shown, since `titleName` is the
  // one the server actually verified.
  selfDescribedName: string | null;
  titleName: string;
  /**
   * The name to call this app in owner-facing prose: the resolved display
   * name when the metadata carries one, else the origin.
   *
   * spec-core.md:673 requires the AS to display the resolved display name
   * when it is available, and makes `client_id` the FALLBACK for when it is
   * not. The picker previously headlined `titleName` (the origin) even when
   * a name was resolved, so a request from ChatGPT — whose metadata document
   * does carry `"client_name": "ChatGPT"` — rendered as
   * `https://chatgpt.com`. `titleName` remains the server-verified anchor and
   * is still shown, as the domain, beside this.
   */
  displayName: string;
  /** Origin shown as the quiet second identity line (e.g. `chatgpt.com`). */
  domainLabel: string | null;
}

function clientOriginFromClientId(clientId: string | null | undefined): string | null {
  if (!clientId) {
    return null;
  }
  try {
    return new URL(clientId).origin;
  } catch {
    return null;
  }
}

/**
 * Host label for the quiet second identity line — `chatgpt.com`, not
 * `https://chatgpt.com/`. Returns null when the client_id is not a URL.
 */
function hostLabelFromClientId(clientId: string | null | undefined): string | null {
  if (!clientId) {
    return null;
  }
  try {
    return new URL(clientId).hostname.replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

function buildClientMonogram(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    return "?";
  }
  // Always a two-letter mark, matching the design system's `.pdpp-monogram`.
  // Multi-word names take one letter per word ("Claude Code" → "CC");
  // a single word takes its first two ("ChatGPT" → "CH"). Taking only the
  // first letter of a one-word name produced a lone "C" sitting in a
  // two-letter slot. Pure text — never an image URL (client-display:676).
  const [first = "", second] = trimmed.split(/\s+/).filter(Boolean);
  if (second) {
    return (first.charAt(0) + second.charAt(0)).toUpperCase();
  }
  return first.slice(0, 2).toUpperCase();
}

function buildClientPolicyLinks(
  clientDisplay: PendingGrantRequestClientDisplay | null | undefined
): Array<{ href: string; label: string }> {
  const links: Array<{ href: string; label: string }> = [];
  if (clientDisplay?.policy_uri) {
    links.push({ href: clientDisplay.policy_uri, label: "Privacy policy" });
  }
  if (clientDisplay?.tos_uri) {
    links.push({ href: clientDisplay.tos_uri, label: "Terms of service" });
  }
  return links;
}

export function buildConsentClientDisplay(
  client: NonNullable<PendingGrantRequest["client"]>,
  ui: ConsentUiRenderer
): ConsentClientDisplay {
  const clientId = typeof client.client_id === "string" ? client.client_id : null;
  const clientName = client.client_display?.name || clientId || "Client application";
  const policyLinks = buildClientPolicyLinks(client.client_display);
  if (client.registration_mode !== "client_id_metadata_document") {
    // Pre-registered/public client: the "Requesting app" name is whatever the
    // client supplied at registration — a client-authored claim, not a fact.
    return {
      clientFacts: [{ label: "Requesting app", value: clientName }],
      displayName: clientName,
      domainLabel: null,
      isUnverified: true,
      monogram: buildClientMonogram(clientName),
      policyLinks,
      protocolFacts: [],
      selfDescribedName: null,
      titleName: clientName,
    };
  }

  // CIMD client: the URL-origin identity is a protocol fact (it is the
  // verifiable identifier the client authenticated as); the self-described
  // app name is a client-authored claim (see the CIMD consent-display spec).
  const identity = clientOriginFromClientId(clientId) || clientId || "Client application";
  // The metadata-document URL is deliberately NOT a protocol fact on the
  // owner surface. It is a `client_id` with a `token_endpoint_auth_method`
  // query parameter hanging off it — debug output that means something to an
  // engineer inspecting a registration and nothing to the person deciding
  // whether to share their bank transactions. It stays in the audit record
  // (`grant.issued` carries the full client_id) where it is genuinely useful.
  const protocolFacts: Array<{ label: string; value?: unknown; html?: string }> = [
    { html: `<code>${ui.escapeHtml(identity)}</code>`, label: "Client identity" },
  ];
  const clientFacts: Array<{ label: string; value?: unknown; html?: string }> = [];
  if (clientName && clientName !== identity) {
    clientFacts.push({ label: "Self-described app name", value: clientName });
  }
  const resolvedDisplayName = clientName && clientName !== identity ? clientName : identity;
  return {
    clientFacts,
    // spec-core.md:673 — display the resolved name when available; the
    // client_id is only the fallback.
    displayName: resolvedDisplayName,
    domainLabel: hostLabelFromClientId(clientId) ?? (identity === resolvedDisplayName ? null : identity),
    isUnverified: true,
    // Monogram from the name the owner actually reads, so "ChatGPT" yields
    // `CH`, not a `C` derived from the URL string.
    monogram: buildClientMonogram(resolvedDisplayName),
    policyLinks,
    protocolFacts,
    selfDescribedName: clientName && clientName !== identity ? clientName : null,
    titleName: identity,
  };
}

/**
 * Render top-level `client_claims.commitments` as a distinct, disclaimed
 * client-authored block. These are the client's own commitments; the server
 * renders but does not enforce them.
 */
function buildClientClaimsBlock(clientClaims: PendingClientClaims | null | undefined, ui: ConsentUiRenderer): string {
  if (!clientClaims || typeof clientClaims !== "object") {
    return "";
  }
  const commitments = Array.isArray(clientClaims.commitments)
    ? clientClaims.commitments.filter((c: unknown): c is string => typeof c === "string" && c.trim() !== "")
    : [];
  if (commitments.length === 0) {
    return "";
  }
  const items = commitments.map((c: string) => `<li>${ui.escapeHtml(c)}</li>`).join("");
  const body = `<span class="pdpp-title">What this app says it will do</span><ul class="hosted-ui-client-claim-commitments">${items}</ul><p class="hosted-ui-client-claim-disclaimer">These are the app's own claims, not enforced by your server.</p>`;
  return renderAuthorshipBlock("client", "Client-authored claims", body, ui);
}

function displayOptional(value: string | null | undefined): string {
  return value ?? "None";
}

function displayList(values: string[] | null | undefined): string {
  return values && values.length > 0 ? values.join(", ") : "None";
}

function buildReviewedClientFacts(client: ApprovalReviewClient): Array<{ label: string; value: string }> {
  return [
    { label: "Client ID", value: client.client_id },
    { label: "Registration mode", value: client.registration_mode },
    { label: "Display name", value: displayOptional(client.client_display?.name) },
    { label: "Client URI", value: displayOptional(client.client_display?.uri) },
    { label: "Logo URI", value: displayOptional(client.client_display?.logo_uri) },
    { label: "Policy URI", value: displayOptional(client.client_display?.policy_uri) },
    { label: "Terms URI", value: displayOptional(client.client_display?.tos_uri) },
  ];
}

function renderReviewedStreams(streams: ApprovalReviewStream[], ui: ConsentUiRenderer): string {
  return streams
    .map((stream) => {
      const timeFacts = stream.time_constraint
        ? [
            { label: "Time field", value: stream.time_constraint.field },
            { label: "Since", value: displayOptional(stream.time_constraint.since) },
            { label: "Until", value: displayOptional(stream.time_constraint.until) },
          ]
        : [{ label: "Time constraint", value: "None" }];
      return ui.renderSurface({
        ariaLabel: `Reviewed stream ${stream.name}`,
        children: `<h4 class="pdpp-title">${ui.escapeHtml(stream.name)}</h4>${ui.renderKeyValueList([
          { label: "Instance IDs", value: displayList(stream.instance_ids) },
          { label: "Fields", value: displayList(stream.fields) },
          { label: "Resources", value: displayList(stream.resources) },
          ...timeFacts,
        ])}`,
        surface: "protocol",
      });
    })
    .join("\n");
}

function buildReviewedSelectionFacts(review: SingleApprovalReviewArtifact | ApprovalReviewSourceEntry) {
  return [
    { label: "Purpose code", value: review.purpose_code },
    { label: "Purpose description", value: displayOptional(review.purpose_description) },
    { label: "Access mode", value: review.access_mode },
    { label: "Selection preset", value: displayOptional(review.selection_preset) },
    { label: "Retention duration", value: displayOptional(review.retention?.max_duration) },
    { label: "Retention on expiry", value: displayOptional(review.retention?.on_expiry) },
  ];
}

function buildReviewedSourceFacts(
  source: ApprovalReviewSource,
  declaration: ApprovalReviewSourceDeclaration
): Array<{ label: string; value: string }> {
  const resourceAuthority = declaration.resource_authority;
  const authorityFacts: Array<{ label: string; value: string }> = [];
  if (resourceAuthority?.status === "verified") {
    authorityFacts.push({
      label: "Resource authority",
      value: `Verified (${resourceAuthority.authority_binding})`,
    });
  } else if (resourceAuthority?.status === "local_operator_provisioned") {
    authorityFacts.push({
      label: "Resource authority",
      value: "Local operator provisioning (not verified discovery)",
    });
  }
  return [
    { label: "Source ID", value: source.id },
    { label: "Source kind", value: source.kind },
    { label: "Declaration version", value: declaration.version },
    { label: "Declaration digest", value: declaration.digest },
    ...(declaration.accepted_revision_reference
      ? [{ label: "Accepted revision", value: declaration.accepted_revision_reference }]
      : []),
    ...authorityFacts,
    ...(declaration.publisher_attribution
      ? [
          {
            label: "Publisher attribution",
            value: `${declaration.publisher_attribution.id} (unverified)`,
          },
        ]
      : []),
  ];
}

function displayAiTrainingDecision(value: boolean | null): string {
  if (value === null) {
    return "Not applicable";
  }
  return value ? "Agreed" : "Not agreed";
}

function renderReviewedNarrowing(
  narrowing: BatchApprovalReviewArtifact["source_narrowing"][string] | undefined,
  ui: ConsentUiRenderer
): string {
  if (!narrowing) {
    return ui.renderKeyValueList([{ label: "Owner narrowing", value: "None" }]);
  }
  const fieldEntries = narrowing.fields
    ? Object.entries(narrowing.fields).map(([stream, fields]) => `${stream}: ${displayList(fields)}`)
    : [];
  const sinceEntries = narrowing.since
    ? Object.entries(narrowing.since).map(([stream, since]) => `${stream}: ${since}`)
    : [];
  return ui.renderKeyValueList([
    { label: "Streams kept", value: displayList(narrowing.streams) },
    { label: "Field narrowing", value: displayList(fieldEntries) },
    { label: "Time narrowing", value: displayList(sinceEntries) },
  ]);
}

function renderRequestedStreamItem(stream: StreamItem, ui: ConsentUiRenderer): string {
  const since = stream.time_constraint?.since ?? stream.time_range?.since;
  const fragments = [
    since ? `since ${since}` : null,
    stream.fields ? `fields: ${stream.fields.join(", ")}` : null,
    stream.view ? `view: ${stream.view}` : null,
    stream.necessity === "optional" ? "optional" : null,
  ].filter(Boolean);
  const meta = fragments.length
    ? ` <span class="hosted-ui-stream-meta">${ui.escapeHtml(fragments.join(" · "))}</span>`
    : "";
  return `<li><span class="hosted-ui-stream-name">${ui.escapeHtml(stream.name)}</span>${meta}</li>`;
}

function buildStreamsBlock(
  requestedStreams: StreamItem[],
  sourceLabel: string,
  manifestStreamNames: string[] | null,
  ui: ConsentUiRenderer
): string {
  const isWildcard = requestedStreams.length === 1 && requestedStreams[0]?.name === "*";
  if (isWildcard) {
    const resolvedNames = manifestStreamNames && manifestStreamNames.length > 0 ? manifestStreamNames : null;
    const countSummary = resolvedNames
      ? `All streams for ${sourceLabel} (${resolvedNames.length}) are in scope.`
      : `All streams for ${sourceLabel} are in scope.`;
    const resolvedList = resolvedNames
      ? `<ul class="hosted-ui-streams">${resolvedNames
          .map((name) => `<li><span class="hosted-ui-stream-name">${ui.escapeHtml(name)}</span></li>`)
          .join("")}</ul>`
      : "";
    return `
      <div>
        <span class="pdpp-title">Streams requested</span>
        <div class="hosted-ui-warning" role="note">
          <span class="hosted-ui-warning-title">All streams</span>
          <span class="hosted-ui-warning-body">${ui.escapeHtml(countSummary)}</span>
        </div>
        ${resolvedList}
      </div>`;
  }
  const streamItems = requestedStreams.map((s) => renderRequestedStreamItem(s, ui)).join("");
  return `
      <div>
        <span class="pdpp-title">Streams requested</span>
        <ul class="hosted-ui-streams">${streamItems}</ul>
      </div>`;
}

function buildBatchRiskHeader(risk: PendingConsentCumulativeRisk | null | undefined, ui: ConsentUiRenderer): string {
  const items = [
    { label: "Sources in this request", value: risk?.source_count ?? 0 },
    { label: "Sensitive sources", value: risk?.sensitive_source_count ?? 0 },
    { label: "Continuous-access sources", value: risk?.continuous_access_count ?? 0 },
    { label: "Sources with no time bound", value: risk?.no_time_bound_count ?? 0 },
    { label: "Sources without field projection", value: risk?.no_field_projection_count ?? 0 },
    { label: "Total streams", value: risk?.total_stream_count ?? 0 },
  ];
  return ui.renderSurface({
    ariaLabel: "Cumulative batch risk",
    children: `<span class="pdpp-eyebrow">Reference-experimental batch consent</span>
<h2 class="pdpp-heading">Cumulative access across this request</h2>
${ui.renderKeyValueList(items)}`,
    surface: "human",
  });
}

function buildBatchSourceCards(cards: PendingConsentCard[], ui: ConsentUiRenderer): string {
  return cards
    .map((card) => {
      const sourceLabel = card.source?.id || `source ${card.index + 1}`;
      const streams = Array.isArray(card.resolvedStreams) ? card.resolvedStreams : [];
      // MANIFEST: the requested streams, named/described by the manifest.
      const manifestBlock = renderAuthorshipBlock(
        "manifest",
        `Requested streams for ${sourceLabel}`,
        buildStreamsBlock(streams, sourceLabel, card.manifestStreamNames ?? null, ui),
        ui
      );
      // PROTOCOL: source binding, access mode, and sensitivity — server-derived.
      const protocolBlock = renderAuthorshipBlock(
        "protocol",
        `Protocol facts for ${sourceLabel}`,
        ui.renderKeyValueList([
          { label: "Source", value: sourceLabel },
          { label: "Access mode", value: card.access_mode || "unspecified" },
          { label: "Sensitivity", value: card.sensitivity || "standard" },
        ]),
        ui
      );
      // CLIENT: the client-authored purpose for this source. Rendered as a
      // claim, never as a fact.
      const clientPurpose = card.purpose_code || "unspecified";
      const clientPurposeBlock = renderAuthorshipBlock(
        "client",
        `Client-authored purpose for ${sourceLabel}`,
        ui.renderKeyValueList([{ label: "Stated purpose", value: clientPurpose }]),
        ui
      );
      const clientClaimsBlock = buildClientClaimsBlock(card.client_claims, ui);
      return ui.renderSurface({
        ariaLabel: `Source ${card.index + 1}`,
        children: `<h3 class="pdpp-title">${ui.escapeHtml(
          sourceLabel
        )}</h3>${clientPurposeBlock}${clientClaimsBlock}${manifestBlock}${protocolBlock}`,
        surface: "human",
      });
    })
    .join("\n");
}

// Base64url-encode a stream name so it is safe to embed inside a flat HTML
// form field name (narrow_fields_<index>__<encoded>, narrow_since_<encoded>).
// transport adapter (`decodeStreamKey` in as-consent.ts) decodes it
// symmetrically with `Buffer.from(…, "base64url")`.
function encodeStreamKey(name: string): string {
  return Buffer.from(name, "utf8").toString("base64url");
}

// Per-source owner narrowing controls, rendered inside the per-source confirm
// form. The owner may drop staged streams (uncheck), reduce a stream's fields
// (uncheck), and tighten a stream's existing time bound (date input). Every
// control defaults to the staged value, so submitting without touching them
// reproduces the staged request unchanged. Widening is not representable: the
// controls only offer what the client staged, and the server re-validates the
// posted narrowing against the staged baseline.
function buildSourceNarrowingControls(card: PendingConsentCard, ui: ConsentUiRenderer): string {
  const streams = Array.isArray(card.resolvedStreams) ? card.resolvedStreams : [];
  if (streams.length === 0) {
    return "";
  }
  // biome-ignore lint/style/useDestructuring: Explicit property or positional access documents this compatibility boundary.
  const index = card.index;
  const streamRows = streams
    .map((stream) => {
      const encoded = encodeStreamKey(stream.name);
      const streamToggle = `<label class="hosted-ui-narrow-stream"><input type="checkbox" name="narrow_streams_${index}" value="${ui.escapeHtml(
        stream.name
      )}" checked /> <span class="hosted-ui-stream-name">${ui.escapeHtml(stream.name)}</span></label>`;

      const fields = Array.isArray(stream.fields) ? stream.fields : null;
      const fieldControls = fields
        ? `<div class="hosted-ui-narrow-fields" aria-label="Fields for ${ui.escapeHtml(stream.name)}">${fields
            .map(
              (field) =>
                `<label class="hosted-ui-narrow-field"><input type="checkbox" name="narrow_fields_${index}__${encoded}" value="${ui.escapeHtml(
                  field
                )}" checked /> ${ui.escapeHtml(field)}</label>`
            )
            .join("")}</div>`
        : "";

      const since = stream.time_constraint?.since;
      const sinceControl = since
        ? `<label class="hosted-ui-narrow-since">Start no earlier than <input type="text" name="narrow_since_${index}__${encoded}" value="${ui.escapeHtml(
            since
          )}" placeholder="${ui.escapeHtml(since)}" /></label>`
        : "";

      return `<div class="hosted-ui-narrow-stream-row">${streamToggle}${sinceControl}${fieldControls}</div>`;
    })
    .join("\n");

  return `<details class="hosted-ui-narrow"><summary class="pdpp-title">Narrow this source (optional)</summary>
<p class="pdpp-body">Uncheck streams or fields to share less, or tighten a start date. You can only reduce what was requested; you cannot add anything here.</p>
${streamRows}</details>`;
}

const APPROVE_ALL_SUPPRESSION_LABELS: Record<string, string> = {
  continuous_all_streams: "a source requests continuous access to all of its streams",
  sensitive_no_time_bound: "a sensitive source has no time bound",
  three_or_more_sensitive_sources: "three or more sources are sensitive",
};

function buildPerSourceConfirmForm(
  cards: PendingConsentCard[],
  requestUri: string,
  reviewRevision: string | null | undefined,
  csrfToken: string | null,
  csrfFieldName: string,
  ui: ConsentUiRenderer
): string {
  const csrfInput = csrfToken
    ? `<input type="hidden" name="${ui.escapeHtml(csrfFieldName)}" value="${ui.escapeHtml(csrfToken)}" />`
    : "";
  const checkboxes = cards
    .map((card) => {
      const sourceLabel = card.source?.id || `source ${card.index + 1}`;
      const narrowControls = buildSourceNarrowingControls(card, ui);
      return `<div class="hosted-ui-source-block"><label class="hosted-ui-source-toggle"><input type="checkbox" name="approved_source_indexes" value="${ui.escapeHtml(
        String(card.index)
      )}" checked /> ${ui.escapeHtml(sourceLabel)}</label>${narrowControls}</div>`;
    })
    .join("\n");
  const reviewInput = reviewRevision
    ? `<input type="hidden" name="approval_review_revision" value="${ui.escapeHtml(reviewRevision)}" />`
    : "";
  return `<form class="hosted-ui-form" method="POST" action="/consent/review" aria-label="Confirm each source">
  ${csrfInput}${reviewInput}<input type="hidden" name="request_uri" value="${ui.escapeHtml(requestUri)}" />
<div class="hosted-ui-source-toggles"><span class="pdpp-title">Confirm each source</span>${checkboxes}</div>
<button type="submit" class="hosted-ui-button" data-variant="primary">Confirm selected sources</button>
</form>`;
}

function buildApproveAllForm(
  cards: PendingConsentCard[],
  requestUri: string,
  csrfToken: string | null,
  csrfFieldName: string,
  ui: ConsentUiRenderer
): string {
  const csrfInput = csrfToken
    ? `<input type="hidden" name="${ui.escapeHtml(csrfFieldName)}" value="${ui.escapeHtml(csrfToken)}" />`
    : "";
  const sourceList = cards.map((card) => ui.escapeHtml(card.source?.id || `source ${card.index + 1}`)).join(", ");
  return `<form class="hosted-ui-form" method="POST" action="/consent/review" aria-label="Allow all sources">
  ${csrfInput}<input type="hidden" name="request_uri" value="${ui.escapeHtml(requestUri)}" />
<label class="hosted-ui-source-toggle"><input type="checkbox" name="confirm_approve_all" value="1" required /> I confirm allowing all ${cards.length} sources: ${sourceList}</label>
<button type="submit" class="hosted-ui-button" data-variant="default">Allow all sources</button>
</form>`;
}

function buildFinalBatchReviewForm(
  cards: PendingConsentCard[],
  requestUri: string,
  reviewRevision: string,
  csrfToken: string | null,
  csrfFieldName: string,
  ui: ConsentUiRenderer
): string {
  const csrfInput = csrfToken
    ? `<input type="hidden" name="${ui.escapeHtml(csrfFieldName)}" value="${ui.escapeHtml(csrfToken)}" />`
    : "";
  const sourceList = cards
    .map((card) => `<li>${ui.escapeHtml(card.source?.id || `source ${card.index + 1}`)}</li>`)
    .join("");
  return `<form class="hosted-ui-form" method="POST" action="/consent/approve" aria-label="Confirm reviewed batch decision">
  ${csrfInput}<input type="hidden" name="request_uri" value="${ui.escapeHtml(requestUri)}" />
  <input type="hidden" name="approval_review_revision" value="${ui.escapeHtml(reviewRevision)}" />
<div class="hosted-ui-source-toggles"><span class="pdpp-title">Reviewed sources</span><ul>${sourceList}</ul></div>
<label class="hosted-ui-source-toggle"><input type="checkbox" name="confirm_reviewed_decision" value="1" required /> I confirm this reviewed decision</label>
<button type="submit" class="hosted-ui-button" data-variant="primary">Approve reviewed decision</button>
</form>`;
}

function renderReviewedBatchConsentHtml(
  review: BatchApprovalReviewArtifact,
  pending: PendingGrant,
  requestUri: string,
  csrfToken: string | null,
  csrfFieldName: string,
  providerName: string,
  ui: ConsentUiRenderer
): string {
  if (!pending.reviewRevision) {
    throw new Error("Reviewed batch consent is missing its approval revision");
  }
  const cards: PendingConsentCard[] = review.sources.map((source) => ({
    access_mode: source.access_mode,
    client_claims: source.client_claims,
    index: source.index,
    purpose_code: source.purpose_code,
    resolvedStreams: source.resolved_streams,
    retention: source.retention,
    source: source.source,
  }));
  const csrfHidden = csrfToken ? [{ name: csrfFieldName, value: csrfToken }] : [];
  const denyForm = ui.renderActionRow([
    {
      action: "/consent/deny",
      hidden: [...csrfHidden, { name: "request_uri", value: requestUri }],
      label: "Deny",
      method: "POST",
      variant: "danger",
    },
  ]);
  const sourceSections = review.sources
    .map((source, order) =>
      ui.renderSurface({
        ariaLabel: `Reviewed source ${source.index + 1}`,
        children: [
          `<h3 class="pdpp-heading">${ui.escapeHtml(source.source.id)}</h3>`,
          ui.renderKeyValueList([
            { label: "Approval order", value: order + 1 },
            { label: "Staged source index", value: source.index },
            ...buildReviewedSourceFacts(source.source, source.source_declaration),
            ...buildReviewedSelectionFacts(source),
          ]),
          buildClientClaimsBlock(source.client_claims, ui),
          renderReviewedNarrowing(review.source_narrowing[String(source.index)], ui),
          `<span class="pdpp-title">Exact reviewed streams</span>${renderReviewedStreams(source.resolved_streams, ui)}`,
        ].join("\n"),
        surface: "human",
      })
    )
    .join("\n");
  const actions = [
    buildFinalBatchReviewForm(cards, requestUri, pending.reviewRevision, csrfToken, csrfFieldName, ui),
    denyForm,
  ].join("\n");
  const body = [
    ui.renderPageIntro({
      eyebrow: "Final approval",
      lede: "These are the exact facts your server saved when you completed review.",
      title: "Approve the reviewed sources",
    }),
    ui.renderSurface({
      ariaLabel: "Reviewed batch decision",
      children: ui.renderKeyValueList([
        ...buildReviewedClientFacts(review.client),
        { label: "Subject ID", value: review.subject.id },
        { label: "Access mode", value: displayOptional(review.access_mode) },
        { label: "Grant expiry", value: displayOptional(review.expires_at) },
        { label: "Parent package ID", value: displayOptional(review.parent_package_id) },
        { label: "Approved source order", value: review.approved_source_indexes.join(", ") },
      ]),
      surface: "human",
    }),
    sourceSections,
    ui.renderSurface({ ariaLabel: "Consent actions", children: actions, surface: "human" }),
  ].join("\n");
  return ui.renderHostedDocument({
    body,
    providerName,
    title: `${providerName} — Reviewed batch consent`,
  });
}

function renderBatchConsentHtml(
  pending: PendingGrant,
  requestUri: string,
  csrfToken: string | null,
  csrfFieldName: string,
  providerName: string,
  ui: ConsentUiRenderer
): string {
  if (pending.review?.version === "reference.batch-approval-review.v1") {
    return renderReviewedBatchConsentHtml(
      pending.review,
      pending,
      requestUri,
      csrfToken,
      csrfFieldName,
      providerName,
      ui
    );
  }
  // biome-ignore lint/style/useDestructuring: Explicit property or positional access documents this compatibility boundary.
  const request = pending.request;
  const client = request.client || {};
  const clientDisplay = buildConsentClientDisplay(client, ui);
  const cards = Array.isArray(pending.cards) ? pending.cards : [];
  const csrfHidden = csrfToken ? [{ name: csrfFieldName, value: csrfToken }] : [];
  const approveAllSuppressed = pending.approveAllGate?.approve_all_suppressed === true;
  const suppressionReasons = Array.isArray(pending.approveAllGate?.suppression_reasons)
    ? pending.approveAllGate.suppression_reasons
    : [];
  const suppressionNote = approveAllSuppressed
    ? `<div class="hosted-ui-warning" role="note"><span class="hosted-ui-warning-title">Per-source confirmation required</span><span class="hosted-ui-warning-body">${ui.escapeHtml(
        `This request is too broad for a single approve-all (${suppressionReasons
          .map((reason) => APPROVE_ALL_SUPPRESSION_LABELS[reason] || reason)
          .join("; ")}). Confirm each source individually below.`
      )}</span></div>`
    : "";
  const broadWarning = pending.softCapWarning
    ? `<div class="hosted-ui-warning" role="note"><span class="hosted-ui-warning-title">Broad setup</span><span class="hosted-ui-warning-body">This request is at or above the reference warning threshold.</span></div>`
    : "";
  const overCapSourceLabels = Array.isArray(pending.overCapSources)
    ? pending.overCapSources.map((source) => source?.id || "unnamed source")
    : [];
  const overCapWarning = pending.overSoftCap
    ? `<div class="hosted-ui-warning" role="note"><span class="hosted-ui-warning-title">Over the soft cap</span><span class="hosted-ui-warning-body">${ui.escapeHtml(
        `This request stages ${cards.length} sources, above the reference soft cap of ${
          pending.softCap ?? cards.length
        }. No sources were dropped; review the over-cap sources individually: ${
          overCapSourceLabels.length > 0 ? overCapSourceLabels.join(", ") : "unnamed sources"
        }.`
      )}</span></div>`
    : "";
  const denyForm = ui.renderActionRow([
    {
      action: "/consent/deny",
      hidden: [...csrfHidden, { name: "request_uri", value: requestUri }],
      label: "Deny",
      method: "POST",
      variant: "danger",
    },
  ]);
  const actions = pending.reviewRevision
    ? [buildFinalBatchReviewForm(cards, requestUri, pending.reviewRevision, csrfToken, csrfFieldName, ui), denyForm]
        .filter(Boolean)
        .join("\n")
    : [
        suppressionNote,
        buildPerSourceConfirmForm(cards, requestUri, null, csrfToken, csrfFieldName, ui),
        approveAllSuppressed ? "" : buildApproveAllForm(cards, requestUri, csrfToken, csrfFieldName, ui),
        denyForm,
      ]
        .filter(Boolean)
        .join("\n");

  const body = [
    ui.renderPageIntro({
      eyebrow: "Data access request",
      lede: "Review each source. Your server will only issue grants for sources you confirm.",
      title: `${clientDisplay.titleName} wants access to several sources`,
    }),
    ui.renderSurface({
      ariaLabel: "Client identity",
      children: [
        clientDisplay.protocolFacts.length > 0
          ? renderAuthorshipBlock("protocol", "Client identity", ui.renderKeyValueList(clientDisplay.protocolFacts), ui)
          : "",
        clientDisplay.clientFacts.length > 0
          ? renderAuthorshipBlock(
              "client",
              "Client-authored display",
              ui.renderKeyValueList(clientDisplay.clientFacts),
              ui
            )
          : "",
      ]
        .filter(Boolean)
        .join("\n"),
      surface: "human",
    }),
    overCapWarning,
    broadWarning,
    buildBatchRiskHeader(pending.cumulativeRisk, ui),
    buildBatchSourceCards(cards, ui),
    ui.renderSurface({ ariaLabel: "Consent actions", children: actions, surface: "human" }),
  ]
    .filter(Boolean)
    .join("\n");

  return ui.renderHostedDocument({
    body,
    providerName,
    title: `${providerName} — Batch consent request`,
  });
}

function hiddenInputs(fields: Array<{ name: string; value: string }>, ui: ConsentUiRenderer): string {
  return fields
    .map((field) => `<input type="hidden" name="${ui.escapeHtml(field.name)}" value="${ui.escapeHtml(field.value)}" />`)
    .join("");
}

function buildSingleConsentActions({
  csrfFieldName,
  csrfToken,
  isAiTraining,
  pending,
  requestUri,
  ui,
}: {
  csrfFieldName: string;
  csrfToken: string | null;
  isAiTraining: boolean;
  pending: PendingGrant;
  requestUri: string;
  ui: ConsentUiRenderer;
}): string {
  const csrfHidden = csrfToken ? [{ name: csrfFieldName, value: csrfToken }] : [];
  const reviewHidden = pending.reviewRevision
    ? [{ name: "approval_review_revision", value: pending.reviewRevision }]
    : [];
  const allowAction = pending.reviewRevision
    ? ui.renderActionRow([
        {
          action: "/consent/approve",
          hidden: [...csrfHidden, ...reviewHidden, { name: "request_uri", value: requestUri }],
          label: "Allow access",
          method: "POST",
          variant: "primary",
        },
      ])
    : `<form class="hosted-ui-form" method="POST" action="/consent/review" aria-label="Finalize consent review">
${hiddenInputs(csrfHidden, ui)}<input type="hidden" name="request_uri" value="${ui.escapeHtml(requestUri)}" />
${
  isAiTraining
    ? '<label class="hosted-ui-source-toggle"><input type="checkbox" name="ai_training_consented" value="1" required /> I explicitly agree to AI training use</label>'
    : ""
}
<button type="submit" class="hosted-ui-button" data-variant="primary">Allow access</button>
</form>`;
  const denyAction = ui.renderActionRow([
    {
      action: "/consent/deny",
      hidden: [...csrfHidden, { name: "request_uri", value: requestUri }],
      label: "Deny",
      method: "POST",
      variant: "danger",
    },
  ]);
  return [allowAction, denyAction].join("\n");
}

function renderReviewedSingleConsentHtml(
  review: SingleApprovalReviewArtifact,
  pending: PendingGrant,
  requestUri: string,
  csrfToken: string | null,
  csrfFieldName: string,
  providerName: string,
  ui: ConsentUiRenderer
): string {
  const actions = buildSingleConsentActions({
    csrfFieldName,
    csrfToken,
    isAiTraining: false,
    pending,
    requestUri,
    ui,
  });
  const body = [
    ui.renderPageIntro({
      eyebrow: "Final approval",
      lede: "These are the exact facts your server saved when you completed review.",
      title: "Approve the reviewed data access",
    }),
    ui.renderSurface({
      ariaLabel: "Reviewed consent decision",
      children: [
        renderAuthorshipBlock(
          "protocol",
          "Reviewed client and subject",
          ui.renderKeyValueList([
            ...buildReviewedClientFacts(review.client),
            { label: "Subject ID", value: review.subject.id },
          ]),
          ui
        ),
        renderAuthorshipBlock(
          "protocol",
          "Reviewed source declaration",
          ui.renderKeyValueList(buildReviewedSourceFacts(review.source, review.source_declaration)),
          ui
        ),
        renderAuthorshipBlock(
          "client",
          "Reviewed purpose",
          [ui.renderKeyValueList(buildReviewedSelectionFacts(review)), buildClientClaimsBlock(review.client_claims, ui)]
            .filter(Boolean)
            .join("\n"),
          ui
        ),
        renderAuthorshipBlock(
          "protocol",
          "Reviewed approval conditions",
          ui.renderKeyValueList([
            { label: "AI training consent", value: displayAiTrainingDecision(review.ai_training_consented) },
            { label: "Grant expiry", value: displayOptional(review.expires_at) },
          ]),
          ui
        ),
        `<span class="pdpp-title">Exact reviewed streams</span>${renderReviewedStreams(review.resolved_streams, ui)}`,
        actions,
      ].join("\n"),
      surface: "human",
    }),
  ].join("\n");
  return ui.renderHostedDocument({
    body,
    providerName,
    title: `${providerName} — Reviewed consent`,
  });
}

/**
 * Renders the active consent review page for GET /consent when a live
 * pending-consent row exists. The owner reviews streams, facts, and submits
 * approve/deny via the rendered form.
 */
export function renderPendingGrantConsentHtml(
  pending: PendingGrant,
  requestUri: string,
  csrfToken: string | null,
  csrfFieldName: string,
  providerName: string,
  ui: ConsentUiRenderer
): string {
  if (pending.batch) {
    return renderBatchConsentHtml(pending, requestUri, csrfToken, csrfFieldName, providerName, ui);
  }
  if (pending.review?.version === "reference.approval-review.v1") {
    return renderReviewedSingleConsentHtml(
      pending.review,
      pending,
      requestUri,
      csrfToken,
      csrfFieldName,
      providerName,
      ui
    );
  }

  // biome-ignore lint/style/useDestructuring: Explicit property or positional access documents this compatibility boundary.
  const request = pending.request;
  const client = request.client || {};
  const selection = request.selection || {};
  const sourceBinding = request.source_binding;
  const clientDisplay = buildConsentClientDisplay(client, ui);
  const sourceLabel = sourceBinding?.id || "this source";
  const sourceFactLabel = sourceBinding?.kind === "provider_native" ? "Provider" : "Connector";

  const requestedStreams = Array.isArray(selection.streams) ? selection.streams : [];
  const manifestStreamNames = Array.isArray(pending.manifestStreamNames) ? pending.manifestStreamNames : null;

  const streamsBlock = buildStreamsBlock(requestedStreams, sourceLabel, manifestStreamNames, ui);

  const isContinuous = selection.access_mode === "continuous";
  const hasRetentionBound = Boolean(selection.retention?.max_duration);

  let continuousBlock = "";
  if (isContinuous) {
    const continuousBody = hasRetentionBound
      ? "This is long-lived access — the client may keep reading until the grant is revoked or its retention bound is reached."
      : "This is long-lived access with no explicit expiry. The client may keep reading until you revoke the grant.";
    continuousBlock = `
      <div class="hosted-ui-warning" role="note">
        <span class="hosted-ui-warning-title">Continuous access</span>
        <span class="hosted-ui-warning-body">${ui.escapeHtml(continuousBody)}</span>
      </div>`;
  }

  // PROTOCOL: facts the owner's server enforces or verifies. The client-identity
  // origin (for CIMD clients), the source binding, the access mode, and the
  // retention bound are all server-determined — never client-asserted.
  const protocolFactsRaw: Array<{ label: string; value?: unknown; html?: string } | null> = [
    ...clientDisplay.protocolFacts,
    sourceBinding?.id ? { label: sourceFactLabel, value: sourceBinding.id } : null,
    { label: "Access mode", value: selection.access_mode },
    selection.retention
      ? {
          label: "Retention",
          value: `${selection.retention.on_expiry} after ${selection.retention.max_duration}`,
        }
      : null,
  ];
  const protocolFacts = protocolFactsRaw.filter(
    (x): x is { label: string; value?: unknown; html?: string } => x !== null
  );
  const protocolBlock =
    protocolFacts.length > 0
      ? renderAuthorshipBlock("protocol", "Protocol facts", ui.renderKeyValueList(protocolFacts), ui)
      : "";

  // CLIENT: the client's own claims about itself — its self-described app name
  // and the free-text purpose it stated. Rendered as claims, never as facts.
  const clientFactsRaw: Array<{ label: string; value?: unknown; html?: string }> = [...clientDisplay.clientFacts];
  const clientPurpose = selection.purpose_description || selection.purpose_code;
  if (clientPurpose) {
    clientFactsRaw.push({ label: "Stated purpose", value: clientPurpose });
  }
  const clientIdentityBlock =
    clientFactsRaw.length > 0
      ? renderAuthorshipBlock("client", "Client-authored display", ui.renderKeyValueList(clientFactsRaw), ui)
      : "";

  // CLIENT: top-level client_claims.commitments, if any.
  const clientClaimsBlock = buildClientClaimsBlock(selection.client_claims, ui);

  // MANIFEST: the streams the owner's server is being asked to project, named
  // and described by the resolved manifest (owner-trusted human descriptions).
  const manifestBlock = renderAuthorshipBlock("manifest", "Requested streams", streamsBlock, ui);

  const codeBlock = pending.userCode
    ? `<div><span class="pdpp-eyebrow">Verification code</span><div class="hosted-ui-code">${ui.escapeHtml(pending.userCode)}</div></div>`
    : "";
  const actions = buildSingleConsentActions({
    csrfFieldName,
    csrfToken,
    isAiTraining: selection.purpose_code === "https://pdpp.dev/purpose/ai_training",
    pending,
    requestUri,
    ui,
  });

  const body = [
    ui.renderPageIntro({
      eyebrow: "Data access request",
      lede: "Review what this app is asking for. Your server will only release what you allow here.",
      title: `${clientDisplay.titleName} wants access to your data`,
    }),
    ui.renderSurface({
      ariaLabel: "Consent request",
      children: [
        codeBlock,
        clientIdentityBlock,
        clientClaimsBlock,
        manifestBlock,
        protocolBlock,
        continuousBlock,
        actions,
      ]
        .filter(Boolean)
        .join("\n"),
      surface: "human",
    }),
  ].join("\n");

  return ui.renderHostedDocument({
    body,
    providerName,
    title: `${providerName} — Consent request`,
  });
}

// MCP picker HTML renderer.

interface AuthorizeQueryParams {
  client_id?: unknown;
  code_challenge?: unknown;
  code_challenge_method?: unknown;
  redirect_uri?: unknown;
  response_type?: unknown;
  scope?: unknown;
  state?: unknown;
  [key: string]: unknown;
}

/**
 * Renders the picker's client-identity block: monogram, the resolved display
 * name, its domain, and one trust status.
 *
 * The three-class authorship distinction (spec-core.md:716 MUST NOT flatten
 * protocol facts, server descriptions, and client claims) is preserved, but
 * carried by typography, placement, and ONE attributed line rather than by an
 * eyebrow banner over every block. The rule requires the distinction be
 * preserved; it does not require a printed label per group, and three
 * repeated eyebrows over facts that were all one category turned the trust
 * model into the visual noise that made this page read as a debug dump.
 *
 * A text monogram stands in for a remote logo fetch, which client-display:676
 * forbids for a client with no positive trust signal (every CIMD-resolved
 * client today).
 */
function renderHostedMcpClientIdentityBlock(clientDisplay: ConsentClientDisplay, ui: ConsentUiRenderer): string {
  // Trust status as a neutral fact, not a warning badge. spec-core.md:675 has
  // two limbs — render a positive signal distinctly when one exists, and
  // treat a client with none as unverified. Only the second is implementable
  // today (this AS has no trust registry), so every client sees this line;
  // a badge that cannot vary carries no information and reads as an
  // accusation against an app that has done nothing wrong. It states what the
  // server does and does not know, and names the consequence for the logo.
  const trustLine = clientDisplay.isUnverified
    ? `<p class="hosted-ui-client-trust" data-trust="unverified" role="status">This app isn't registered with your server. Its name and logo are self-reported.</p>`
    : `<p class="hosted-ui-client-trust" data-trust="registered" role="status">Registered with your server</p>`;
  const domainLine = clientDisplay.domainLabel
    ? `<span class="hosted-ui-client-identity-domain">${ui.escapeHtml(clientDisplay.domainLabel)}</span>`
    : "";
  // Name first (spec-core.md:673), domain as the quiet second line. The
  // origin used to BE the name here, so a request from ChatGPT headlined as
  // `https://chatgpt.com` while the resolved name sat below it labelled
  // "Self-described app name".
  const header = `<div class="hosted-ui-client-identity"><span class="hosted-ui-client-monogram" aria-hidden="true">${ui.escapeHtml(
    clientDisplay.monogram
  )}</span><span class="hosted-ui-client-identity-body"><span class="hosted-ui-client-identity-name">${ui.escapeHtml(
    clientDisplay.displayName
  )}</span>${domainLine}</span></div>${trustLine}`;
  const policyLinksHtml =
    clientDisplay.policyLinks.length > 0
      ? `<p class="hosted-ui-client-policy-links">${clientDisplay.policyLinks
          .map(
            (link) =>
              `<a href="${ui.escapeHtml(link.href)}" target="_blank" rel="noopener noreferrer">${ui.escapeHtml(
                link.label
              )}</a>`
          )
          .join("")}</p>`
      : "";
  // The identity facts the two blocks below used to print — `Client
  // identity: https://chatgpt.com` and `Self-described app name: ChatGPT` —
  // are both in the header now, as the domain line and the name. Reprinting
  // them under two eyebrows said the same two things three times. The
  // client-authored register survives where it still carries information:
  // policy/terms links the client published, attributed once.
  const clientBlock = policyLinksHtml
    ? renderAuthorshipBlock("client", "Links this app published", policyLinksHtml, ui)
    : "";
  return ui.renderSurface({
    ariaLabel: "Requesting app identity",
    children: [header, clientBlock].filter(Boolean).join("\n"),
    surface: "human",
  });
}

/**
 * Renders the picker's purpose statement. The hosted-MCP authorize shortcut
 * never receives `authorization_details` from the client (source-selection
 * requests carry no purpose_code) — this picker mints
 * `HOSTED_MCP_PICKER_PURPOSE_CODE`/`_DESCRIPTION` itself and assigns it to
 * every grant it issues. That is a server assignment, not a claim the client
 * made about itself, so this renders in the CLIENT-adjacent "server assigned"
 * framing rather than `renderAuthorshipBlock("client", ...)`'s "they claim"
 * eyebrow, which would misattribute authorship to an app that declared
 * nothing (spec-core.md:706-730 semantic classes).
 */
function renderHostedMcpTermsBlock(clientName: string, ui: ConsentUiRenderer): string {
  // One eyebrow, because this is one register. Purpose and retention are both
  // things THIS SERVER says — the owner was reading "Your server describes"
  // twice in a row, heading two facts of a single category.
  //
  // spec-core.md:716 requires the three authorship classes stay DISTINCT. It
  // does not require a printed banner above every group: typography,
  // placement, and one attribution carry a distinction perfectly well, and
  // repeating the label per block is what turned the trust model into the
  // visual noise that made this page read as a debug dump.
  return renderAuthorshipBlock(
    "manifest",
    "What this server sets and what the app said",
    ui.renderKeyValueList([
      {
        label: "Purpose",
        // One sentence, said once, with its origin named inside it.
        // This was three rows — a `Purpose` row saying the server assigned
        // it, a `Purpose description` row saying what it was, and a
        // `Purpose code` row printing `https://pdpp.dev/purpose/agent_context`
        // — for one idea. The registry code is a protocol identifier, not
        // owner-facing copy; it stays in the grant and the audit record.
        value: `Set by this server because ${clientName} didn't give one: use the data you select as context for your AI assistant.`,
      },
      { label: "Keeping your data", value: buildHostedMcpRetentionSentence(clientName) },
    ]),
    ui
  );
}

const RETENTION_ON_EXPIRY_COPY: Record<string, string> = {
  anonymize: "anonymizes",
  delete: "deletes",
};

/**
 * States what the requesting app said about keeping the data it receives.
 *
 * Retention is a commitment by the RECIPIENT (spec-core.md:951); this server
 * neither enforces it nor can reach data the client already holds
 * (spec-core.md:948). A hosted-MCP request carries no `authorization_details`,
 * so the client has said nothing — and the only honest rendering is to say
 * so, naming the app whose silence it is.
 *
 * This previously read "No retention commitment was declared by this app.
 * Your server's default applies: data it reads is deleted within 90 days."
 * The second sentence's subject is what the APP does, so it told the owner
 * ChatGPT deletes their data — a promise ChatGPT never made and this server
 * cannot cause. The `Your server describes` framing did not cure it. If
 * `HOSTED_MCP_PICKER_RETENTION` is ever set by an operator, it renders as
 * this server's own requirement, never as the client's acceptance.
 */
/**
 * The single retention sentence, used by both the terms block and the review
 * panel so the two can never drift into saying different things.
 */
function buildHostedMcpRetentionSentence(clientName: string): string {
  const silence = `${clientName} did not say how long it keeps the data it receives.`;
  if (!HOSTED_MCP_PICKER_RETENTION) {
    return silence;
  }
  const onExpiry =
    RETENTION_ON_EXPIRY_COPY[HOSTED_MCP_PICKER_RETENTION.on_expiry] ?? HOSTED_MCP_PICKER_RETENTION.on_expiry;
  const days = HOSTED_MCP_PICKER_RETENTION.max_duration.replace("P", "").replace("D", " days");
  // The subject is this server's requirement, never the client's behavior —
  // the client has accepted nothing.
  return `${silence} This server requires that it ${onExpiry} the data within ${days}.`;
}

/**
 * Renders the hosted MCP multi-source picker page for GET /oauth/authorize
 * when no `authorization_details` or `connector_id` is specified.
 */
export async function renderHostedMcpSourceSelection(
  ownerSubjectId: string,
  query: AuthorizeQueryParams | null | undefined,
  csrfToken: string,
  providerName: string,
  caps: ConsentPickerCapabilities,
  ui: ConsentUiRenderer,
  opts: {
    validationError?: string | null;
    client?: PendingGrantRequest["client"] | null;
    /**
     * Absolute URL of the console's connections page, if the route can resolve
     * one. The empty picker uses it to give an owner with nothing connected
     * somewhere to go; when it is absent the page still offers Cancel, so this
     * only ever adds an exit, never removes one.
     *
     * INTEGRATOR: `as-authorize.ts` owns resolving this (it has
     * `resolvePublicUrl`); this renderer never constructs a URL itself.
     */
    connectionsUrl?: string | null;
  } = {}
): Promise<string> {
  const rows = await listHostedMcpPickerRows(caps, ownerSubjectId);

  // Client identity (client-display:672-677): resolve the same way the
  // reviewed/single-consent pages do, and render it here too — this picker is
  // the only approval surface a real hosted-MCP connector (ChatGPT, Claude,
  // any MCP client) ever reaches, and it previously showed no requester
  // identity at all.
  const clientDisplay = opts.client ? buildConsentClientDisplay(opts.client, ui) : null;
  const clientIdentityBlock = clientDisplay ? renderHostedMcpClientIdentityBlock(clientDisplay, ui) : "";
  // The name the owner reads, used in every sentence that talks about the
  // requester, so the page never says "this app" where it knows the name.
  const clientName = clientDisplay?.displayName ?? "This app";
  // Purpose and retention are one register and now one block — see
  // `renderHostedMcpTermsBlock`. Rendered only when there is something to
  // grant: on an empty picker the terms of a grant that cannot be made are
  // noise in front of the one thing that page needs to do, which is let the
  // owner leave.
  const termsBlock = rows.length ? renderHostedMcpTermsBlock(clientName, ui) : "";

  // Stale-review-revision rejection (AS-conformance #15): bind exactly what
  // this render offered as choosable into a digest the POST must reproduce
  // fresh before minting — see `resolveHostedMcpPickerSnapshotDigest`.
  const reviewSnapshotDigest = computeHostedMcpPickerSnapshotDigest(rows, clientDisplay);

  const hidden = [
    "client_id",
    "redirect_uri",
    "response_type",
    "scope",
    "state",
    "code_challenge",
    "code_challenge_method",
  ]
    .map((name) => {
      const value = query?.[name];
      if (typeof value !== "string") {
        return "";
      }
      return `<input type="hidden" name="${ui.escapeHtml(name)}" value="${ui.escapeHtml(value)}" />`;
    })
    .join("\n");

  const renderRowStreams = (row: HostedMcpPickerRow): string => {
    if (!Array.isArray(row.streams) || row.streams.length === 0) {
      return '<p class="hosted-ui-option-streams-empty">No data is available to share from this source.</p>';
    }
    const items = row.streams
      .map((stream) => {
        const streamFormValue = caps.encodeHostedMcpStreamSelection({
          connectionId: row.connectionId,
          connectorId: row.connectorId,
          streamName: stream.name,
        });
        // Engineering documentation is suppressed rather than shipped — see
        // `consentSafeStreamDescription`. The canonical stream name stays in
        // the form value (the enforced scope) and the audit record; only the
        // owner-facing label is humanized.
        const safeDescription = consentSafeStreamDescription(stream.description);
        const description = safeDescription
          ? `<span class="hosted-ui-stream-meta">${ui.escapeHtml(safeDescription)}</span>`
          : "";
        return `
            <label class="hosted-ui-stream-option">
              <input type="checkbox" name="stream" value="${ui.escapeHtml(streamFormValue)}" data-hosted-mcp-stream-checkbox data-source-key="${ui.escapeHtml(row.sourceKey)}" data-stream-name="${ui.escapeHtml(stream.name)}" />
              <span class="hosted-ui-stream-option-body">
                <span class="hosted-ui-stream-name">${ui.escapeHtml(humanizeStreamLabel(stream.name))}</span>
                ${description}
              </span>
            </label>
          `;
      })
      .join("\n");
    return `<div class="hosted-ui-option-streams" data-hosted-mcp-streams data-streams-enabled="true" aria-disabled="false">${items}</div>`;
  };

  // If every row's resolved source.kind is the same (the common case), state
  // it once above the list instead of repeating "Source kind: connector" on
  // every one of N rows; rows still carry a compact badge as the per-row
  // protocol-fact hook. `null` (unresolved) rows break uniformity so their
  // per-row line stays visible.
  const resolvedSourceKinds = rows.map((row) => row.sourceKind);
  const uniformSourceKind =
    resolvedSourceKinds.length > 0 && resolvedSourceKinds.every((kind) => kind && kind === resolvedSourceKinds[0])
      ? resolvedSourceKinds[0]
      : null;

  const options = rows.length
    ? rows
        .map((row, index) => {
          const summaryId = `hosted-mcp-source-summary-${index}`;
          const sourceKey = ui.escapeHtml(row.sourceKey);
          const sourceDisabled = !Array.isArray(row.streams) || row.streams.length === 0;
          const sourceDisabledAttrs = sourceDisabled ? ' disabled aria-disabled="true"' : "";
          const streamPreview = buildStreamPreview(row.streams);
          const previewBlock = streamPreview
            ? `<span class="hosted-ui-option-preview">${ui.escapeHtml(streamPreview)}</span>`
            : "";
          // `source.kind` (source-kinds:731-743) is real protocol, but its
          // audience is the CLIENT, which reads it as a trust expectation
          // about declaration provenance. To the owner, "connector" answers a
          // question nobody asked — and because every row on a real
          // deployment resolves to the same kind, it carried zero bits while
          // occupying a badge slot on all 27 rows.
          //
          // It stays in the audit record and the grant. When provenance ever
          // becomes non-uniform, the row that DIFFERS is worth surfacing —
          // worded as a consequence ("Read directly from Chase" vs "Read from
          // data you imported"), never as the raw enum.
          const sourceKindBlock =
            row.sourceKind && !uniformSourceKind
              ? `<span class="hosted-ui-option-source-kind" data-authorship="protocol">${ui.escapeHtml(
                  row.sourceKind === "connector" ? "Read directly from this source" : "Read from data you imported"
                )}</span>`
              : "";
          // The disclosure is its own control, beside the checkbox rather
          // than sharing its row. The checkbox grants the source; the
          // disclosure only reveals its streams. Those are different acts,
          // and when the affordance was `::after` generated text on the
          // summary, one tap on a phone had two plausible outcomes and the
          // control could be neither labelled nor sized.
          const disclosureLabel = `Show what ${row.connectorTypeLabel} can share`;
          // What the filter matches against: the source name, the connected
          // account, and the data types it holds — the three things an owner
          // would actually type. Precomputed here so the filter never has to
          // read the DOM's rendered text.
          const filterText = [row.connectorTypeLabel, row.connectionName ?? "", streamPreview]
            .filter(Boolean)
            .join(" ")
            .toLowerCase();
          return `
          <details class="hosted-ui-option-source" data-hosted-mcp-source data-source-key="${sourceKey}" data-source-selected="false" data-filter-text="${ui.escapeHtml(filterText)}">
            <summary class="hosted-ui-option-source-legend hosted-ui-option-summary">
              <label class="hosted-ui-option">
                <input type="checkbox" name="selection" value="${ui.escapeHtml(row.formValue)}" data-hosted-mcp-source-checkbox data-source-selection-mode="streams" data-source-key="${sourceKey}" aria-describedby="${summaryId}"${sourceDisabledAttrs} />
                <span class="hosted-ui-option-body">
                  <span class="hosted-ui-option-title">
                    <span class="hosted-ui-connector-type">${ui.escapeHtml(row.connectorTypeLabel)}</span>${row.connectionName ? `<span class="hosted-ui-connection-name">${ui.escapeHtml(row.connectionName)}</span>` : ""}
                  </span>
                  ${previewBlock}
                  <span class="hosted-ui-option-meta" id="${summaryId}">${ui.escapeHtml(row.meta)}</span>
                  ${sourceKindBlock}
                </span>
              </label>
              <span class="hosted-ui-disclosure" role="button" tabindex="0" aria-expanded="false" aria-label="${ui.escapeHtml(disclosureLabel)}" data-hosted-mcp-disclosure>
                <span class="hosted-ui-disclosure-label" aria-hidden="true">Choose data</span>
                <svg class="hosted-ui-disclosure-chevron" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" focusable="false"><path d="M3 1 L7 5 L3 9" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
              </span>
            </summary>
            ${renderRowStreams(row)}
          </details>
        `;
        })
        .join("\n")
    : // The empty picker used to be a hard dead end: no submit, no refusal,
      // no link out, on a page whose only message was that nothing was
      // available. An owner who reaches it must still be able to tell the
      // client no, and must be told what to do next.
      // A link only when the route resolved one — this renderer never
      // constructs a URL it cannot stand behind, and Cancel is present either
      // way, so the link can only ever add an exit.
      `<p class="pdpp-body">You haven&#39;t connected any data sources yet. Connect one, then start this request again.</p>
        <div class="hosted-ui-actions hosted-ui-decision-actions">
          <button type="submit" class="hosted-ui-button" data-variant="ghost" name="decision" value="cancel" formaction="/oauth/authorize/mcp-package/cancel" formnovalidate>Cancel</button>
          ${
            typeof opts.connectionsUrl === "string" && opts.connectionsUrl
              ? `<a class="hosted-ui-button" data-variant="primary" href="${ui.escapeHtml(opts.connectionsUrl)}">Connect a source</a>`
              : ""
          }
        </div>`;

  // ─── The approval artifact ────────────────────────────────────────────
  //
  // A live, exact statement of what the owner is about to allow, rendered
  // from the current form state and updated as they select. This is the page
  // that becomes the approval: the submitted `decision_digest` covers exactly
  // these terms, and the POST recomputes it from what it actually resolved.
  //
  // Everything not owner-variable on this surface (purpose, retention state,
  // client identity, expiry) is stated above and repeated here only as the
  // decision's own terms — the summary is the one place they appear together
  // as a single reviewable artifact.
  const reviewPanel = rows.length
    ? `<section class="hosted-ui-review" data-hosted-mcp-review aria-live="polite" aria-label="What you're allowing">
          <h2 class="pdpp-title">What you're allowing</h2>
          <p class="hosted-ui-review-empty" data-hosted-mcp-review-empty>Nothing selected yet.</p>
          <dl class="hosted-ui-kv hosted-ui-review-terms" data-hosted-mcp-review-terms hidden>
            <dt>App</dt><dd>${ui.escapeHtml(clientName)}</dd>
            <dt>Data</dt><dd data-hosted-mcp-review-scope></dd>
            <dt>Coverage</dt><dd>Everything in each data type you check, with no date limit.</dd>
            <dt>Duration</dt><dd data-hosted-mcp-review-duration></dd>
            <dt>Ends</dt><dd>${ui.escapeHtml(HOSTED_MCP_PICKER_GRANT_EXPIRY_COPY)}</dd>
            <dt>Keeping your data</dt><dd>${ui.escapeHtml(buildHostedMcpRetentionSentence(clientName))}</dd>
          </dl>
        </section>`
    : "";

  // Allow and Cancel sit together as a pair. Every consent screen in the
  // prior-art corpus has a refusal; this one had 59 buttons and every one of
  // them was affirmative, so the only exit was to close the tab — which
  // leaves the client with no response at all rather than the
  // `error=access_denied` RFC 6749 §4.1.2.1 requires.
  //
  // `Cancel`, not `Deny`: declining is not an error and should not be dressed
  // as one. Both appear in the corpus; `Cancel` is the more common shipped
  // label and carries no implication the owner did something adversarial.
  // It posts to the same form (carrying state, redirect_uri, and CSRF) with
  // `decision=cancel`, using formaction so no nested form is needed.
  const submit = rows.length
    ? `<div class="hosted-ui-actions hosted-ui-decision-actions">
          <button type="submit" class="hosted-ui-button" data-variant="ghost" name="decision" value="cancel" formaction="/oauth/authorize/mcp-package/cancel" formnovalidate>Cancel</button>
          <button type="submit" class="hosted-ui-button" data-variant="primary" name="decision" value="allow">Allow access</button>
        </div>`
    : "";

  const riskCopy = rows.length
    ? // The revoke promise is stated at package granularity because that is
      // the only granularity the product delivers: `POST
      // /grants/:grantId/revoke` exists and is proxied, but no UI calls it —
      // the only revoke control that ships is the all-or-nothing package
      // cascade at `/grants/packages/:packageId`. The page previously
      // promised "you can revoke any source you approve here later", which is
      // the promise that makes "yes" feel safe and which the owner cannot
      // actually act on. Saying less, truthfully, beats a reversibility
      // promise the product cannot keep.
      //
      // The ~70 words of checkbox instructions that used to lead this
      // paragraph are gone. A tri-state parent over a child list is a pattern
      // people know from every file manager; the behavior was already
      // implemented correctly (the parent goes `indeterminate` on partial
      // selection) and the copy was apologizing for a control that works.
      `<p class="pdpp-body">You can revoke this access later from your grants page.</p>`
    : "";

  const validationError = typeof opts.validationError === "string" ? opts.validationError.trim() : "";
  // Independent of `rows.length`: a validation error (e.g. the
  // stale-review-revision rejection) can be the reason the picker now has
  // FEWER rows than the owner saw last time — most acutely, zero rows, if
  // every source they'd selected was revoked between page-load and
  // submission. Suppressing the banner in exactly that case would hide the
  // one message that explains why the page just changed.
  const validationBanner =
    rows.length || validationError
      ? `<div class="hosted-ui-error hosted-ui-picker-error" role="alert" data-hosted-mcp-picker-error data-default-message="Choose at least one data type to continue."${validationError ? "" : " hidden"}>${ui.escapeHtml(validationError)}</div>`
      : "";

  // A filter earns its place only once the list stops being scannable. On
  // four rows it is chrome; on a real deployment's 27 collapsed sources
  // spanning a very long scroll it is the difference between finding Chase
  // and giving up. It deliberately carries no `name`: this form's field set
  // IS the grant, and a named input would post the owner's search string
  // into the authorization request.
  const SOURCE_FILTER_THRESHOLD = 8;
  const sourceFilter =
    rows.length > SOURCE_FILTER_THRESHOLD
      ? `
        <div class="hosted-ui-picker-filter">
          <label class="hosted-ui-picker-filter-label" for="hosted-mcp-filter">Filter sources</label>
          <input id="hosted-mcp-filter" type="search" class="hosted-ui-picker-filter-input" placeholder="Search ${rows.length} sources" autocomplete="off" data-hosted-mcp-filter />
          <p class="hosted-ui-picker-filter-empty" data-hosted-mcp-filter-empty hidden>No sources match that search.</p>
        </div>
      `
      : "";

  // The owner's running answer to "what am I about to allow", kept beside the
  // controls that change it. It starts honest — before any interaction the
  // answer is nothing — and it is the one place the page states the size of
  // the decision without the owner having to count checkboxes.
  const selectionCounter = rows.length
    ? `<p class="hosted-ui-picker-counter" role="status" aria-live="polite" data-hosted-mcp-counter>Nothing selected yet.</p>`
    : "";

  const bulkControls = rows.length
    ? `
        ${sourceFilter}
        <div class="hosted-ui-actions hosted-ui-picker-toolbar" aria-label="Source bulk controls">
          <button type="button" class="hosted-ui-button" data-hosted-mcp-select-sources>Select every source</button>
          <button type="button" class="hosted-ui-button" data-hosted-mcp-clear-sources>Clear selection</button>
          <span class="hosted-ui-toolbar-divider" aria-hidden="true"></span>
          <button type="button" class="hosted-ui-button" data-hosted-mcp-expand-all>Show all data types</button>
          <button type="button" class="hosted-ui-button" data-hosted-mcp-collapse-all>Hide all data types</button>
        </div>
        ${selectionCounter}
      `
    : "";

  const accessModeControl = rows.length
    ? `
        <fieldset class="hosted-ui-access-mode">
          <legend class="hosted-ui-access-mode-legend">Access duration</legend>
          <label class="hosted-ui-access-mode-option">
            <input type="radio" name="access_mode" value="continuous" checked />
            <span class="hosted-ui-access-mode-body">
              <span class="hosted-ui-access-mode-label">Ongoing access</span>
              <span class="hosted-ui-access-mode-meta">${ui.escapeHtml(clientName)} can read the data you select, including new matching records, until you revoke access.</span>
            </span>
          </label>
          <label class="hosted-ui-access-mode-option">
            <input type="radio" name="access_mode" value="single_use" />
            <span class="hosted-ui-access-mode-body">
              <span class="hosted-ui-access-mode-label">One-time access</span>
              <span class="hosted-ui-access-mode-meta">${ui.escapeHtml(clientName)} can start one retrieval. It can't start another without your approval.</span>
            </span>
          </label>
        </fieldset>
      `
    : "";

  const pickerBehaviorStyles = rows.length
    ? `<style>
.hosted-ui-option-summary {
  list-style: none;
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.hosted-ui-option-summary::-webkit-details-marker {
  display: none;
}
.hosted-ui-option-summary > .hosted-ui-option {
  flex: 1 1 auto;
  min-width: 0;
}
.hosted-ui-toolbar-divider {
  width: 1px;
  align-self: stretch;
  background: var(--border);
  margin: 0.125rem 0.25rem;
}
.hosted-ui-option-preview {
  display: block;
  font-family: var(--font-mono);
  font-size: 0.75rem;
  line-height: 1.45;
  color: var(--muted-foreground);
  overflow-wrap: anywhere;
}
.hosted-ui-picker-toolbar {
  margin: 0.75rem 0;
}
.hosted-ui-picker-toolbar .hosted-ui-button {
  padding: 0.425rem 0.75rem;
  font-size: 0.8125rem;
}
.hosted-ui-picker-error {
  margin: 0 0 1rem;
}
.hosted-ui-picker-filter {
  margin: 0 0 0.75rem;
}
.hosted-ui-picker-filter-label {
  display: block;
  margin-bottom: 0.375rem;
  font-size: 0.75rem;
  font-weight: 500;
  color: var(--muted-foreground);
}
.hosted-ui-picker-filter-input {
  width: 100%;
  font: inherit;
  font-size: 0.875rem;
  padding: 0.5rem 0.75rem;
  min-height: 44px;
  border: 1px solid var(--input);
  border-radius: var(--radius-control);
  background: var(--card);
  color: var(--foreground);
}
.hosted-ui-picker-filter-input:focus-visible {
  outline: 2px solid var(--primary);
  outline-offset: 1px;
  border-color: var(--primary);
}
.hosted-ui-picker-filter-empty {
  margin: 0.5rem 0 0;
  font-size: 0.8125rem;
  color: var(--muted-foreground);
}
.hosted-ui-picker-counter {
  margin: 0.25rem 0 0.75rem;
  font-size: 0.8125rem;
  color: var(--muted-foreground);
}
.hosted-ui-option-source[hidden] {
  display: none;
}
</style>`
    : "";

  const pickerBehaviorScript = rows.length
    ? `<script>
(() => {
  const form = document.querySelector("[data-hosted-mcp-picker-form]");
  if (!form) return;
  const error = form.querySelector("[data-hosted-mcp-picker-error]");
  const sources = Array.from(form.querySelectorAll("[data-hosted-mcp-source]"));
  const sourceBoxes = () => Array.from(form.querySelectorAll("[data-hosted-mcp-source-checkbox]"));
  const streamsFor = (source) => Array.from(source.querySelectorAll("[data-hosted-mcp-stream-checkbox]"));
  const setError = (message) => {
    if (!error) return;
    if (message) {
      error.textContent = message;
      error.hidden = false;
    } else {
      error.textContent = "";
      error.hidden = true;
    }
  };
  // The running total, recomputed from the checkboxes themselves rather than
  // tracked incrementally — there is no second source of truth to drift.
  const counter = form.querySelector("[data-hosted-mcp-counter]");
  const plural = (n, one, many) => n + " " + (n === 1 ? one : many);
  const updateCounter = () => {
    if (!counter) return;
    const streams = Array.from(form.querySelectorAll("[data-hosted-mcp-stream-checkbox]")).filter((b) => b.checked);
    if (streams.length === 0) {
      counter.textContent = "Nothing selected yet.";
      return;
    }
    const sourceCount = sources.filter((s) => streamsFor(s).some((b) => b.checked)).length;
    counter.textContent =
      plural(sourceCount, "source", "sources") + " · " + plural(streams.length, "data type", "data types");
  };
  // Keep the disclosure's own state in sync with the <details>. The label and
  // aria-expanded are on a real control now, so both must track "open"
  // however it changed — chevron click, keyboard, or a selection auto-opening
  // the row.
  const syncDisclosure = (source) => {
    const disclosure = source.querySelector("[data-hosted-mcp-disclosure]");
    if (!disclosure) return;
    const open = source.open;
    disclosure.setAttribute("aria-expanded", open ? "true" : "false");
    const label = disclosure.querySelector(".hosted-ui-disclosure-label");
    if (label) label.textContent = open ? "Hide data" : "Choose data";
  };
  const syncSource = (source) => {
    const sourceBox = source.querySelector("[data-hosted-mcp-source-checkbox]");
    if (!sourceBox) return;
    const streamBoxes = streamsFor(source);
    const checkedCount = streamBoxes.filter((streamBox) => streamBox.checked).length;
    const selected = checkedCount > 0;
    const partiallySelected = selected && checkedCount < streamBoxes.length;
    sourceBox.checked = selected;
    sourceBox.indeterminate = partiallySelected;
    sourceBox.setAttribute("aria-checked", partiallySelected ? "mixed" : selected ? "true" : "false");
    source.dataset.sourceSelected = selected ? "true" : "false";
    const streamGroup = source.querySelector("[data-hosted-mcp-streams]");
    if (streamGroup) {
      streamGroup.dataset.streamsEnabled = "true";
      streamGroup.setAttribute("aria-disabled", "false");
    }
    for (const streamBox of streamBoxes) {
      streamBox.disabled = false;
    }
    if (selected) {
      source.open = true;
    }
    syncDisclosure(source);
    updateCounter();
  };
  for (const source of sources) {
    // The summary hosts two controls that do different things, so neither may
    // trigger the other's effect. The browser toggles <details> on ANY click
    // inside <summary>, which is what made one tap have two outcomes: ticking
    // the checkbox also collapsed or expanded the row.
    //
    // Suppress that default on the summary and drive "open" only from the
    // disclosure (and from selection, which auto-opens). The exception
    // matters: preventDefault() on the summary cancels the checkbox's own
    // activation too — both are default actions of the same click — so a
    // blanket suppression leaves the selection control dead. Verified in
    // Chromium, not assumed. Scope it to clicks that did not land on the
    // checkbox.
    const summary = source.querySelector(".hosted-ui-option-summary");
    summary?.addEventListener("click", (event) => {
      if (event.target.closest("input[type=checkbox]")) return;
      event.preventDefault();
    });
    const disclosure = source.querySelector("[data-hosted-mcp-disclosure]");
    const toggle = () => {
      source.open = !source.open;
      syncDisclosure(source);
    };
    disclosure?.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggle();
    });
    disclosure?.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      event.stopPropagation();
      toggle();
    });
    source.addEventListener("toggle", () => syncDisclosure(source));
    const sourceBox = source.querySelector("[data-hosted-mcp-source-checkbox]");
    if (!sourceBox) continue;
    sourceBox.addEventListener("change", () => {
      const streamBoxes = streamsFor(source);
      const selectAll = sourceBox.checked;
      for (const streamBox of streamBoxes) {
        streamBox.checked = selectAll;
      }
      syncSource(source);
      setError("");
    });
    for (const streamBox of streamsFor(source)) {
      streamBox.addEventListener("change", () => {
        syncSource(source);
        setError("");
      });
    }
  }
  // Bulk select applies only to what the owner can currently SEE. With a
  // filter active, selecting rows hidden behind the search would grant
  // sources they never looked at — the exact over-granting the filter is
  // supposed to make less likely, not more.
  const visibleSources = () => sources.filter((source) => !source.hidden);
  form.querySelector("[data-hosted-mcp-select-sources]")?.addEventListener("click", () => {
    for (const source of visibleSources()) {
      const sourceBox = source.querySelector("[data-hosted-mcp-source-checkbox]");
      if (sourceBox?.disabled) continue;
      for (const streamBox of streamsFor(source)) {
        streamBox.checked = true;
      }
      syncSource(source);
    }
    setError("");
  });
  // Clear stays unscoped, deliberately: clearing a row the filter is hiding
  // can only ever narrow the grant, and an owner who clicks "Clear selection"
  // means all of it, not "all of it except what I searched away".
  form.querySelector("[data-hosted-mcp-clear-sources]")?.addEventListener("click", () => {
    for (const source of sources) {
      for (const streamBox of streamsFor(source)) {
        streamBox.checked = false;
      }
      syncSource(source);
    }
    setError("");
  });
  // Filtering hides rows; it never changes what is selected. A source the
  // owner already checked stays checked and stays in the grant even while it
  // is filtered out of view — hiding a row must not silently narrow the
  // decision, and un-selecting on filter would do exactly that.
  const filterInput = form.querySelector("[data-hosted-mcp-filter]");
  const filterEmpty = form.querySelector("[data-hosted-mcp-filter-empty]");
  filterInput?.addEventListener("input", () => {
    const needle = filterInput.value.trim().toLowerCase();
    let shown = 0;
    for (const source of sources) {
      const match = !needle || (source.dataset.filterText || "").includes(needle);
      source.hidden = !match;
      if (match) shown += 1;
    }
    if (filterEmpty) filterEmpty.hidden = shown > 0;
  });
  form.querySelector("[data-hosted-mcp-expand-all]")?.addEventListener("click", () => {
    for (const source of sources) {
      source.open = true;
    }
  });
  form.querySelector("[data-hosted-mcp-collapse-all]")?.addEventListener("click", () => {
    for (const source of sources) {
      source.open = false;
    }
  });
  // ── The approval artifact: live summary + decision digest ──────────────
  //
  // Reads the current form state into the exact decision the owner is
  // approving, renders it, and canonicalizes + hashes it into the hidden
  // decision_digest field. The server recomputes the same digest from the
  // decision it independently resolves and rejects any mismatch, so this can
  // only ever narrow or fail — it never widens a grant.
  const decisionField = form.querySelector("[data-hosted-mcp-decision-digest]");
  const review = form.querySelector("[data-hosted-mcp-review]");
  const reviewEmpty = form.querySelector("[data-hosted-mcp-review-empty]");
  const reviewTerms = form.querySelector("[data-hosted-mcp-review-terms]");
  const reviewScope = form.querySelector("[data-hosted-mcp-review-scope]");
  const reviewDuration = form.querySelector("[data-hosted-mcp-review-duration]");
  const clientId = form.querySelector('input[name="client_id"]')?.value || "";

  const readDecision = () => {
    const selected = [];
    for (const source of sources) {
      const streamNames = streamsFor(source)
        .filter((streamBox) => streamBox.checked)
        .map((streamBox) => streamBox.dataset.streamName || "");
      if (streamNames.length > 0) {
        selected.push({ sourceKey: source.dataset.sourceKey || "", streamNames: streamNames.sort() });
      }
    }
    selected.sort((a, b) => (a.sourceKey < b.sourceKey ? -1 : a.sourceKey > b.sourceKey ? 1 : 0));
    const modeInput = form.querySelector('input[name="access_mode"]:checked');
    return { accessMode: modeInput ? modeInput.value : "continuous", clientId, sources: selected };
  };

  // Must produce byte-identical JSON to the server's canonicalization:
  // keys sorted at every level, arrays in order, no whitespace.
  const canonicalize = (value) => {
    if (!value || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map(canonicalize);
    const sorted = {};
    for (const key of Object.keys(value).sort()) sorted[key] = canonicalize(value[key]);
    return sorted;
  };

  const toBase64Url = (buffer) => {
    let binary = "";
    for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
  };

  const refreshDecision = async () => {
    const decision = readDecision();
    const total = decision.sources.reduce((sum, source) => sum + source.streamNames.length, 0);
    const hasSelection = total > 0;
    if (review) {
      if (reviewEmpty) reviewEmpty.hidden = hasSelection;
      if (reviewTerms) reviewTerms.hidden = !hasSelection;
    }
    if (reviewScope) {
      const sourceWord = decision.sources.length === 1 ? "source" : "sources";
      const typeWord = total === 1 ? "data type" : "data types";
      reviewScope.textContent = total + " " + typeWord + " from " + decision.sources.length + " " + sourceWord;
    }
    if (reviewDuration) {
      reviewDuration.textContent =
        decision.accessMode === "single_use"
          ? "One-time access — one retrieval, then no more without your approval."
          : "Ongoing access — including new matching records, until you revoke it.";
    }
    if (!decisionField) return;
    if (!hasSelection) {
      decisionField.value = "";
      return;
    }
    // SubtleCrypto is unavailable outside a secure context (plain HTTP, which
    // is how a local instance is normally reached) and in some embedded
    // webviews. Leaving the field empty there is the correct degradation: the
    // server rejects an unbound approval and re-renders, so the owner sees an
    // honest "review this again" rather than a silently unbound grant. It
    // must never throw, which would take the whole picker's interaction model
    // down with it.
    if (!(globalThis.crypto && crypto.subtle)) {
      decisionField.value = "";
      return;
    }
    try {
      const json = JSON.stringify(canonicalize(decision));
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(json));
      decisionField.value = "sha256:" + toBase64Url(digest);
    } catch {
      decisionField.value = "";
    }
  };

  form.addEventListener("change", () => {
    // The decision moved, so the one-shot submit retry is owed again.
    delete form.dataset.decisionRetried;
    refreshDecision();
  });

  form.addEventListener("submit", (event) => {
    // Cancel must never be blocked by selection validation — refusing is
    // always valid, and an owner with nothing selected is exactly the owner
    // most likely to be refusing.
    if (event.submitter && event.submitter.value === "cancel") {
      return;
    }
    for (const source of sources) {
      syncSource(source);
    }
    if (!sourceBoxes().some((sourceBox) => sourceBox.checked)) {
      event.preventDefault();
      setError(error?.dataset.defaultMessage || "Choose at least one data source to continue.");
      return;
    }
    const incomplete = sources.find((source) => {
      const sourceBox = source.querySelector("[data-hosted-mcp-source-checkbox]");
      const streamBoxes = streamsFor(source);
      return sourceBox?.checked && streamBoxes.length > 0 && !streamBoxes.some((streamBox) => streamBox.checked);
    });
    if (incomplete) {
      event.preventDefault();
      incomplete.open = true;
      setError("Choose data from each selected source, or clear the source.");
      return;
    }
    // The digest is computed asynchronously (SubtleCrypto), so hold the
    // submit for ONE pass and resubmit once the field carries the decision
    // the owner reviewed. Exactly one retry: where the digest cannot be
    // produced at all (no secure context), a loop would trap the owner on a
    // page whose button does nothing. Letting the submit through instead
    // reaches the server's own fail-closed check, which re-renders with a
    // message. This is a UX guard, never the security boundary.
    if (decisionField && !decisionField.value && !form.dataset.decisionRetried) {
      event.preventDefault();
      form.dataset.decisionRetried = "1";
      refreshDecision().then(() => {
        form.requestSubmit(event.submitter || undefined);
      });
    }
  });
  for (const source of sources) {
    syncSource(source);
  }
  refreshDecision();
})();
</script>`
    : "";

  // The headline carries the two facts that decide the page: who is asking,
  // and that they want to READ. The URL is not one of them — it moved to the
  // identity block's quiet domain line, where it does its anti-phishing job
  // without occupying headline weight. The trust status sits directly beneath
  // the name in `clientIdentityBlock`, so a resolved name is never shown as
  // though the server had verified it (spec-core.md:706-730).
  const pickerTitle = clientDisplay
    ? `${clientDisplay.displayName} wants to read your data`
    : "Choose what this app can read";

  // The uniform-kind summary ("All sources below are connector-backed") is
  // gone with the per-row badge: it stated a protocol classification the
  // owner has no decision to make about. `source.kind` remains in the grant
  // and the audit record.
  const sourceKindSummaryInline = "";

  // Resolved field/time-range scope (Grant fields: `streams[].fields`,
  // `streams[].time_constraint`; approval-artifact requirement,
  // spec-core.md:873-880). This picker has no field-projection or time-range
  // UI, so every stream it grants resolves to all of that stream's fields
  // with no temporal limit.
  //
  // The prior wording — "All fields of each stream you check; no date-range
  // limit." — read as though the absence were a property of the protocol. It
  // is not: `fields` is a protocol-enforced allowlist (spec-core.md:769) and
  // `time_range` is evaluated against each stream's `consent_time_field`
  // (:758-759), which 97 of 162 fleet streams declare. It is an unbuilt
  // feature phrased as a constraint. State the scope plainly and let it look
  // as broad as it is.
  // Stated once, on the approval artifact, where it is one of the exact
  // resolved terms the owner binds to (spec-core.md:873-877) rather than a
  // standing caveat above a list.
  const fieldsAndTimeRangeSummary = "";

  // PROTOCOL: the stream-selection controls and the access-mode fieldset are
  // both server-enforced (spec section 706) — wrap them together so the whole
  // picker, not only the new client-identity/purpose additions above, keeps
  // its categories visually distinct.
  const protocolSelectionBlock = renderAuthorshipBlock(
    "protocol",
    "Streams and access mode your server will enforce",
    `${sourceKindSummaryInline}${fieldsAndTimeRangeSummary}<div class="hosted-ui-option-group">${options}</div>${accessModeControl}`,
    ui
  );

  return ui.renderHostedDocument({
    body: [
      ui.renderPageIntro({
        eyebrow: "Data access request",
        lede: "Choose what it can read. Anything you leave unchecked stays private.",
        title: pickerTitle,
      }),
      clientIdentityBlock,
      ui.renderSurface({
        children: `
            ${pickerBehaviorStyles}
            ${riskCopy}
            <form method="POST" action="/oauth/authorize/mcp-package" data-hosted-mcp-picker-form>
              <input type="hidden" name="_csrf" value="${ui.escapeHtml(csrfToken)}" />
              <input type="hidden" name="review_digest" value="${ui.escapeHtml(reviewSnapshotDigest)}" />
              <input type="hidden" name="decision_digest" value="" data-hosted-mcp-decision-digest />
              ${hidden}
              ${validationBanner}
              ${termsBlock}
              ${bulkControls}
              ${protocolSelectionBlock}
              ${reviewPanel}
              ${submit}
            </form>
            ${pickerBehaviorScript}
          `,
        surface: "human",
      }),
    ]
      .filter(Boolean)
      .join("\n"),
    providerName,
    title: `${providerName} — Choose data sources`,
  });
}

// ─── Browser-reachable failures ──────────────────────────────────────────────
//
// Roughly thirty distinct failures on the authorize path returned a raw JSON
// body to the browser — `Unknown client_id`, `redirect_uri does not match a
// registered redirect URI`, `code_challenge_method must be S256`, `Unknown
// connector: <id>`, `access_mode must be 'single_use' or 'continuous'`. Only
// three conditions rendered HTML. An owner who hit any of the rest saw a JSON
// blob mid-consent, on the most critical UI in the server.
//
// Two rules govern what replaces them. The owner reads a consequence, never a
// protocol string: `code_challenge_method must be S256` tells the person
// deciding whether to share their bank transactions nothing they can act on,
// and the developer who needs it already has it in the log and the JSON body
// an API client still receives. And every terminal failure states the one
// fact the owner most needs — that nothing was shared.

/** Owner-facing copy for the failures a browser can actually reach. */
const HOSTED_ERROR_PAGE_COPY: Record<string, { title: string; body: string }> = {
  expired_link: {
    body: "This approval link expired or was already used. Start the request again from the app that sent you here. Nothing was shared.",
    title: "Nothing was shared",
  },
  server_error: {
    body: "Something went wrong on your server. Nothing was shared. Try again in a moment; if it keeps happening, check your server's logs.",
    title: "Your server couldn't finish this",
  },
  stale_review: {
    body: "This request changed since you loaded the page. Review and approve again. Your available sources changed while it was open, so nothing was shared.",
    title: "Start over from the app",
  },
  unknown_client: {
    body: "Your server doesn't recognize this app. It won't send it anything, and nothing was shared.",
    title: "Unrecognized app",
  },
};

/**
 * What the owner reads after refusing.
 *
 * This page said "Access Denied", then "Request rejected", then "The pending
 * data access request was rejected and cleared." — one fact, three times, in
 * the passive voice, in the register of a system log. None of the three
 * answered the question the owner actually has after saying no, which is what
 * happened to their data.
 *
 * Refusing is a normal, correct outcome, not an error, so the copy does not
 * dress it as one. `Access denied` survives as the page title because that is
 * the OAuth-facing name of the outcome and several suites pin it; the words
 * the owner reads are these.
 */
export const HOSTED_DENIAL_COPY = {
  body: "The app didn't get any of your data. You can close this tab.",
  title: "You didn't share anything",
} as const;

/** The fallback every unmapped failure lands on. Safe, honest, and terminal. */
const HOSTED_ERROR_PAGE_FALLBACK = HOSTED_ERROR_PAGE_COPY.server_error as { title: string; body: string };

/**
 * Whether this request is a browser navigation that should receive an HTML
 * page rather than the JSON error body.
 *
 * Deliberately narrow: only an explicit `text/html` flips the response. A
 * bare catch-all Accept (curl's default) and a missing Accept header both
 * keep the JSON contract every existing API client and conformance test
 * depends on, so this can only ever add a page where there was an unreadable
 * blob — it can never take JSON away from something that was getting it.
 */
export function prefersHtmlErrorPage(accept: unknown): boolean {
  return typeof accept === "string" && accept.includes("text/html");
}

/**
 * Renders a terminal failure as a page the owner can read.
 *
 * `description` is the protocol-level message. It is accepted so callers can
 * pass what they already have, and deliberately never rendered: it names
 * `redirect_uri`, `client_id`, `code_challenge_method` and connector ids, all
 * of which are debug output on this surface. It stays in the JSON body, the
 * log, and the audit record.
 */
export function renderHostedErrorPage({
  code,
  providerName,
  ui,
}: {
  code: unknown;
  /** Protocol-level detail. Accepted, never rendered — see above. */
  description?: unknown;
  providerName: string;
  ui: ConsentUiRenderer;
}): string {
  const key = typeof code === "string" ? code : "";
  const copy = HOSTED_ERROR_PAGE_COPY[key] ?? HOSTED_ERROR_PAGE_FALLBACK;
  const body = [
    ui.renderPageIntro({
      eyebrow: "Data access request",
      lede: copy.body,
      title: copy.title,
    }),
  ].join("\n");
  return ui.renderHostedDocument({
    body,
    providerName,
    title: `${providerName} — Request stopped`,
  });
}
