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

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CITIZEN_GLYPHS, type CitizenShell, renderCitizenCard } from "../citizen-ui.ts";
import { type DemoLang, pickLang } from "../demo-i18n.ts";
import {
  HOSTED_MCP_DEFAULT_GRANT_EXPIRY_ID,
  HOSTED_MCP_GRANT_EXPIRY_OPTIONS,
} from "../hosted-mcp-grant-expiry.ts";
import {
  type OperatorTrustConfig,
  EMPTY_OPERATOR_TRUST_CONFIG,
  isLogoFetchAllowed,
  resolveClientTrust,
} from "../client-trust-registry.ts";
import { type FetchClientLogoOptions, fetchAndCacheClientLogo } from "../client-logo-cache.ts";
import {
  type StreamScopeCapability,
  type StreamScopeSelection,
  describeTimeField,
  resolveStreamScopeCapability,
  scopeFieldsInputName,
  scopeSinceInputName,
  scopeUntilInputName,
} from "../hosted-mcp-stream-scope.ts";
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
  renderHostedDocument: (opts: {
    title: string;
    providerName: string;
    body: string;
    shell?: CitizenShell;
    currentUrl?: string;
    lang?: DemoLang;
  }) => string;
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
  // Widened from `{ name, description }` to carry the per-stream capability
  // signals the scope controls need: `selection.fields` gates field narrowing
  // and `consent_time_field` gates date narrowing (spec-core.md:547). The
  // stored manifest has always had these; the route layer simply dropped them,
  // which is why the picker could only offer all-fields-no-dates.
  readonly streams?: Array<{
    name: string;
    consent_time_field?: string | null;
    description?: string | null;
    display?: { label?: string | null; detail?: string | null } | null;
    schema?: {
      properties?: Record<string, { description?: string | null } | unknown> | null;
      required?: readonly string[] | null;
    } | null;
    selection?: { fields?: boolean | null } | null;
  }> | null;
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
  streams: Array<{
    name: string;
    description: string | null;
    display?: { label?: string | null; detail?: string | null } | null;
    // A JSON Schema property is an arbitrary value, so it stays `unknown` here
    // (matching the manifest type it is copied from); the picker guards the one
    // field it reads off it at runtime. Spelling this `{ description?: ... } |
    // unknown` would collapse to plain `unknown` anyway and only look narrower.
    schema?: { properties?: Record<string, unknown> | null; required?: readonly string[] | null } | null;
    /** What this stream's declaration permits the picker to offer. */
    scope: StreamScopeCapability;
  }>;
}

// Authorization-details constants.

// Registry code (spec-core.md Appendix A) — "Providing context to a personal
// AI agent." This is the closest registered fit for a hosted MCP connector
// (e.g. ChatGPT, Claude) reading data through the picker; the previous value,
// `personal_ai_assistant`, was not a registry code.
export const HOSTED_MCP_PICKER_PURPOSE_CODE = "https://pdpp.dev/purpose/agent_context";
export const HOSTED_MCP_PICKER_PURPOSE_DESCRIPTION =
  "Responder sus preguntas como asistente ciudadano, usando solo los registros que usted autorice aquí.";
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
export const HOSTED_MCP_PICKER_GRANT_EXPIRY_COPY = "Esta autorización no tiene fecha de fin programada.";

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
  source: HostedMcpSourceDescriptor = { id: connectorId, kind: "connector" },
  /**
   * Per-stream narrowing, keyed by stream name. Absent entries mean "no
   * narrowing", which is the pre-existing behavior: the resolver reads an
   * omitted `fields` as every field and an omitted `time_range` as no bound
   * (spec-core.md:775). A wildcard selection carries no scope, because there
   * is no named stream to attach it to until the wildcard is expanded — which
   * is why the picker names its streams instead of passing null here. See
   * `issuedStreamNamesForSource` in as-authorize.ts.
   */
  streamScopes: ReadonlyMap<string, StreamScopeSelection> | null = null
): {
  type: string;
  source: { kind: string; id: string };
  purpose_code: string;
  purpose_description: string;
  access_mode: string;
  retention?: { max_duration: string; on_expiry: "anonymize" | "delete" };
  streams: Array<{
    name: string;
    instance_ids?: string[];
    fields?: string[];
    time_range?: { since?: string; until?: string };
  }>;
} {
  const pinnedConnectionId = typeof connectionId === "string" && connectionId.trim() ? connectionId.trim() : null;
  const withPin = (
    name: string
  ): { name: string; instance_ids?: string[]; fields?: string[]; time_range?: { since?: string; until?: string } } => {
    const scope = streamScopes?.get(name) ?? null;
    return {
      ...(pinnedConnectionId ? { instance_ids: [pinnedConnectionId] } : {}),
      // Omitted rather than nulled when nothing was narrowed: an absent key
      // asks the AS to resolve the full permitted set, while an explicit empty
      // list would be a different (and invalid) request.
      ...(scope?.fields ? { fields: [...scope.fields] } : {}),
      name,
      ...(scope?.timeRange ? { time_range: { ...scope.timeRange } } : {}),
    };
  };
  let streams: Array<{
    name: string;
    instance_ids?: string[];
    fields?: string[];
    time_range?: { since?: string; until?: string };
  }>;
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

// The decision digest itself now lives in `../hosted-mcp-decision-digest.ts`,
// a dependency-light module the console's consent page can import without
// pulling this renderer into a browser-facing bundle. Re-exported here so
// every existing caller and test keeps its import path.
export type { HostedMcpPickerSubmittedDecision } from "../hosted-mcp-decision-digest.ts";
export { computeHostedMcpDecisionDigest } from "../hosted-mcp-decision-digest.ts";

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
// The digest covers what the GET rendered as CHOOSABLE, so it must grow
// whenever the page offers a new choice. Field and date narrowing are now
// offered per stream, so each stream contributes the capability that decided
// which controls it showed: if a manifest revision changes a stream's field
// list, drops `selection.fields`, or removes `consent_time_field` between
// page-load and submission, the owner reviewed controls the server would no
// longer honor, and this rejects rather than mints. Binding the capability
// rather than the owner's choices is deliberate — the choices are carried in
// the POST and validated against a fresh declaration read; this guards the
// menu they were chosen from.
//
// Grant expiry is not part of the digest: the options are server constants,
// not manifest-derived, so there is nothing about them that can drift between
// GET and POST. Per-stream client_claims remain absent from the picker.
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
      // The per-stream scope surface the page offered. Sorted so an
      // insignificant reordering in the manifest cannot invalidate a form the
      // owner is still filling in.
      streamScopes: [...row.streams]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((stream) => ({
          name: stream.name,
          optionalFields: [...stream.scope.optionalFields].sort(),
          requiredFields: [...stream.scope.requiredFields].sort(),
          supportsFieldNarrowing: stream.scope.supportsFieldNarrowing,
          timeField: stream.scope.timeField,
        })),
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

/**
 * The consent challenge render model — every fact the owner-facing consent
 * screen displays, resolved server-side from the pending authorization
 * request, with no rendering decisions baked in.
 *
 * This is the JSON counterpart of `renderHostedMcpSourceSelection`'s HTML: it
 * carries the SAME facts, resolved by the SAME helpers, so the two surfaces
 * cannot disagree about what the owner is being asked. What it deliberately
 * does NOT carry is presentation — no copy the console can write for itself,
 * no markup, no CSS classes. The console owns how this reads; this owns what
 * is true.
 *
 * `reviewDigest` binds the eligibility snapshot the owner reviewed. The
 * console echoes it back on accept, where `rejectIfHostedMcpReviewDigestStale`
 * re-resolves it fresh and fails closed on drift — the same TOCTOU guard the
 * form POST has always had, reached through the same code path.
 */
export interface HostedMcpConsentChallengeModel {
  /** Server default (`continuous`), and the vocabulary the accept route validates against. */
  readonly accessMode: { readonly supported: readonly string[]; readonly value: string };
  readonly challenge: string;
  readonly client: {
    /**
     * The origin the client PROVED it controls, or null when it proved none.
     * Never falls back to the app's own name: repeating "ChatGPT" on a line
     * that reads as a domain would dress a self-asserted name as a verified
     * one. A client with no proven domain simply has no second identity line.
     */
    readonly domain: string | null;
    /**
     * The raw `client_id`. Published because the approving surface must
     * compute `decision_digest` over the client identity it displayed, and a
     * digest the server computed for itself would bind nothing (AS-conformance
     * #15). Not a secret — it is a public parameter of the authorize URL.
     */
    readonly id: string;
    /** Same-origin URL for a verified logo cached by the AS, or null for the monogram fallback. */
    readonly logo: string | null;
    readonly monogram: string;
    readonly name: string;
    /** Policy/terms links the client's own identity document declared, if any. */
    readonly policyLinks: ReadonlyArray<{ readonly href: string; readonly label: string }>;
    /**
     * The host this flow will actually send the owner back to — the REGISTERED
     * redirect_uri's origin, resolved by the server, never the requested one.
     * A different fact from `domain`: this is where the browser goes, which is
     * true regardless of whether the client proved anything about its identity.
     */
    readonly returnTo: string | null;
    readonly trust: "unverified" | "domain" | "verified";
  };
  /** Owner-chooseable grant validity (`Grant.expires_at`), NOT per-stream data range. */
  readonly grantExpiry: {
    readonly defaultId: string;
    readonly options: ReadonlyArray<{ readonly days: number | null; readonly id: string; readonly label: string }>;
  };
  readonly purpose: { readonly code: string; readonly description: string };
  readonly retention: string;
  readonly reviewDigest: string;
  readonly sources: ReadonlyArray<{
    readonly account: string;
    /** Manifest-declared brand glyph, passed straight to ConnectorIcon; null renders its Monogram. */
    readonly icon: { readonly color: string | null; readonly kind: string | null; readonly svg: string | null } | null;
    readonly id: string;
    readonly name: string;
    readonly selectionValue: string;
    readonly streams: ReadonlyArray<{
      /** Fields the owner can narrow, with required fields marked as the consent floor. */
      readonly fields: ReadonlyArray<{
        readonly description?: string;
        readonly label?: string;
        readonly name: string;
        readonly required: boolean;
      }>;
      readonly fieldsTotal: number;
      readonly id: string;
      readonly label: string;
      readonly name: string;
      readonly selectionValue: string;
      /**
       * Whether this stream starts checked. Always false: the picker
       * pre-selects nothing, so consent is an affirmative act rather than a
       * default the owner has to notice and undo. Carried explicitly (not
       * assumed by the console) so a future default-selection policy is a
       * server decision, not a client one.
       */
      readonly selected: boolean;
      readonly sentence: string;
      /** Present only when the stream declares `consent_time_field`; absent suppresses the date control. */
      readonly timePhrase?: string;
    }>;
  }>;
}

/** Opaque stable key; the original client id and upstream URI never reach the browser. */
export function consentClientLogoCacheKey(clientId: string): string {
  return `consent-client-logo-${createHash("sha256").update(clientId).digest("base64url")}`;
}

async function resolveConsentClientLogo(
  client: PendingGrantRequest["client"] | null,
  clientLogoFetchOptions?: FetchClientLogoOptions
): Promise<string | null> {
  const clientId = typeof client?.client_id === "string" ? client.client_id : null;
  const logoUri = typeof client?.client_display?.logo_uri === "string" ? client.client_display.logo_uri : null;
  if (!(clientId && logoUri)) {
    return null;
  }
  const trust = resolveClientTrust({ client_id: clientId, registration_mode: client?.registration_mode ?? null });
  if (!isLogoFetchAllowed(logoUri, clientId, trust)) {
    return null;
  }
  const cacheKey = consentClientLogoCacheKey(clientId);
  const logo = await fetchAndCacheClientLogo(cacheKey, logoUri, clientLogoFetchOptions);
  return logo ? `/oauth/consent-client-logos/${encodeURIComponent(cacheKey)}` : null;
}

export async function buildHostedMcpConsentChallengeModel(
  challenge: string,
  ownerSubjectId: string,
  caps: ConsentPickerCapabilities,
  ui: ConsentUiRenderer,
  client: PendingGrantRequest["client"] | null,
  /**
   * The redirect target for this authorize request, used only to tell the
   * owner where they will end up. The caller passes the value the AS itself
   * recorded, so this cannot be steered by a request parameter.
   */
  redirectUri: string | null = null,
  clientLogoFetchOptions?: FetchClientLogoOptions
): Promise<HostedMcpConsentChallengeModel> {
  const rows = await listHostedMcpPickerRows(caps, ownerSubjectId);
  const clientDisplay = client ? buildConsentClientDisplay(client, ui) : null;
  // `displayName`, not `titleName`: spec-core.md:673 requires the resolved
  // display name when the metadata carries one, with `client_id` only as the
  // fallback — and `displayName` already encodes exactly that precedence.
  const clientName = clientDisplay?.displayName ?? "Esta aplicación";
  const logo = await resolveConsentClientLogo(client, clientLogoFetchOptions);
  // Icons come from each row's own manifest, the same value /sources passes to
  // ConnectorIcon. Resolved here rather than in the console because the
  // console has no manifest reader, and because `validateManifestIcon` has
  // already allowlist-checked this SVG on the read that produced it.
  const icons = new Map<string, HostedMcpConsentChallengeModel["sources"][number]["icon"]>();
  for (const row of rows) {
    if (icons.has(row.connectorId)) {
      continue;
    }
    const manifest = await caps.getConnectorManifest(row.connectorId);
    const icon = (manifest as { icon?: { color?: string | null; kind?: string | null; svg?: string | null } | null })?.icon;
    icons.set(
      row.connectorId,
      icon?.svg ? { color: icon.color ?? null, kind: icon.kind ?? null, svg: icon.svg } : null
    );
  }
  return {
    accessMode: {
      supported: [...HOSTED_MCP_PICKER_SUPPORTED_ACCESS_MODES],
      value: HOSTED_MCP_PICKER_DEFAULT_ACCESS_MODE,
    },
    challenge,
    client: {
      // Null, not the app's own name: see the field's doc comment. A client
      // that proved no domain gets no domain line at all.
      domain: clientDisplay?.domainLabel ?? null,
      id: client?.client_id ?? "",
      logo,
      monogram: clientDisplay?.monogram ?? "AP",
      name: clientName,
      policyLinks: clientDisplay?.policyLinks ?? [],
      returnTo: hostLabelFromClientId(redirectUri) ?? null,
      // Three tiers, each naming what the server actually checked
      // (`resolveClientTrust`'s `basis`). Untrusted is the DEFAULT, so a
      // client that proved nothing can never fall through into a badge that
      // claims otherwise — the one failure mode this screen must not have.
      //   unverified — nothing checked.
      //   domain     — `domain_verified`: a client identity document was
      //                fetched from the client's own https origin and matched,
      //                proving domain control automatically, with no human
      //                review.
      //   verified   — `operator_registered`: an operator of this server
      //                explicitly registered the client. Trusted with no
      //                verified domain is exactly that basis.
      trust: clientDisplay?.isUnverified !== false ? "unverified" : clientDisplay.verifiedDomain ? "domain" : "verified",
    },
    grantExpiry: {
      defaultId: HOSTED_MCP_DEFAULT_GRANT_EXPIRY_ID,
      options: HOSTED_MCP_GRANT_EXPIRY_OPTIONS.map((option) => ({
        days: option.days,
        id: option.id,
        label: option.label,
      })),
    },
    purpose: { code: HOSTED_MCP_PICKER_PURPOSE_CODE, description: HOSTED_MCP_PICKER_PURPOSE_DESCRIPTION },
    retention: buildHostedMcpRetentionSentence(clientName),
    reviewDigest: computeHostedMcpPickerSnapshotDigest(rows, clientDisplay),
    sources: rows.map((row) => ({
      // `meta` is the count of streams that currently have records, not an
      // account label. The console already shows the grantable stream count
      // separately, so using it as a fallback would display two conflicting
      // "data types" facts on the same collapsed row.
      account: row.connectionName ?? "",
      icon: icons.get(row.connectorId) ?? null,
      id: row.sourceKey,
      name: row.connectorTypeLabel,
      selectionValue: row.formValue,
      streams: row.streams.map((stream) => ({
        // Do not surface schema-required fields alone as a fake narrowing
        // control. The issuer rejects `fields` for declarations that did not
        // opt into selection.fields, even if their schema has required keys.
        fields: (stream.scope.supportsFieldNarrowing
          ? [...stream.scope.requiredFields, ...stream.scope.optionalFields]
          : []
        )
          .sort()
          .map((name) => {
            const property = stream.schema?.properties?.[name];
            // `in` (not a bare property read) is what narrows an `unknown`
            // schema property to something carrying `description`; the
            // `typeof === "string"` check still decides whether it is usable.
            const description =
              property && typeof property === "object" && "description" in property && typeof property.description === "string"
                ? property.description.trim()
                : "";
            const label =
              property && typeof property === "object" && "title" in property && typeof property.title === "string"
                ? property.title.trim()
                : "";
            return {
              ...(description ? { description } : {}),
              ...(label ? { label } : {}),
              name,
              required: stream.scope.requiredFields.includes(name),
            };
          }),
        fieldsTotal: Object.keys(stream.schema?.properties ?? {}).length,
        id: `${row.sourceKey}:${stream.name}`,
        label: stream.display?.label?.trim() || humanizeStreamLabel(stream.name),
        name: stream.name,
        selectionValue: caps.encodeHostedMcpStreamSelection({
          connectionId: row.connectionId,
          connectorId: row.connectorId,
          streamName: stream.name,
        }),
        selected: false,
        sentence:
          stream.display?.detail?.trim() ||
          consentSafeStreamDescription(stream.description) ||
          stream.display?.label?.trim() ||
          humanizeStreamLabel(stream.name),
        // Same phrasing the HTML picker's date controls use, from the same
        // helper, so the two surfaces describe the same field identically.
        ...(stream.scope.timeField ? { timePhrase: describeTimeField(stream.scope.timeField) } : {}),
      })),
    })),
  };
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
    ...(stream.display ? { display: stream.display } : {}),
    name: stream.name,
    // Omit the key entirely when the declaration has no schema, rather than
    // setting it to `undefined`: `exactOptionalPropertyTypes` treats a
    // present-but-undefined optional property as a distinct, rejected shape.
    ...(stream.schema ? { schema: stream.schema } : {}),
    // Resolved here rather than at render time so the capability check happens
    // once per row, and so no surface can offer a control the declaration does
    // not support (which would 400 at issuance, after the owner chose).
    scope: resolveStreamScopeCapability(stream),
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
  const availabilityPhrase = streamCount === 1 ? "1 tipo de dato" : `${streamCount} tipos de datos`;
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
  client: "Declarado por la aplicación — no verificado",
  manifest: "Descrito por el servidor",
  protocol: "Aplicado por el servidor",
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
  // Whether to render an "unverified" indicator (client-display:675). No
  // longer always true: a client that published a valid metadata document at
  // its own https client_id has proven control of that domain, which is a
  // positive trust signal the spec requires to be rendered distinctly. See
  // `verifiedDomain` for what that verification actually covers.
  isUnverified: boolean;
  // The domain the client proved it controls, or null when nothing was
  // verified. Rendered as "Verified domain: chatgpt.com" — deliberately the
  // domain, not the app: domain control says who published the metadata, not
  // that the application is trustworthy, and the copy must not imply more
  // than was proven.
  verifiedDomain: string | null;
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
  ui: ConsentUiRenderer,
  /** Operator overrides; the automatic CIMD path needs no configuration. */
  trustConfig: OperatorTrustConfig = EMPTY_OPERATOR_TRUST_CONFIG
): ConsentClientDisplay {
  const clientId = typeof client.client_id === "string" ? client.client_id : null;
  const clientName = client.client_display?.name || clientId || "Client application";
  const policyLinks = buildClientPolicyLinks(client.client_display);
  // What this server actually verified, if anything. Domain control for a
  // CIMD client; an explicit operator decision otherwise (spec-core.md:672
  // puts local registration first in the precedence).
  const trust = resolveClientTrust(
    { client_id: clientId, registration_mode: client.registration_mode ?? null },
    trustConfig
  );
  if (client.registration_mode !== "client_id_metadata_document") {
    // Pre-registered/public client: the "Requesting app" name is whatever the
    // client supplied at registration — a client-authored claim, not a fact.
    // An operator override may vouch for this client and supply the name it
    // vouches for, which outranks the self-asserted one.
    const vouchedName = trust.operatorDisplayName || clientName;
    return {
      clientFacts: [{ label: "Requesting app", value: vouchedName }],
      displayName: vouchedName,
      domainLabel: null,
      isUnverified: !trust.isTrusted,
      monogram: buildClientMonogram(vouchedName),
      policyLinks,
      protocolFacts: [],
      selfDescribedName: null,
      titleName: vouchedName,
      verifiedDomain: trust.verifiedDomain,
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
    isUnverified: !trust.isTrusted,
    // Monogram from the name the owner actually reads, so "ChatGPT" yields
    // `CH`, not a `C` derived from the URL string.
    monogram: buildClientMonogram(resolvedDisplayName),
    policyLinks,
    protocolFacts,
    selfDescribedName: clientName && clientName !== identity ? clientName : null,
    titleName: identity,
    verifiedDomain: trust.verifiedDomain,
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

// ─── DR demo: citizen consent pages ──────────────────────────────────────────
//
// Single declared requests (authorization_details) render in the citizen
// shell (`citizen-ui.ts`): Spanish copy (usted), humanized values, and the
// protocol internals collapsed under "Detalles técnicos". Form actions,
// hidden inputs, names and values are unchanged.
//
//   GET /consent ──▶ solicitud (summary) ──POST /consent/review──▶
//   confirmación (summary + <details>) ──POST /consent/approve──▶ redirect

const CONSENT_SHELL = "dr-consent";
const CONSENT_CARD_TITLE = "Autorización de acceso a datos";
const ES_NONE = "Ninguno";
const DR_TIME_ZONE = "America/Santo_Domingo";
const WILDCARD_STREAM = "*";

const ACCESS_MODE_LABELS: Record<string, string> = {
  continuous: "Acceso continuo",
  single_use: "Consulta única",
};

const RETENTION_ON_EXPIRY_ES: Record<string, string> = {
  anonymize: "se anonimizan",
  delete: "se eliminan",
};

// ISO 8601 duration designators → Spanish singular/plural, e.g. P30D → "30 días".
const ISO_DURATION_UNITS: ReadonlyArray<readonly [string, string]> = [
  ["año", "años"],
  ["mes", "meses"],
  ["semana", "semanas"],
  ["día", "días"],
];

// Unaccented manifest keys → Spanish spelling, e.g. `cedula` → "cédula".
const ES_ACCENTED_WORDS: Record<string, string> = {
  categoria: "categoría",
  cedula: "cédula",
  clasificacion: "clasificación",
  codigo: "código",
  descripcion: "descripción",
  direccion: "dirección",
  educacion: "educación",
  expedicion: "expedición",
  gestacion: "gestación",
  informacion: "información",
  numero: "número",
  ocupacion: "ocupación",
  telefono: "teléfono",
  ultima: "última",
  ultimo: "último",
  vehiculo: "vehículo",
};
const ES_LABEL_ACRONYMS = new Set(["icv", "id", "nss", "rnc", "url"]);
const ES_FIELD_LABEL_OVERRIDES: Record<string, string> = {
  id: "Identificador",
  source_updated_at: "Última actualización",
};

type CitizenRow = { authorship?: ConsentAuthorship; html: string; label: string };
type TechFact = { label: string; value: string | null | undefined };
type TechSection = { facts: TechFact[]; heading: string };

/** `cedula_jefe_hogar` → "Cédula jefe hogar"; `icv_puntaje` → "ICV puntaje". */
function humanizeEsLabel(name: string): string {
  const override = ES_FIELD_LABEL_OVERRIDES[name];
  if (override) {
    return override;
  }
  const words = name
    .trim()
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((word) => {
      const lower = word.toLowerCase();
      return ES_LABEL_ACRONYMS.has(lower) ? lower.toUpperCase() : (ES_ACCENTED_WORDS[lower] ?? lower);
    });
  const [first = "", ...rest] = words;
  if (!first) {
    return name;
  }
  return [first.charAt(0).toUpperCase() + first.slice(1), ...rest].join(" ");
}

function accessModeLabel(mode: string | null | undefined): string {
  return ACCESS_MODE_LABELS[mode ?? ""] ?? String(mode ?? ES_NONE);
}

function formatIsoDuration(value: string): string {
  const match = /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?$/.exec(value);
  if (!match) {
    return value;
  }
  const parts = ISO_DURATION_UNITS.map(([one, many], index) => {
    const count = Number(match[index + 1] ?? 0);
    return count ? `${count} ${count === 1 ? one : many}` : null;
  }).filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : value;
}

function describeRetention(retention: { max_duration?: string | null; on_expiry?: string | null } | null | undefined) {
  if (!retention?.max_duration) {
    return null;
  }
  const duration = formatIsoDuration(retention.max_duration);
  const onExpiry = RETENTION_ON_EXPIRY_ES[retention.on_expiry ?? ""];
  return onExpiry ? `Los datos ${onExpiry} después de ${duration}.` : `Hasta ${duration}.`;
}

/** ISO timestamp → "26 de septiembre de 2026, 12:11 a. m." (Santo Domingo). */
function formatEsDate(iso: string | null | undefined): string {
  if (!iso) {
    return "Sin fecha de vencimiento";
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return new Intl.DateTimeFormat("es-DO", { dateStyle: "long", timeStyle: "short", timeZone: DR_TIME_ZONE }).format(
    date
  );
}

// Source display names and stream descriptions come from the shipped fixture
// manifests (the demo sources), read once. Unknown sources fall back to ids.
interface CitizenSourceInfo {
  displayName: string | null;
  streams: Map<string, string | null>;
}

const FIXTURE_MANIFESTS_DIR = fileURLToPath(new URL("../../fixtures/seed-manifests/", import.meta.url));
let citizenSourceCache: Map<string, CitizenSourceInfo> | null = null;

function loadCitizenSources(): Map<string, CitizenSourceInfo> {
  const byId = new Map<string, CitizenSourceInfo>();
  let files: string[];
  try {
    files = readdirSync(FIXTURE_MANIFESTS_DIR).filter((file) => file.endsWith(".json"));
  } catch {
    return byId;
  }
  for (const file of files) {
    let manifest: ConsentPickerManifest;
    try {
      manifest = JSON.parse(readFileSync(join(FIXTURE_MANIFESTS_DIR, file), "utf8")) as ConsentPickerManifest;
    } catch {
      continue;
    }
    const info: CitizenSourceInfo = {
      displayName: manifest.display_name ?? null,
      streams: new Map((manifest.streams ?? []).map((stream) => [stream.name, stream.description ?? null])),
    };
    for (const key of [manifest.manifest_uri, manifest.connector_id]) {
      if (key) {
        byId.set(key, info);
      }
    }
  }
  return byId;
}

function lookupCitizenSource(sourceId: string | null | undefined): CitizenSourceInfo | null {
  if (!sourceId) {
    return null;
  }
  citizenSourceCache ??= loadCitizenSources();
  return citizenSourceCache.get(sourceId) ?? null;
}

function citizenSourceLabel(sourceId: string | null | undefined): string {
  return lookupCitizenSource(sourceId)?.displayName ?? sourceId ?? ES_NONE;
}

/** Manifest description "Head: detail" → label + detail; else humanized key. */
function describeCitizenStream(sourceId: string | null | undefined, streamName: string) {
  const description = consentSafeStreamDescription(lookupCitizenSource(sourceId)?.streams.get(streamName));
  if (!description) {
    return { detail: null, label: humanizeEsLabel(streamName) };
  }
  const colon = description.indexOf(":");
  if (colon <= 0) {
    return { detail: null, label: description };
  }
  return { detail: description.slice(colon + 1).trim(), label: description.slice(0, colon).trim() };
}

function renderCitizenStreams(
  sourceId: string | null | undefined,
  streams: Array<{ extra?: string[]; fields?: string[] | null; name: string }>,
  ui: ConsentUiRenderer
): string {
  const items = streams.map((stream) => {
    const { label, detail } = describeCitizenStream(sourceId, stream.name);
    const fieldChips = stream.fields?.length
      ? stream.fields.map((field) => `<span class="cu-chip">${ui.escapeHtml(humanizeEsLabel(field))}</span>`)
      : [`<span class="cu-chip">Todos los campos</span>`];
    const extras = (stream.extra ?? []).map((text) => `<span class="cu-chip">${ui.escapeHtml(text)}</span>`);
    const detailHtml = detail ? `<small>${ui.escapeHtml(detail)}</small>` : "";
    return `<li><b>${ui.escapeHtml(label)}</b>${detailHtml}<div class="cu-chips">${[...fieldChips, ...extras].join("")}</div></li>`;
  });
  return `<ul class="cu-streams">${items.join("")}</ul>`;
}

function renderCitizenSummary(rows: CitizenRow[], ui: ConsentUiRenderer): string {
  const html = rows
    .map((row) => {
      const authorship = row.authorship ? ` data-authorship="${row.authorship}"` : "";
      return `<div${authorship}><dt>${ui.escapeHtml(row.label)}</dt><dd>${row.html}</dd></div>`;
    })
    .join("");
  return `<dl class="cu-summary">${html}</dl>`;
}

function renderCitizenNote(text: string, ui: ConsentUiRenderer): string {
  return `<span class="cu-note">${ui.escapeHtml(text)}</span>`;
}

function renderCitizenClaims(claims: PendingClientClaims | null | undefined, ui: ConsentUiRenderer): string {
  const commitments = Array.isArray(claims?.commitments)
    ? claims.commitments.filter((c: unknown): c is string => typeof c === "string" && c.trim() !== "")
    : [];
  if (commitments.length === 0) {
    return "";
  }
  const items = commitments.map((c) => `<li>${ui.escapeHtml(c)}</li>`).join("");
  return `<div class="cu-claims" data-authorship="client"><b>Lo que la aplicación dice que hará</b><ul>${items}</ul>${renderCitizenNote(
    "Son afirmaciones de la aplicación; su servidor no las hace cumplir.",
    ui
  )}</div>`;
}

function renderTechnicalDetails(
  sections: TechSection[],
  ui: ConsentUiRenderer,
  summary = "Detalles técnicos"
): string {
  const html = sections
    .map((section) => {
      const rows = section.facts
        .map((fact) => `<dt>${ui.escapeHtml(fact.label)}</dt><dd>${ui.escapeHtml(fact.value || ES_NONE)}</dd>`)
        .join("");
      return `<h3>${ui.escapeHtml(section.heading)}</h3><dl>${rows}</dl>`;
    })
    .join("");
  return `<details class="cu-details"><summary>${ui.escapeHtml(summary)}</summary>${html}</details>`;
}

function renderCitizenConsentDocument(
  body: string,
  title: string,
  providerName: string,
  ui: ConsentUiRenderer
): string {
  return ui.renderHostedDocument({
    body: renderCitizenCard({ body, glyph: CITIZEN_GLYPHS.shield, title: CONSENT_CARD_TITLE }),
    providerName,
    shell: CONSENT_SHELL,
    title: `${CONSENT_CARD_TITLE} · ${title}`,
  });
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
  const requestHidden = [{ name: "request_uri", value: requestUri }];
  const aiTrainingCheck = isAiTraining
    ? '<label class="cu-check"><input type="checkbox" name="ai_training_consented" value="1" required /> Acepto expresamente el uso de estos datos para entrenar inteligencia artificial</label>'
    : "";
  const allowAction = pending.reviewRevision
    ? `<form class="hosted-ui-form" method="POST" action="/consent/approve">${hiddenInputs(
        [...csrfHidden, ...reviewHidden, ...requestHidden],
        ui
      )}<button type="submit" class="cu-btn cu-block">Autorizar</button></form>`
    : `<form class="hosted-ui-form" method="POST" action="/consent/review" aria-label="Revisar la autorización">
${hiddenInputs([...csrfHidden, ...requestHidden], ui)}
${aiTrainingCheck}
<button type="submit" class="cu-btn cu-block">Continuar</button>
</form>`;
  const denyAction = `<form class="hosted-ui-form" method="POST" action="/consent/deny">${hiddenInputs(
    [...csrfHidden, ...requestHidden],
    ui
  )}<button type="submit" class="cu-btn cu-outline-danger cu-block">Rechazar</button></form>`;
  return `<div class="cu-actions">${allowAction}${denyAction}</div>`;
}

function buildReviewedTechnicalSections(review: SingleApprovalReviewArtifact): TechSection[] {
  const { client, source_declaration: declaration } = review;
  const authority = declaration.resource_authority;
  const authorityFacts: TechFact[] = [];
  if (authority?.status === "verified") {
    authorityFacts.push({ label: "Autoridad del recurso", value: `Verificada (${authority.authority_binding})` });
  } else if (authority?.status === "local_operator_provisioned") {
    authorityFacts.push({ label: "Autoridad del recurso", value: "Aprovisionada por el operador local" });
  }
  const aiTraining =
    review.ai_training_consented === null ? "No aplica" : review.ai_training_consented ? "Aceptado" : "No aceptado";
  const streamSections = review.resolved_streams.map((stream) => ({
    facts: [
      { label: "IDs de instancia", value: stream.instance_ids.join(", ") },
      { label: "Campos", value: stream.fields.join(", ") },
      { label: "Recursos", value: stream.resources?.join(", ") },
      ...(stream.time_constraint
        ? [
            { label: "Campo de tiempo", value: stream.time_constraint.field },
            { label: "Desde", value: stream.time_constraint.since },
            { label: "Hasta", value: stream.time_constraint.until },
          ]
        : [{ label: "Restricción temporal", value: null }]),
    ],
    heading: `Flujo ${stream.name}`,
  }));
  return [
    {
      facts: [
        { label: "ID del cliente", value: client.client_id },
        { label: "Modo de registro", value: client.registration_mode },
        { label: "Nombre para mostrar", value: client.client_display?.name },
        { label: "URI del cliente", value: client.client_display?.uri },
        { label: "URI del logotipo", value: client.client_display?.logo_uri },
        { label: "URI de la política", value: client.client_display?.policy_uri },
        { label: "URI de los términos", value: client.client_display?.tos_uri },
        { label: "ID del titular", value: review.subject.id },
      ],
      heading: "Aplicación y titular",
    },
    {
      facts: [
        { label: "ID de la fuente", value: review.source.id },
        { label: "Tipo de fuente", value: review.source.kind },
        { label: "Versión de la declaración", value: declaration.version },
        { label: "Huella de la declaración", value: declaration.digest },
        ...(declaration.accepted_revision_reference
          ? [{ label: "Revisión aceptada", value: declaration.accepted_revision_reference }]
          : []),
        ...authorityFacts,
        ...(declaration.publisher_attribution
          ? [{ label: "Editor declarado", value: `${declaration.publisher_attribution.id} (no verificado)` }]
          : []),
      ],
      heading: "Fuente",
    },
    {
      facts: [
        { label: "Código de propósito", value: review.purpose_code },
        { label: "Descripción del propósito", value: review.purpose_description },
        { label: "Modo de acceso", value: review.access_mode },
        { label: "Preajuste de selección", value: review.selection_preset },
        { label: "Duración de conservación", value: review.retention?.max_duration },
        { label: "Al vencer la conservación", value: review.retention?.on_expiry },
        { label: "Entrenamiento de IA", value: aiTraining },
        { label: "Vencimiento de la autorización", value: review.expires_at },
      ],
      heading: "Propósito y condiciones",
    },
    ...streamSections,
  ];
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
  const clientName = review.client.client_display?.name || review.client.client_id;
  const purpose = review.purpose_description || review.purpose_code;
  const retention = describeRetention(review.retention);
  const rows: CitizenRow[] = [
    { authorship: "client", html: ui.escapeHtml(clientName), label: "Quién solicita" },
    { authorship: "client", html: ui.escapeHtml(purpose), label: "Para qué" },
    { authorship: "protocol", html: ui.escapeHtml(citizenSourceLabel(review.source.id)), label: "Fuente" },
    {
      authorship: "protocol",
      html: renderCitizenStreams(review.source.id, review.resolved_streams, ui),
      label: "Qué datos",
    },
    { authorship: "protocol", html: ui.escapeHtml(accessModeLabel(review.access_mode)), label: "Tipo de acceso" },
    { authorship: "protocol", html: ui.escapeHtml(formatEsDate(review.expires_at)), label: "Vence" },
  ];
  if (retention) {
    rows.push({ authorship: "client", html: ui.escapeHtml(retention), label: "Conservación" });
  }
  if (review.ai_training_consented !== null) {
    rows.push({
      authorship: "protocol",
      html: review.ai_training_consented ? "Aceptado" : "No aceptado",
      label: "Entrenamiento de IA",
    });
  }
  const body = [
    `<h2 class="cu-title">Confirme la autorización</h2>`,
    `<p class="cu-text">Esto es exactamente lo que su servidor guardó al revisar la solicitud. Solo se compartirá lo que aparece aquí.</p>`,
    renderCitizenSummary(rows, ui),
    renderCitizenClaims(review.client_claims, ui),
    renderTechnicalDetails(buildReviewedTechnicalSections(review), ui),
    actions,
  ]
    .filter(Boolean)
    .join("\n");
  return renderCitizenConsentDocument(body, "Confirmación", providerName, ui);
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
  const clientName = clientDisplay.displayName;
  const sourceId = sourceBinding?.id ?? null;

  const requestedStreams = Array.isArray(selection.streams) ? selection.streams : [];
  const manifestStreamNames = Array.isArray(pending.manifestStreamNames) ? pending.manifestStreamNames : null;
  const isWildcard = requestedStreams.length === 1 && requestedStreams[0]?.name === WILDCARD_STREAM;

  // Wildcard: every manifest stream, all fields. Otherwise the declared list,
  // with its time/view/optional qualifiers as extra chips.
  const citizenStreams = isWildcard
    ? (manifestStreamNames ?? []).map((name) => ({ name }))
    : requestedStreams.map((stream) => {
        const since = stream.time_constraint?.since ?? stream.time_range?.since;
        const extra = [
          since ? `Desde ${formatEsDate(since)}` : null,
          stream.view ? `Vista: ${stream.view}` : null,
          stream.necessity === "optional" ? "Opcional" : null,
        ].filter((x): x is string => x !== null);
        return { extra, fields: stream.fields ?? null, name: stream.name };
      });
  const streamsListHtml =
    citizenStreams.length > 0
      ? renderCitizenStreams(sourceId, citizenStreams, ui)
      : ui.escapeHtml("Todos los datos de esta fuente");
  // Wildcard keeps an explicit "everything" disclosure, with the count.
  const wildcardCount = citizenStreams.length > 0 ? ` (${citizenStreams.length})` : "";
  const streamsHtml = isWildcard
    ? `<div class="cu-warning" role="note"><b>Todos los datos</b>${ui.escapeHtml(
        `Se solicitan todos los conjuntos de datos de ${citizenSourceLabel(sourceId)}${wildcardCount}.`
      )}</div>${streamsListHtml}`
    : streamsListHtml;

  // Identity note: a self-described name is a claim unless this server
  // verified the client's domain or an operator vouched for it.
  let identityNote = "";
  if (clientDisplay.verifiedDomain) {
    identityNote = renderCitizenNote(`Dominio verificado: ${clientDisplay.verifiedDomain}`, ui);
  } else if (clientDisplay.isUnverified) {
    identityNote = renderCitizenNote("Nombre declarado por la aplicación · no verificado", ui);
  }

  const rows: CitizenRow[] = [
    { authorship: "client", html: `${ui.escapeHtml(clientName)}${identityNote}`, label: "Quién solicita" },
  ];
  const clientPurpose = selection.purpose_description || selection.purpose_code;
  if (clientPurpose) {
    rows.push({
      authorship: "client",
      html: `${ui.escapeHtml(clientPurpose)}${renderCitizenNote("Declarado por la aplicación", ui)}`,
      label: "Para qué",
    });
  }
  if (sourceId) {
    rows.push({ authorship: "protocol", html: ui.escapeHtml(citizenSourceLabel(sourceId)), label: "Fuente" });
  }
  rows.push({ authorship: "manifest", html: streamsHtml, label: "Qué datos" });
  rows.push({
    authorship: "protocol",
    html: ui.escapeHtml(accessModeLabel(selection.access_mode)),
    label: "Tipo de acceso",
  });
  const retention = describeRetention(selection.retention);
  if (retention) {
    rows.push({ authorship: "protocol", html: ui.escapeHtml(retention), label: "Conservación" });
  }

  let continuousBlock = "";
  if (selection.access_mode === "continuous") {
    const continuousBody = selection.retention?.max_duration
      ? "Es un acceso prolongado: la aplicación podrá seguir leyendo hasta que usted revoque la autorización o se cumpla el plazo de conservación."
      : "Es un acceso prolongado sin fecha de fin explícita. La aplicación podrá seguir leyendo hasta que usted revoque la autorización.";
    continuousBlock = `<div class="cu-warning" role="note"><b>Acceso continuo</b>${ui.escapeHtml(continuousBody)}</div>`;
  }

  const codeBlock = pending.userCode
    ? `<p class="cu-code">Código de verificación<b>${ui.escapeHtml(pending.userCode)}</b></p>`
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
    `<h2 class="cu-title">${ui.escapeHtml(clientName)} solicita acceso a sus datos</h2>`,
    `<p class="cu-text">Revise qué solicita esta aplicación. Su servidor solo entregará lo que usted autorice aquí.</p>`,
    codeBlock,
    renderCitizenSummary(rows, ui),
    renderCitizenClaims(selection.client_claims, ui),
    continuousBlock,
    actions,
  ]
    .filter(Boolean)
    .join("\n");

  return renderCitizenConsentDocument(body, "Solicitud", providerName, ui);
}

// ─── DR demo: one-screen consent for declared requests ─────────────────────
//
// A client that declares its request on GET /oauth/authorize (one or more
// authorization_details, optional expires_at) gets ONE screen, already
// reviewed server-side: who asks, for what, from which institutions, which
// fields, until when. "Allow" posts the reviewed revision to /consent/approve.
//
//   ┌ <client> solicita acceso a sus datos ────────────────┐
//   │ Quién solicita · Para qué · Instituciones · Qué datos │
//   │ Tipo de acceso · Hasta cuándo                         │
//   │ ▸ Detalles técnicos                                   │
//   │ [ Autorizar ]  [ Rechazar ]                           │
//   └───────────────────────────────────────────────────────┘

type ReviewedSource = Omit<ApprovalReviewSourceEntry, "index">;

// English labels for the demo sources; other keys fall back to the key, humanized.
const EN_STREAM_LABELS: Record<string, string> = {
  clasificacion_hogar: "Household socio-economic classification",
  control_prenatal: "Prenatal care",
  licencias_conducir: "Driving licence",
  miembros_hogar: "Registered household members",
};
const EN_FIELD_LABELS: Record<string, string> = {
  categoria: "Category",
  cedula: "Cédula (ID number)",
  cedula_jefe_hogar: "Head of household's cédula",
  centro_salud: "Health centre",
  controles_prenatales: "Prenatal check-ups",
  edad: "Age",
  estado: "Status",
  fecha_expedicion: "Issue date",
  fecha_probable_parto: "Expected due date",
  fecha_ultima_consulta: "Last check-up",
  fecha_ultima_visita: "Last visit",
  fecha_vencimiento: "Expiry date",
  grupo_sanguineo: "Blood group",
  hogar_id: "Household identifier",
  icv_descripcion: "ICV description",
  icv_grupo: "ICV group",
  icv_puntaje: "ICV score",
  id: "Identifier",
  miembros_hogar: "Household members",
  municipio: "Municipality",
  nivel_educativo: "Education level",
  nombre: "Name",
  nombre_jefe_hogar: "Head of household's name",
  numero_licencia: "Licence number",
  ocupacion: "Occupation",
  parentesco: "Relationship",
  programas_activos: "Active programmes",
  provincia: "Province",
  restricciones: "Restrictions",
  riesgo_obstetrico: "Obstetric risk",
  semanas_gestacion: "Weeks of pregnancy",
  sexo: "Sex",
  source_updated_at: "Last updated",
  tipo_sangre: "Blood type",
  vacunas_embarazo: "Pregnancy vaccines",
};
const EN_ACCESS_MODE_LABELS: Record<string, string> = {
  continuous: "Ongoing access",
  single_use: "One-time access",
};

/** `semanas_gestacion` → "Weeks of pregnancy"; unknown keys → "Some key". */
function humanizeFieldLabel(name: string, lang: DemoLang): string {
  if (lang === "es") {
    return humanizeEsLabel(name);
  }
  const known = EN_FIELD_LABELS[name];
  if (known) {
    return known;
  }
  const text = name.replace(/[_-]+/g, " ").trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** "2027-02-01T03:59:59Z" → "31 de enero de 2027" / "January 31, 2027" (Santo Domingo). */
function formatEndDate(iso: string, lang: DemoLang): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return new Intl.DateTimeFormat(lang === "en" ? "en-US" : "es-DO", {
    dateStyle: "long",
    timeZone: DR_TIME_ZONE,
  }).format(date);
}

function describeEndDate(expiresAt: string | null, lang: DemoLang): string {
  if (!expiresAt) {
    return pickLang(lang, "Hasta que usted la cancele", "Until you cancel it");
  }
  const date = formatEndDate(expiresAt, lang);
  return pickLang(lang, `Hasta el ${date}`, `Until ${date}`);
}

function renderDeclaredStreams(source: ReviewedSource, lang: DemoLang, ui: ConsentUiRenderer): string {
  const items = source.resolved_streams.map((stream) => {
    const es = describeCitizenStream(source.source.id, stream.name);
    const label = lang === "es" ? es.label : (EN_STREAM_LABELS[stream.name] ?? humanizeFieldLabel(stream.name, lang));
    const detail = lang === "es" && es.detail ? `<small>${ui.escapeHtml(es.detail)}</small>` : "";
    const chips = stream.fields
      .map((field) => `<span class="cu-chip">${ui.escapeHtml(humanizeFieldLabel(field, lang))}</span>`)
      .join("");
    return `<li><b>${ui.escapeHtml(label)}</b>${detail}<div class="cu-chips">${chips}</div></li>`;
  });
  return `<ul class="cu-streams">${items.join("")}</ul>`;
}

function buildDeclaredTechSections(
  review: ApprovalReviewArtifact,
  sources: ReviewedSource[],
  revision: string,
  lang: DemoLang
): TechSection[] {
  const t = (es: string, en: string) => pickLang(lang, es, en);
  return [
    {
      facts: [
        { label: t("ID del cliente", "Client ID"), value: review.client.client_id },
        { label: t("Modo de registro", "Registration mode"), value: review.client.registration_mode },
        { label: t("ID del titular", "Subject ID"), value: review.subject.id },
        { label: "expires_at", value: review.expires_at },
        { label: "approval_review_revision", value: revision },
      ],
      heading: t("Solicitud", "Request"),
    },
    ...sources.map((source) => ({
      facts: [
        { label: t("ID de la fuente", "Source ID"), value: source.source.id },
        { label: t("Versión de la declaración", "Declaration version"), value: source.source_declaration.version },
        { label: t("Huella de la declaración", "Declaration digest"), value: source.source_declaration.digest },
        { label: "purpose_code", value: source.purpose_code },
        { label: "access_mode", value: source.access_mode },
        ...source.resolved_streams.map((stream) => ({ label: stream.name, value: stream.fields.join(", ") })),
      ],
      heading: citizenSourceLabel(source.source.id),
    })),
  ];
}

function buildDeclaredActions(
  pending: PendingGrant,
  requestUri: string,
  csrf: Array<{ name: string; value: string }>,
  lang: DemoLang,
  ui: ConsentUiRenderer
): string {
  const request = [{ name: "request_uri", value: requestUri }];
  // Batch approval requires an explicit confirmation; the Allow click is it.
  const confirm = pending.batch ? [{ name: "confirm_reviewed_decision", value: "1" }] : [];
  const approveHidden = [
    ...csrf,
    { name: "approval_review_revision", value: pending.reviewRevision ?? "" },
    ...request,
    ...confirm,
  ];
  const allow = `<form class="hosted-ui-form" method="POST" action="/consent/approve">${hiddenInputs(
    approveHidden,
    ui
  )}<button type="submit" class="cu-btn cu-block">${pickLang(lang, "Autorizar", "Allow")}</button></form>`;
  const denyLabel = pickLang(lang, "Rechazar", "Deny");
  const deny = `<form class="hosted-ui-form" method="POST" action="/consent/deny">${hiddenInputs(
    [...csrf, ...request],
    ui
  )}<button type="submit" class="cu-btn cu-outline-danger cu-block">${denyLabel}</button></form>`;
  return `<div class="cu-actions">${allow}${deny}</div>`;
}

/**
 * The one consent screen for a declared request whose review the server has
 * already finalized (`pending.review` + `pending.reviewRevision`).
 */
export function renderDeclaredConsentHtml(
  pending: PendingGrant,
  requestUri: string,
  opts: {
    csrfFieldName: string;
    csrfToken: string | null;
    lang: DemoLang;
    providerName: string;
    ui: ConsentUiRenderer;
  }
): string {
  const { lang, ui } = opts;
  const { review, reviewRevision } = pending;
  if (!(review && reviewRevision)) {
    throw new Error("Declared consent requires a finalized review");
  }
  const t = (es: string, en: string) => pickLang(lang, es, en);
  const sources: ReviewedSource[] = review.version === "reference.batch-approval-review.v1" ? review.sources : [review];
  const clientDisplay = buildConsentClientDisplay(review.client, ui);
  const clientName = clientDisplay.displayName;

  let identityNote = "";
  if (clientDisplay.verifiedDomain) {
    identityNote = renderCitizenNote(
      `${t("Dominio verificado", "Verified domain")}: ${clientDisplay.verifiedDomain}`,
      ui
    );
  } else if (clientDisplay.isUnverified) {
    identityNote = renderCitizenNote(
      t("Nombre declarado por la aplicación · no verificado", "Name stated by the app · not verified"),
      ui
    );
  }
  const purposes = [...new Set(sources.map((source) => source.purpose_description || source.purpose_code))];
  const purposeHtml = `${purposes.map((purpose) => ui.escapeHtml(purpose)).join("<br>")}${renderCitizenNote(
    t("Declarado por la aplicación", "Stated by the app"),
    ui
  )}`;
  const institutionsHtml = sources.map((source) => ui.escapeHtml(citizenSourceLabel(source.source.id))).join("<br>");
  const dataHtml = sources
    .map((source) => {
      const heading = `<p class="cu-text"><b>${ui.escapeHtml(citizenSourceLabel(source.source.id))}</b></p>`;
      return `${heading}${renderDeclaredStreams(source, lang, ui)}`;
    })
    .join("");
  const accessMode = sources[0]?.access_mode ?? "";
  const accessLabel = lang === "es" ? accessModeLabel(accessMode) : (EN_ACCESS_MODE_LABELS[accessMode] ?? accessMode);

  const endDateHtml = `<b data-expires-at="${ui.escapeHtml(review.expires_at ?? "")}">${ui.escapeHtml(
    describeEndDate(review.expires_at, lang)
  )}</b>`;
  const rows: CitizenRow[] = [
    {
      authorship: "client",
      html: `${ui.escapeHtml(clientName)}${identityNote}`,
      label: t("Quién solicita", "Who is asking"),
    },
    { authorship: "client", html: purposeHtml, label: t("Para qué", "What for") },
    { authorship: "protocol", html: institutionsHtml, label: t("De qué instituciones", "From which institutions") },
    { authorship: "manifest", html: dataHtml, label: t("Qué datos", "Which data") },
    { authorship: "protocol", html: ui.escapeHtml(accessLabel), label: t("Tipo de acceso", "Type of access") },
    { authorship: "protocol", html: endDateHtml, label: t("Hasta cuándo", "Until when") },
  ];

  const csrf = opts.csrfToken ? [{ name: opts.csrfFieldName, value: opts.csrfToken }] : [];
  const body = [
    `<h2 class="cu-title">${ui.escapeHtml(
      t(`${clientName} solicita acceso a sus datos`, `${clientName} is asking to access your data`)
    )}</h2>`,
    `<p class="cu-text">${ui.escapeHtml(
      t(
        "Solo se compartirá lo que aparece aquí. Puede cancelar esta autorización cuando quiera.",
        "Only what is listed here will be shared. You can cancel this authorization at any time."
      )
    )}</p>`,
    renderCitizenSummary(rows, ui),
    renderTechnicalDetails(
      buildDeclaredTechSections(review, sources, reviewRevision, lang),
      ui,
      t("Detalles técnicos", "Technical details")
    ),
    buildDeclaredActions(pending, requestUri, csrf, lang, ui),
  ].join("\n");

  const cardTitle = t(CONSENT_CARD_TITLE, "Data access authorization");
  return ui.renderHostedDocument({
    body: renderCitizenCard({ body, glyph: CITIZEN_GLYPHS.shield, title: cardTitle }),
    // The ES | EN toggle reloads this same screen.
    currentUrl: `/consent?request_uri=${encodeURIComponent(requestUri)}`,
    lang,
    providerName: opts.providerName,
    shell: CONSENT_SHELL,
    title: cardTitle,
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
 * Grant expiry as its own row, never as a restatement of the access mode.
 *
 * `spec-core.md:889` lists grant validity, data temporal scope, and access
 * pattern as three orthogonal concepts that MUST NOT be conflated. The note
 * this replaces — "No expiry — access lasts until you revoke it, whichever
 * access mode you choose above" — restated the mode and contradicted the
 * control directly above it, because under One-time access a grant is
 * consumed at first token issuance rather than lasting until revocation.
 *
 * The default is bounded. Indefinite access is available and explicit, which
 * is the polarity Google uses and the right one: an owner who wants to grant
 * forever should say so, and an owner who does nothing should end up with a
 * window that closes by itself.
 */
function renderGrantExpiryControl(ui: ConsentUiRenderer): string {
  const options = HOSTED_MCP_GRANT_EXPIRY_OPTIONS.map((option) => {
    const checked = option.id === HOSTED_MCP_DEFAULT_GRANT_EXPIRY_ID ? " checked" : "";
    return `<label class="hosted-ui-expiry-option">
        <input type="radio" name="grant_expiry" value="${ui.escapeHtml(option.id)}"${checked} />
        <span class="hosted-ui-expiry-label">${ui.escapeHtml(option.label)}</span>
      </label>`;
  }).join("");
  return `<fieldset class="hosted-ui-expiry" data-hosted-mcp-grant-expiry>
      <legend class="hosted-ui-expiry-legend">Cuándo termina este acceso</legend>
      <p class="hosted-ui-expiry-hint">Puede revocarlo antes en cualquier momento.</p>
      ${options}
    </fieldset>`;
}

/**
 * Per-stream scope controls: which fields, and over what dates.
 *
 * Progressive disclosure, closed by default. The common path is unchanged —
 * check a stream, get everything in it — and the narrowing is one click away
 * for the owner who wants it. Rendering a dozen field checkboxes per stream
 * inline, across 150-odd streams, would produce a page nobody can read, and
 * the summary line states the resolved scope so the closed state is never
 * ambiguous about what it means.
 *
 * A control appears only where the declaration supports it: `selection.fields`
 * for the field list, `consent_time_field` for the dates. Offering either
 * where the manifest lacks it would produce a 400 at issuance, after the owner
 * had already chosen. A stream that supports neither renders nothing at all —
 * silence is the correct rendering of an inapplicable control.
 *
 * Schema-required fields render checked and disabled (`spec-core.md:764` makes
 * them the consent floor). Showing them greyed rather than hiding them means
 * the owner sees what they cannot exclude, instead of unchecking something and
 * being silently overruled at issuance.
 */
function renderStreamScopeControls(
  sourceKey: string,
  streamName: string,
  scope: StreamScopeCapability,
  ui: ConsentUiRenderer
): string {
  const canNarrowFields = scope.supportsFieldNarrowing && scope.optionalFields.length > 0;
  if (!(canNarrowFields || scope.timeField)) {
    return "";
  }
  const totalFields = scope.requiredFields.length + scope.optionalFields.length;
  const label = humanizeStreamLabel(streamName).toLowerCase();

  const fieldControls = canNarrowFields
    ? `<fieldset class="hosted-ui-scope-fields">
        <legend class="hosted-ui-scope-legend">Campos</legend>
        ${scope.requiredFields
          .map(
            (field) =>
              `<label class="hosted-ui-scope-field hosted-ui-scope-field--required"><input type="checkbox" checked disabled /> ${ui.escapeHtml(
                humanizeStreamLabel(field)
              )} <span class="hosted-ui-scope-required-note">siempre incluido</span></label>`
          )
          .join("")}
        ${scope.optionalFields
          .map(
            (field) =>
              `<label class="hosted-ui-scope-field"><input type="checkbox" name="${ui.escapeHtml(
                scopeFieldsInputName(sourceKey, streamName)
              )}" value="${ui.escapeHtml(field)}" checked /> ${ui.escapeHtml(humanizeStreamLabel(field))}</label>`
          )
          .join("")}
      </fieldset>`
    : "";

  // spec-core.md:545 — temporal consent is rendered in the stream's own terms
  // ("messages created on or after ..."), never as `time_range`.
  const dateControls = scope.timeField
    ? `<fieldset class="hosted-ui-scope-dates">
        <legend class="hosted-ui-scope-legend">Fechas</legend>
        <p class="hosted-ui-scope-hint">Leave blank for all ${ui.escapeHtml(label)}, whenever they were ${ui.escapeHtml(
          describeTimeField(scope.timeField)
        )}.</p>
        <label class="hosted-ui-scope-date">${ui.escapeHtml(
          describeTimeField(scope.timeField)
        )} on or after <input type="date" name="${ui.escapeHtml(scopeSinceInputName(sourceKey, streamName))}" /></label>
        <label class="hosted-ui-scope-date">and on or before <input type="date" name="${ui.escapeHtml(
          scopeUntilInputName(sourceKey, streamName)
        )}" /></label>
      </fieldset>`
    : "";

  const summary = canNarrowFields ? `Los ${totalFields} campos · todas las fechas` : "Todas las fechas";

  return `<details class="hosted-ui-scope" data-hosted-mcp-stream-scope data-stream="${ui.escapeHtml(streamName)}" data-required-fields="${ui.escapeHtml(
    JSON.stringify(scope.requiredFields)
  )}">
      <summary class="hosted-ui-scope-summary">${ui.escapeHtml(summary)}</summary>
      ${fieldControls}
      ${dateControls}
    </details>`;
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
  // treat a client with none as unverified. Both are now reachable: a client
  // that published a valid metadata document at its own https client_id has
  // proven control of that domain, which is what makes the unverified state
  // meaningful for everyone else. A badge that cannot vary carries no
  // information and reads as an accusation against an app that has done
  // nothing wrong.
  //
  // The verified line names the DOMAIN, not the app. Domain control proves who
  // published the metadata; it says nothing about whether the application is
  // honest or safe. "Verified app" would be the more flattering phrasing and
  // the more dangerous one, because an owner would act on it.
  const trustLine = clientDisplay.isUnverified
    ? `<p class="hosted-ui-client-trust" data-trust="unverified" role="status">Esta aplicación no está registrada en el servidor. Su nombre y logo son declarados por ella misma.</p>`
    : clientDisplay.verifiedDomain
      ? `<p class="hosted-ui-client-trust" data-trust="domain-verified" role="status">Dominio verificado: ${ui.escapeHtml(
          clientDisplay.verifiedDomain
        )} — esta aplicación controla ese dominio. El servidor no ha verificado nada más sobre ella.</p>`
      : `<p class="hosted-ui-client-trust" data-trust="registered" role="status">Registrada por usted en el servidor.</p>`;
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
    ? renderAuthorshipBlock("client", "Enlaces publicados por la aplicación", policyLinksHtml, ui)
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
    "Lo que fija el servidor y lo que declaró la aplicación",
    ui.renderKeyValueList([
      {
        label: "Finalidad",
        // One sentence, said once, with its origin named inside it.
        // This was three rows — a `Purpose` row saying the server assigned
        // it, a `Purpose description` row saying what it was, and a
        // `Purpose code` row printing `https://pdpp.dev/purpose/agent_context`
        // — for one idea. The registry code is a protocol identifier, not
        // owner-facing copy; it stays in the grant and the audit record.
        value: `Fijada por el servidor porque ${clientName} no indicó una: usar los datos que seleccione como contexto para su asistente.`,
      },
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
  const silence = `${clientName} no indicó cuánto tiempo conserva los datos que recibe.`;
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
  const clientName = clientDisplay?.displayName ?? "Esta aplicación";
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
      return '<p class="hosted-ui-option-streams-empty">Esta fuente no tiene datos disponibles para compartir.</p>';
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
            ${renderStreamScopeControls(row.sourceKey, stream.name, stream.scope, ui)}
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
                  row.sourceKind === "connector" ? "Leído directamente de esta fuente" : "Leído de datos que usted importó"
                )}</span>`
              : "";
          // The disclosure is its own control, beside the checkbox rather
          // than sharing its row. The checkbox grants the source; the
          // disclosure only reveals its streams. Those are different acts,
          // and when the affordance was `::after` generated text on the
          // summary, one tap on a phone had two plausible outcomes and the
          // control could be neither labelled nor sized.
          const disclosureLabel = `Ver qué puede compartir ${row.connectorTypeLabel}`;
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
                <span class="hosted-ui-disclosure-label" aria-hidden="true">Elegir datos</span>
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
      `<p class="pdpp-body">Todavía no hay fuentes de datos conectadas. Conecte una y vuelva a iniciar esta solicitud.</p>
        <div class="hosted-ui-actions hosted-ui-decision-actions">
          <button type="submit" class="hosted-ui-button" data-variant="ghost" name="decision" value="cancel" formaction="/oauth/authorize/mcp-package/cancel" formnovalidate>Cancelar</button>
          ${
            typeof opts.connectionsUrl === "string" && opts.connectionsUrl
              ? `<a class="hosted-ui-button" data-variant="primary" href="${ui.escapeHtml(opts.connectionsUrl)}">Conectar una fuente</a>`
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
    ? `<section class="hosted-ui-review" data-hosted-mcp-review aria-live="polite" aria-label="Lo que está autorizando">
          <h2 class="pdpp-title">Lo que está autorizando</h2>
          <p class="hosted-ui-review-empty" data-hosted-mcp-review-empty>Nada seleccionado todavía.</p>
          <dl class="hosted-ui-kv hosted-ui-review-terms" data-hosted-mcp-review-terms hidden>
            <dt>Aplicación</dt><dd>${ui.escapeHtml(clientName)}</dd>
            <dt>Datos</dt><dd data-hosted-mcp-review-scope></dd>
            <dt>Alcance</dt><dd>Todo lo que contiene cada tipo de dato marcado, salvo que lo haya limitado arriba.</dd>
            <dt>Duración</dt><dd data-hosted-mcp-review-duration></dd>
            <dt>Fin</dt><dd>${ui.escapeHtml(HOSTED_MCP_PICKER_GRANT_EXPIRY_COPY)}</dd>
            <dt>Conservación de sus datos</dt><dd>${ui.escapeHtml(buildHostedMcpRetentionSentence(clientName))}</dd>
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
          <button type="submit" class="hosted-ui-button" data-variant="ghost" name="decision" value="cancel" formaction="/oauth/authorize/mcp-package/cancel" formnovalidate>Cancelar</button>
          <button type="submit" class="hosted-ui-button" data-variant="primary" name="decision" value="allow">Autorizar acceso</button>
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
      `<p class="pdpp-body">Puede revocar este acceso más tarde desde su página de autorizaciones.</p>`
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
      ? `<div class="hosted-ui-error hosted-ui-picker-error" role="alert" data-hosted-mcp-picker-error data-default-message="Elija al menos un tipo de dato para continuar."${validationError ? "" : " hidden"}>${ui.escapeHtml(validationError)}</div>`
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
    ? `<p class="hosted-ui-picker-counter" role="status" aria-live="polite" data-hosted-mcp-counter>Nada seleccionado todavía.</p>`
    : "";

  const bulkControls = rows.length
    ? `
        ${sourceFilter}
        <div class="hosted-ui-actions hosted-ui-picker-toolbar" aria-label="Controles de fuentes">
          <button type="button" class="hosted-ui-button" data-hosted-mcp-select-sources>Marcar todas las fuentes</button>
          <button type="button" class="hosted-ui-button" data-hosted-mcp-clear-sources>Quitar selección</button>
          <span class="hosted-ui-toolbar-divider" aria-hidden="true"></span>
          <button type="button" class="hosted-ui-button" data-hosted-mcp-expand-all>Mostrar todos los datos</button>
          <button type="button" class="hosted-ui-button" data-hosted-mcp-collapse-all>Ocultar todos los datos</button>
        </div>
        ${selectionCounter}
      `
    : "";

  const accessModeControl = rows.length
    ? `
        <fieldset class="hosted-ui-access-mode">
          <legend class="hosted-ui-access-mode-legend">Tipo de acceso</legend>
          <label class="hosted-ui-access-mode-option">
            <input type="radio" name="access_mode" value="continuous" checked />
            <span class="hosted-ui-access-mode-body">
              <span class="hosted-ui-access-mode-label">Acceso continuo</span>
              <span class="hosted-ui-access-mode-meta">${ui.escapeHtml(clientName)} puede leer los datos que seleccione, incluidos registros nuevos, hasta que usted revoque el acceso.</span>
            </span>
          </label>
          <label class="hosted-ui-access-mode-option">
            <input type="radio" name="access_mode" value="single_use" />
            <span class="hosted-ui-access-mode-body">
              <span class="hosted-ui-access-mode-label">Acceso único</span>
              <span class="hosted-ui-access-mode-meta">${ui.escapeHtml(clientName)} puede hacer una sola consulta. No puede hacer otra sin su aprobación.</span>
            </span>
          </label>
        </fieldset>
        ${renderGrantExpiryControl(ui)}
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
      counter.textContent = "Nada seleccionado todavía.";
      return;
    }
    const sourceCount = sources.filter((s) => streamsFor(s).some((b) => b.checked)).length;
    counter.textContent =
      plural(sourceCount, "fuente", "fuentes") + " · " + plural(streams.length, "tipo de dato", "tipos de datos");
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
    if (label) label.textContent = open ? "Ocultar datos" : "Elegir datos";
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

  const normalizeDateBound = (value, bound) => {
    if (!value || !value.trim()) return null;
    const trimmed = value.trim();
    if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(trimmed)) return trimmed;
    const parsed = Date.parse(trimmed + "T00:00:00.000Z");
    if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== trimmed) return trimmed;
    return new Date(bound === "until" ? parsed + 24 * 60 * 60 * 1000 : parsed).toISOString();
  };

  const uniqueSorted = (values) => Array.from(new Set(values.map((value) => String(value).trim()).filter(Boolean))).sort();

  const readRequiredFields = (scope) => {
    if (!scope) return [];
    try {
      const parsed = JSON.parse(scope.dataset.requiredFields || "[]");
      return Array.isArray(parsed) ? parsed.map((value) => String(value)) : [];
    } catch {
      return [];
    }
  };

  const readStreamDecision = (streamBox) => {
    const scope = streamBox.closest(".hosted-ui-stream-option")?.nextElementSibling;
    const stream = { name: streamBox.dataset.streamName || "" };
    if (!scope?.matches?.("[data-hosted-mcp-stream-scope]")) {
      return stream;
    }
    const fieldInputs = Array.from(scope.querySelectorAll('input[name^="narrow_fields_"]'));
    if (fieldInputs.length > 0) {
      stream.fields = uniqueSorted([
        ...fieldInputs.filter((input) => input.checked).map((input) => input.value),
        ...readRequiredFields(scope),
      ]);
    }
    const since = normalizeDateBound(scope.querySelector('input[name^="narrow_since_"]')?.value || "", "since");
    const until = normalizeDateBound(scope.querySelector('input[name^="narrow_until_"]')?.value || "", "until");
    if (since || until) {
      stream.timeRange = Object.assign({}, since ? { since } : {}, until ? { until } : {});
    }
    return stream;
  };

  const readDecision = () => {
    const selected = [];
    for (const source of sources) {
      const streams = streamsFor(source)
        .filter((streamBox) => streamBox.checked)
        .map(readStreamDecision)
        .sort((a, b) => a.name.localeCompare(b.name));
      if (streams.length > 0) {
        selected.push({ sourceKey: source.dataset.sourceKey || "", streams });
      }
    }
    selected.sort((a, b) => (a.sourceKey < b.sourceKey ? -1 : a.sourceKey > b.sourceKey ? 1 : 0));
    const modeInput = form.querySelector('input[name="access_mode"]:checked');
    const expiryInput = form.querySelector('input[name="grant_expiry"]:checked');
    return {
      accessMode: modeInput ? modeInput.value : "continuous",
      clientId,
      grantExpiry: expiryInput ? expiryInput.value : "",
      sources: selected,
    };
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
    const total = decision.sources.reduce((sum, source) => sum + source.streams.length, 0);
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
          ? "Acceso único — una consulta y ninguna más sin su aprobación."
          : "Acceso continuo — incluidos registros nuevos, hasta que usted lo revoque.";
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
      setError(error?.dataset.defaultMessage || "Elija al menos una fuente de datos para continuar.");
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
      setError("Elija datos de cada fuente seleccionada, o quite esa fuente.");
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
    ? `${clientDisplay.displayName} solicita leer sus datos`
    : "Elija qué puede leer esta aplicación";

  // The uniform-kind summary ("All sources below are connector-backed") is
  // gone with the per-row badge: it stated a protocol classification the
  // owner has no decision to make about. `source.kind` remains in the grant
  // and the audit record.
  const sourceKindSummaryInline = "";

  // Resolved field/time-range scope (Grant fields: `streams[].fields`,
  // `streams[].time_constraint`; approval-artifact requirement,
  // spec-core.md:873-880).
  //
  // Two earlier wordings were wrong in the same direction. "All fields of each
  // stream you check; no date-range limit." read as though the absence were a
  // property of the protocol, and "Everything in each data type you check,
  // with no date limit." described an unbuilt feature as a constraint. Neither
  // was true: `fields` is a protocol-enforced allowlist (spec-core.md:761) and
  // `time_range` is evaluated against each stream's `consent_time_field`
  // (:758-759), which most fleet streams declare.
  //
  // Both controls now exist, per stream, behind a closed disclosure. The
  // default is still everything — so this states the default and points at the
  // control, rather than describing the breadth as inevitable. The approval
  // artifact restates the same term (spec-core.md:873-877).
  const fieldsAndTimeRangeSummary =
    '<p class="hosted-ui-fields-timerange-summary">Cada tipo de dato marcado se comparte completo, salvo que lo limite. Abra un tipo de dato para elegir campos o fechas.</p>';

  // PROTOCOL: the stream-selection controls and the access-mode fieldset are
  // both server-enforced (spec section 706) — wrap them together so the whole
  // picker, not only the new client-identity/purpose additions above, keeps
  // its categories visually distinct.
  const protocolSelectionBlock = renderAuthorshipBlock(
    "protocol",
    "Datos y acceso que el servidor hará cumplir",
    `${sourceKindSummaryInline}${fieldsAndTimeRangeSummary}<div class="hosted-ui-option-group">${options}</div>${accessModeControl}`,
    ui
  );

  return ui.renderHostedDocument({
    body: [
      ui.renderPageIntro({
        eyebrow: "Solicitud de acceso a datos",
        lede: "Elija qué puede leer. Lo que no marque sigue siendo privado.",
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
    title: `${providerName} — Autorizar acceso a datos`,
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
