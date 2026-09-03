// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
// biome-ignore-all lint/performance/useTopLevelRegex: hosted-flow assertions keep semantic patterns beside the assertion.
// biome-ignore-all lint/suspicious/useAwait: async helper wrappers preserve the existing test API and call-site behavior.

import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
// biome-ignore lint/correctness/noUnresolvedImports: Biome resolver cannot model this installed package export
import Database from "better-sqlite3";
import {
  buildPendingConsentRequestUri,
  countGrantPackagesForOwner,
  getGrantPackageAccess,
  revokeGrant,
  revokeGrantPackage,
} from "../server/auth.ts";
import { canonicalConnectorKey, canonicalConnectorKeyFromManifest } from "../server/connector-key.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { encodeHostedMcpSelection, encodeHostedMcpStreamSelection, hostedMcpSourceKey } from "../server/hosted-mcp-selection.ts";
import { computeHostedMcpDecisionDigest } from "../server/routes/as-consent-ui-helpers.ts";
import { startServer } from "../server/index.ts";
import { basicIntrospectionAuthorization } from "../server/introspection-http.ts";
import { ingestRecord, queryRecordsAcrossBindings, resolveReadRequestBindings } from "../server/records.ts";
import { createSqliteConnectorInstanceStore } from "../server/stores/connector-instance-store.ts";
import {
  TEST_INTROSPECTION_SERVER_OPTS,
  TEST_RS_INTROSPECTION_CREDENTIALS,
} from "./helpers/introspection-test-credentials.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMPL_DIR = join(__dirname, "..");
const INTROSPECTION_AUTHORIZATION = basicIntrospectionAuthorization(TEST_RS_INTROSPECTION_CREDENTIALS);

interface CloseableTestServer {
  readonly asPort: number;
  readonly asServer: { closeAllConnections?: () => void; close: (callback: () => void) => void };
  readonly rsPort: number;
  readonly rsServer: { closeAllConnections?: () => void; close: (callback: () => void) => void };
}

async function closeServer(server: CloseableTestServer): Promise<void> {
  server.asServer.closeAllConnections?.();
  server.rsServer.closeAllConnections?.();
  await Promise.allSettled([
    new Promise<void>((resolve) => server.asServer.close(() => resolve())),
    new Promise<void>((resolve) => server.rsServer.close(() => resolve())),
  ]);
}

interface JsonResponse {
  readonly body: Record<string, unknown>;
  readonly resp: Response;
  readonly status: number;
}

async function fetchJson(url: string | URL, opts: RequestInit = {}): Promise<JsonResponse> {
  const resp = await fetch(url, opts);
  const body = (await resp.json()) as Record<string, unknown>;
  return { body, resp, status: resp.status };
}

async function introspectAccessToken(asUrl: string, token: string): Promise<Record<string, unknown>> {
  const response = await fetchJson(`${asUrl}/introspect`, {
    body: new URLSearchParams({ token }).toString(),
    headers: {
      Authorization: INTROSPECTION_AUTHORIZATION,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    method: "POST",
  });
  assert.equal(response.status, 200);
  return response.body;
}

async function reviewConsent(
  asUrl: string,
  requestUri: string,
  subjectId = "owner_local",
  authorization?: string
): Promise<string> {
  const response = await fetch(`${asUrl}/consent/review`, {
    body: JSON.stringify({ request_uri: requestUri, subject_id: subjectId }),
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(authorization ? { Authorization: authorization } : {}),
    },
    method: "POST",
  });
  const body = (await response.json()) as { approval_review?: unknown; approval_review_revision?: unknown };
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.ok(body.approval_review && typeof body.approval_review === "object");
  assert.equal(typeof body.approval_review_revision, "string");
  return body.approval_review_revision as string;
}

function mustExist<T>(value: T | null | undefined, description: string): T {
  assert.ok(value, description);
  return value;
}

function stringField(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  assert.equal(typeof value, "string", `${field} must be a string`);
  return value as string;
}

function resultOf(response: JsonResponse): Record<string, unknown> {
  const { result } = response.body;
  assert.ok(result && typeof result === "object", "response body must carry a result object");
  return result as Record<string, unknown>;
}

function errorOf(response: JsonResponse): Record<string, unknown> {
  const { error } = response.body;
  assert.ok(error && typeof error === "object", "response body must carry an error object");
  return error as Record<string, unknown>;
}

interface SchemaStreamRow extends Record<string, unknown> {
  source: {
    connector_id: string | null;
    connector_key: string | null;
    connection_id: string | null;
    [key: string]: unknown;
  };
}

function schemaStreamRows(schemaBody: Record<string, unknown>): SchemaStreamRow[] {
  const data = (schemaBody.data ?? schemaBody) as Record<string, unknown>;
  if (Array.isArray(data.streams)) {
    return data.streams as SchemaStreamRow[];
  }
  const connectors = (Array.isArray(data.connectors) ? data.connectors : []) as Record<string, unknown>[];
  return connectors.flatMap((connector) => {
    const streams = (Array.isArray(connector?.streams) ? connector.streams : []) as Record<string, unknown>[];
    return streams.map((stream) => {
      const streamSource = (stream?.source && typeof stream.source === "object" ? stream.source : {}) as Record<
        string,
        unknown
      >;
      const connectorSource = (
        connector?.source && typeof connector.source === "object" ? connector.source : {}
      ) as Record<string, unknown>;
      const grantedConnections =
        ((streamSource.granted_connections ?? stream?.granted_connections) as
          | Array<{ connection_id?: string }>
          | undefined) ?? [];
      const connectorGrantedConnections =
        (connector?.granted_connections as Array<{ connection_id?: string }> | undefined) ?? [];
      return {
        ...stream,
        source: {
          ...connectorSource,
          ...streamSource,
          connection_id:
            (streamSource.connection_id as string | undefined) ??
            (stream?.connection_id as string | undefined) ??
            grantedConnections[0]?.connection_id ??
            connectorGrantedConnections[0]?.connection_id ??
            null,
          connector_id:
            (streamSource.connector_id as string | undefined) ??
            (connector?.connector_id as string | undefined) ??
            (connector?.connector_key as string | undefined) ??
            null,
          connector_key:
            (streamSource.connector_key as string | undefined) ??
            (connector?.connector_key as string | undefined) ??
            (connector?.connector_id as string | undefined) ??
            null,
        },
      } as SchemaStreamRow;
    });
  });
}

interface SchemaPackageSource extends Record<string, unknown> {
  connector_id: string;
  grant_id: string;
}

interface SchemaPackageMetadata extends Record<string, unknown> {
  grant_package: unknown;
  member_count: number;
  sources: SchemaPackageSource[];
}

function schemaPackageMetadata(schemaBody: Record<string, unknown>): SchemaPackageMetadata | null {
  const data = (schemaBody.data ?? schemaBody) as Record<string, unknown>;
  return (data.package as SchemaPackageMetadata | undefined) ?? null;
}

function structuredContentData(result: Record<string, unknown>): Record<string, unknown> {
  const structuredContent = result.structuredContent as Record<string, unknown>;
  return structuredContent.data as Record<string, unknown>;
}

interface GrantPackageMember extends Record<string, unknown> {
  connection_id: string | null;
  grant: {
    streams: Array<{ name: string; [key: string]: unknown }>;
    source: { id?: string; [key: string]: unknown };
    [key: string]: unknown;
  };
  grant_id: string;
  grant_storage_binding: {
    connector_id?: string;
    connector_instance_id?: string;
  } | null;
  package_id: string;
  source: Record<string, unknown> | null;
  token: string;
}

interface GrantPackageAccess extends Record<string, unknown> {
  members: GrantPackageMember[];
  package: Record<string, unknown>;
}

interface PinRecordEnvelope {
  data: Record<string, unknown>;
  emitted_at: string;
  key: string;
  stream: string;
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

interface ConnectorManifest {
  connector_id: string;
  connector_key?: string;
  streams: Array<{ name: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

function publicSourceIdForManifest(manifest: ConnectorManifest): string {
  const declaration = manifest.source_declaration;
  if (declaration && typeof declaration === "object") {
    const { source } = declaration as Record<string, unknown>;
    if (source && typeof source === "object") {
      const sourceId = (source as Record<string, unknown>).id;
      if (typeof sourceId === "string") {
        return sourceId;
      }
    }
  }
  try {
    return new URL(manifest.connector_id).href;
  } catch {
    return `https://registry.pdpp.dev/connectors/${encodeURIComponent(manifest.connector_id)}`;
  }
}

// Register a first-party connector fixture with the AS using its canonical
// short connector key (e.g. `spotify`, `github`). The fixture manifests on
// disk still ship URL-shaped `connector_id` values for catalog purposes, but
// the AS storage and the hosted MCP picker key everything by canonical
// connector key now that `canonicalize-connector-keys` has landed. Returning
// the manifest with `connector_id` rewritten to canonical form lets test
// callers reference `manifest.connector_id` and naturally see the same
// identifier the picker renders, the spine event records, and the AS
// validator accepts — without each test re-deriving the canonical key.
function canonicalizeManifestForRegistration(manifest: ConnectorManifest): ConnectorManifest {
  const canonical = canonicalConnectorKeyFromManifest(manifest);
  if (!canonical || canonical === manifest.connector_id) {
    return manifest;
  }
  return { ...manifest, connector_id: canonical };
}

async function registerFirstPartyConnectorFixture(asUrl: string, fixtureName: string): Promise<ConnectorManifest> {
  const raw = JSON.parse(readFileSync(join(REFERENCE_IMPL_DIR, `fixtures/seed-manifests/${fixtureName}.json`), "utf8"));
  const manifest = canonicalizeManifestForRegistration(raw);
  const { status } = await fetchJson(`${asUrl}/connectors`, {
    body: JSON.stringify(manifest),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  assert.equal(status, 201);
  return manifest;
}

async function registerSpotify(asUrl: string): Promise<ConnectorManifest> {
  return registerFirstPartyConnectorFixture(asUrl, "spotify");
}

async function registerGithub(asUrl: string): Promise<ConnectorManifest> {
  return registerFirstPartyConnectorFixture(asUrl, "github");
}

function defaultHostedInstanceId(connectorId: string): string {
  return `cin_hosted_${connectorId}`;
}

async function seedDefaultHostedInstance(manifest: ConnectorManifest): Promise<string> {
  const connectorInstanceId = defaultHostedInstanceId(manifest.connector_id);
  const now = new Date().toISOString();
  await createSqliteConnectorInstanceStore().upsert({
    connectorId: manifest.connector_id,
    connectorInstanceId,
    createdAt: now,
    displayName: `${manifest.connector_id} test account`,
    ownerSubjectId: "owner_local",
    sourceBinding: { fixture: connectorInstanceId },
    sourceBindingKey: connectorInstanceId,
    sourceKind: "account",
    status: "active",
    updatedAt: now,
  });
  return connectorInstanceId;
}

async function registerAuthorizedSpotify(asUrl: string): Promise<ConnectorManifest> {
  const manifest = await registerSpotify(asUrl);
  await seedDefaultHostedInstance(manifest);
  return manifest;
}

async function registerAuthorizedGithub(asUrl: string): Promise<ConnectorManifest> {
  const manifest = await registerGithub(asUrl);
  await seedDefaultHostedInstance(manifest);
  return manifest;
}

interface RegisteredClient {
  client_id: string;
  client_secret?: string;
  [key: string]: unknown;
}

async function registerAuthCodeClient(asUrl: string, opts: { refreshToken?: boolean } = {}): Promise<RegisteredClient> {
  const grantTypes = opts.refreshToken === false ? ["authorization_code"] : ["authorization_code", "refresh_token"];
  const { status, body } = await fetchJson(`${asUrl}/oauth/register`, {
    body: JSON.stringify({
      application_type: "web",
      client_name: "Hosted MCP test client",
      grant_types: grantTypes,
      redirect_uris: ["https://client.example/callback"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  assert.equal(status, 201);
  assert.equal(body.token_endpoint_auth_method, "none");
  assert.deepEqual(body.grant_types, grantTypes);
  assert.deepEqual(body.response_types, ["code"]);
  for (const field of ["client_uri", "logo_uri", "policy_uri", "tos_uri"]) {
    assert.equal(
      Object.hasOwn(body, field),
      false,
      `unset optional DCR metadata field ${field} must be omitted, not null`
    );
  }
  return body as RegisteredClient;
}

async function createCimdClientDocument(asUrl: string, input: unknown): Promise<Record<string, unknown>> {
  const { status, body } = await fetchJson(`${asUrl}/_ref/cimd-client-documents`, {
    body: JSON.stringify(input),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  assert.equal(status, 201);
  assert.ok(body.client_id);
  return body;
}

/**
 * Stamps the approval binding onto a hand-built picker form. `sources` is the
 * decision the SERVER is expected to resolve — for a submission carrying
 * orphaned or duplicate entries, that is deliberately not the same as what
 * the form contains, which is the point: the digest binds what would actually
 * be granted, not what was posted.
 */
function appendDecisionDigest(
  params: URLSearchParams,
  {
    clientId,
    accessMode = "continuous",
    sources,
  }: {
    clientId: string;
    accessMode?: string;
    sources: Array<{ connectorId: string; connectionId?: string | null; streamNames: string[] }>;
  }
): URLSearchParams {
  params.append(
    "decision_digest",
    computeHostedMcpDecisionDigest({
      accessMode,
      clientId,
      sources: sources.map(({ connectorId, connectionId = null, streamNames }) => ({
        sourceKey: hostedMcpSourceKey({ connectionId, connectorId }),
        streamNames: [...streamNames].sort(),
      })),
    })
  );
  return params;
}

// Removed with the picker HTML they parsed: `renderedHostedMcpStreamValues`,
// `decisionDigestForRenderedPicker`, `decodeHtmlAttribute`, and
// `visibleTextFromHtml`. Every caller now reads the console's JSON render
// model (see `fetchPickerConsentModel` below), where stream values, the
// decision digest inputs, and owner-visible copy are fields rather than
// markup to scrape.
function renderedHostedMcpPickerErrorText(html: string): string {
  const match = html.match(/<div[^>]*data-hosted-mcp-picker-error[^>]*>([\s\S]*?)<\/div>/);
  return match ? mustExist(match[1], "capture group must exist") : "";
}

async function issueOwnerToken(asUrl: string): Promise<string> {
  const clientId = "cli_longview";
  const { body: device } = await fetchJson(`${asUrl}/oauth/device_authorization`, {
    body: new URLSearchParams({ client_id: clientId }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });

  const approveResp = await fetch(`${asUrl}/device/approve`, {
    body: new URLSearchParams({
      user_code: stringField(device, "user_code"),
    }).toString(),
    headers: { Accept: "text/html", "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  assert.equal(approveResp.status, 200);

  const { body: tokenBody } = await fetchJson(`${asUrl}/oauth/token`, {
    body: new URLSearchParams({
      client_id: clientId,
      device_code: stringField(device, "device_code"),
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  return stringField(tokenBody, "access_token");
}

interface OauthCodeFlowResult {
  accessToken: string;
  code: string;
  expiresIn: number | null;
  grantId: string | undefined;
  refreshToken: string | null;
}

async function prepareOauthCodeFlow({
  asUrl,
  accessMode = "continuous",
  client,
  manifest,
}: {
  asUrl: string;
  accessMode?: "continuous" | "single_use";
  client: RegisteredClient;
  manifest: ConnectorManifest;
}): Promise<{ code: string; verifier: string }> {
  const verifier = randomBytes(32).toString("base64url");
  const authorizeUrl = new URL(`${asUrl}/oauth/authorize`);
  authorizeUrl.searchParams.set("client_id", client.client_id);
  authorizeUrl.searchParams.set("redirect_uri", "https://client.example/callback");
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("state", "state-123");
  authorizeUrl.searchParams.set("code_challenge", pkceChallenge(verifier));
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  authorizeUrl.searchParams.set(
    "authorization_details",
    JSON.stringify(hostedMcpAuthorizationDetails(manifest, accessMode))
  );

  const authorizeResp = await fetch(authorizeUrl, { redirect: "manual" });
  assert.equal(authorizeResp.status, 302);
  const consentUrl = new URL(
    mustExist(authorizeResp.headers.get("location"), "authorize redirect must carry a Location header"),
    asUrl
  );
  const requestUri = mustExist(consentUrl.searchParams.get("request_uri"), "consent redirect must carry request_uri");
  const reviewRevision = await reviewConsent(asUrl, requestUri);
  const approveResp = await fetch(`${asUrl}/consent/approve`, {
    body: new URLSearchParams({ approval_review_revision: reviewRevision, request_uri: requestUri }).toString(),
    headers: { Accept: "text/html", "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
    redirect: "manual",
  });
  assert.equal(approveResp.status, 302, await approveResp.clone().text());
  const callback = new URL(
    mustExist(approveResp.headers.get("location"), "approve redirect must carry a Location header")
  );
  assert.equal(callback.origin, "https://client.example");
  assert.equal(callback.searchParams.get("state"), "state-123");
  assert.equal(callback.searchParams.has("access_token"), false);
  assert.equal(callback.searchParams.has("grant"), false);
  return {
    code: mustExist(callback.searchParams.get("code"), "callback must carry an authorization code"),
    verifier,
  };
}

async function completeOauthCodeFlow({
  asUrl,
  accessMode = "continuous",
  client,
  manifest,
}: {
  asUrl: string;
  accessMode?: "continuous" | "single_use";
  client: RegisteredClient;
  manifest: ConnectorManifest;
}): Promise<OauthCodeFlowResult> {
  const { code, verifier } = await prepareOauthCodeFlow({ accessMode, asUrl, client, manifest });

  const { status, body } = await fetchJson(`${asUrl}/oauth/token`, {
    body: new URLSearchParams({
      client_id: client.client_id,
      code,
      code_verifier: verifier,
      grant_type: "authorization_code",
      redirect_uri: "https://client.example/callback",
    }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  assert.equal(status, 200);
  assert.equal(body.token_type, "Bearer");
  assert.ok(body.access_token);
  return {
    accessToken: stringField(body, "access_token"),
    code,
    expiresIn: typeof body.expires_in === "number" ? body.expires_in : null,
    grantId: body.grant_id as string | undefined,
    refreshToken: (body.refresh_token as string | undefined) || null,
  };
}

function hostedMcpAuthorizationDetails(
  manifest: ConnectorManifest,
  accessMode: "continuous" | "single_use" = "continuous"
): Record<string, unknown>[] {
  return [
    {
      access_mode: accessMode,
      purpose_code: "https://pdpp.dev/purpose/personal_ai_assistant",
      purpose_description: "Use PDPP data through hosted MCP.",
      source: { id: publicSourceIdForManifest(manifest), kind: "connector" },
      streams: [{ name: "*" }],
      type: "https://pdpp.dev/data-access",
    },
  ];
}

async function startMcpDeviceAuthorization({
  asUrl,
  rsUrl,
  client,
  manifest,
}: {
  asUrl: string;
  rsUrl: string;
  client: RegisteredClient;
  manifest: ConnectorManifest;
}): Promise<JsonResponse> {
  return fetchJson(`${asUrl}/oauth/device_authorization`, {
    body: new URLSearchParams({
      authorization_details: JSON.stringify(hostedMcpAuthorizationDetails(manifest)),
      client_id: client.client_id,
      resource: `${rsUrl}/mcp`,
    }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
}

// Drive the multi-source hosted-MCP consent flow end-to-end:
//   1. Register multiple connectors with the AS.
//   2. Open the picker branch (GET /oauth/authorize without
//      authorization_details) and follow its 302 to the console consent
//      challenge.
//   3. Fetch the challenge's JSON render model and approve every stream of
//      every eligible source, posting the decision to the accept route with a
//      `decision_digest` computed over exactly what was approved.
//   4. Read the client callback out of the accept response and capture the
//      package code.
//   5. Exchange the code for a `grant_package_id`-bearing access token at
//      /oauth/token, including a refresh token.
//
// Steps 2-3 used to read the picker HTML and post the picker form. The consent
// UI now lives in the console, so the same whole-source approval is expressed
// against the challenge model instead. What the helper GUARANTEES is unchanged:
// every registered source must be published as its own row keyed by an opaque
// selection value, and approving them all must mint exactly one package.
//
// Returns the access token, refresh token, package id, and PKCE artefacts so
// the caller can drive /mcp under the package bearer and exercise refresh
// against the same package.
interface MultiSourcePackageFlowResult {
  accessToken: string;
  packageId: string;
  refreshToken: string | null;
  state: string;
  verifier: string;
}

async function completeMultiSourcePackageFlow({
  asUrl,
  client,
  connectorIds,
}: {
  asUrl: string;
  client: RegisteredClient;
  connectorIds: string[];
}): Promise<MultiSourcePackageFlowResult> {
  const verifier = randomBytes(32).toString("base64url");
  const state = "pkg-state-456";
  const codeChallenge = pkceChallenge(verifier);

  // No `authorization_details` and no `connector_id` → the AS parks the
  // request under a consent challenge and hands the decision to the console.
  const challenge = await startPickerConsentChallenge({
    asUrl,
    clientId: client.client_id,
    codeChallenge,
    state,
  });
  const model = await fetchPickerConsentModel(asUrl, challenge);

  // The model MUST NOT publish raw `connector:<url>` selection values: that
  // shape collapsed when split at the first `:`. Each row must carry the
  // structured selection encoding instead, and the URL-shaped connector id
  // MUST appear only in human-facing labels, never as the submitted value.
  for (const source of model.sources) {
    assert.ok(
      !source.selectionValue.startsWith("connector:"),
      "the model MUST NOT publish raw connector:<id> selection values"
    );
    assert.ok(
      !source.selectionValue.startsWith("connection:"),
      "the model MUST NOT publish raw connection:<id>:<id> selection values"
    );
  }
  const selectionValues = new Set(model.sources.map((source) => source.selectionValue));
  for (const id of connectorIds) {
    const encoded = encodeHostedMcpSelection({ connectionId: defaultHostedInstanceId(id), connectorId: id });
    assert.ok(selectionValues.has(encoded), `model should advertise the opaque selection for ${id}`);
  }

  // POST the multi-source approval the way the console does. Owner auth is
  // disabled for tests (`ownerAuthPassword: ''`), so `requireOwnerSession` and
  // `requireCsrf` are no-ops and the decision goes through without a session
  // cookie.
  //
  // The picker makes source selection derive from checked streams. This helper
  // mirrors an explicit whole-source approval by submitting every child stream
  // for every eligible source; tests for narrowing build their own decision
  // instead of going through this helper.
  const chosen = everyPickerConsentSource(model);
  const approve = await postPickerConsentChallenge(
    asUrl,
    challenge,
    "accept",
    pickerConsentAcceptBody({ chosen, clientId: client.client_id, model })
  );
  if (approve.status !== 200) {
    assert.fail(`expected approval, got ${approve.status}: ${JSON.stringify(approve.body)}`);
  }
  const callback = new URL(stringField(approve.body, "redirect_url"));
  assert.equal(callback.origin, "https://client.example");
  assert.equal(callback.searchParams.get("state"), state);
  const code = mustExist(callback.searchParams.get("code"), "callback must carry an authorization code");

  const { status, body } = await fetchJson(`${asUrl}/oauth/token`, {
    body: new URLSearchParams({
      client_id: client.client_id,
      code,
      code_verifier: verifier,
      grant_type: "authorization_code",
      redirect_uri: "https://client.example/callback",
    }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  assert.equal(status, 200);
  assert.equal(body.token_type, "Bearer");
  assert.equal(Number.isInteger(body.expires_in), true);
  assert.ok((body.expires_in as number) > 0);
  assert.ok((body.expires_in as number) <= 600, "refresh-capable package access token is short-lived");
  assert.ok(body.access_token);
  assert.ok(body.grant_package_id, "multi-source approval issues a package-bound token");
  assert.equal(body.grant_id, undefined, "package tokens MUST NOT carry a child grant_id at the OAuth surface");

  return {
    accessToken: stringField(body, "access_token"),
    packageId: stringField(body, "grant_package_id"),
    refreshToken: (body.refresh_token as string | undefined) || null,
    state,
    verifier,
  };
}

async function postMcpJson(
  rsUrl: string,
  token: string,
  message: Record<string, unknown>,
  path = "/mcp"
): Promise<JsonResponse> {
  const resp = await fetch(`${rsUrl}${path}`, {
    body: JSON.stringify(message),
    headers: {
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    method: "POST",
  });
  const body = (await resp.json()) as Record<string, unknown>;
  return { body, resp, status: resp.status };
}

async function postMcpWithHostHeader({
  rsPort,
  token,
  host,
  message,
}: {
  rsPort: number;
  token: string;
  host: string;
  message: Record<string, unknown>;
}): Promise<{ status: number | undefined; body: string }> {
  return await new Promise((resolve, reject) => {
    const body = JSON.stringify(message);
    const req = http.request(
      {
        headers: {
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${token}`,
          "Content-Length": Buffer.byteLength(body),
          "Content-Type": "application/json",
          Host: host,
        },
        hostname: "localhost",
        method: "POST",
        path: "/mcp",
        port: rsPort,
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          text += chunk;
        });
        res.on("end", () => resolve({ body: text, status: res.statusCode }));
      }
    );
    req.on("error", reject);
    req.end(body);
  });
}

function startOpenTestServer(): Promise<CloseableTestServer> {
  return startServer({
    asPort: 0,
    dbPath: ":memory:",
    ownerAuthPassword: "",
    quiet: true,
    rsPort: 0,
    ...TEST_INTROSPECTION_SERVER_OPTS,
  });
}

async function fetchProtectedResourceMetadata(url: string): Promise<Record<string, unknown>> {
  const { status, body } = await fetchJson(url);
  assert.equal(status, 200);
  return body;
}

// ─── Driving the picker branch after the console handoff ────────────────────
//
// `GET /oauth/authorize` with no `authorization_details` and no `connector_id`
// used to render the picker as HTML. It now parks the request under an opaque
// `cc_...` challenge and 302s the owner to the console, which fetches a JSON
// render model and posts the decision back. Every test below that once read
// the picker HTML reads that model instead: the same facts, resolved by the
// same server helpers, with the rendering moved out of the AS.
//
// The narrow, typed helpers live here (before their first use) because they
// serve tests across the whole file; the seven `consent challenge` tests at the
// bottom keep their own copies of the same idiom.

/** Opens the picker branch and returns the consent challenge id it parks. */
async function startPickerConsentChallenge({
  asUrl,
  clientId,
  redirectUri = "https://client.example/callback",
  state,
  codeChallenge,
}: {
  asUrl: string;
  clientId: string;
  redirectUri?: string;
  state: string;
  codeChallenge?: string;
}): Promise<string> {
  const authorizeUrl = new URL(`${asUrl}/oauth/authorize`);
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set(
    "code_challenge",
    codeChallenge ?? pkceChallenge(randomBytes(32).toString("base64url"))
  );
  authorizeUrl.searchParams.set("code_challenge_method", "S256");

  const resp = await fetch(authorizeUrl, { redirect: "manual" });
  assert.equal(resp.status, 302, "the picker branch hands the decision to the console");
  const location = new URL(mustExist(resp.headers.get("location"), "handoff must carry a Location header"));
  return mustExist(location.searchParams.get("challenge"), "the handoff must name a consent challenge");
}

interface PickerConsentStream extends Record<string, unknown> {
  fieldsTotal: number;
  id: string;
  label: string;
  name: string;
  selected: boolean;
  selectionValue: string;
  sentence: string;
  timePhrase?: string;
}

interface PickerConsentSource extends Record<string, unknown> {
  account: string | null;
  icon: { color: string | null; kind: string | null; svg: string | null } | null;
  id: string;
  name: string;
  selectionValue: string;
  streams: PickerConsentStream[];
}

interface PickerConsentModel extends Record<string, unknown> {
  accessMode: { supported: string[]; value: string };
  challenge: string;
  client: {
    domain: string;
    id: string;
    monogram: string;
    name: string;
    policyLinks: Array<{ href: string; label: string }>;
    trust: string;
  };
  grantExpiry: { defaultId: string; options: Array<{ days: number | null; id: string; label: string }> };
  purpose: { code: string; description: string };
  retention: string;
  reviewDigest: string;
  sources: PickerConsentSource[];
}

async function fetchPickerConsentModel(asUrl: string, challenge: string): Promise<PickerConsentModel> {
  const { status, body } = await fetchJson(`${asUrl}/oauth/authorize/consent-challenges/${challenge}`);
  assert.equal(status, 200, JSON.stringify(body));
  return body as unknown as PickerConsentModel;
}

/**
 * Opens the picker branch and returns the render model the console draws from.
 * The direct replacement for the old `fetchHostedMcpPickerHtml`: assertions
 * that used to read the picker HTML read this instead.
 */
async function fetchPickerConsentModelFor({
  asUrl,
  clientId,
  redirectUri = "https://client.example/callback",
  state = "picker-model-state",
}: {
  asUrl: string;
  clientId: string;
  redirectUri?: string;
  state?: string;
}): Promise<PickerConsentModel> {
  const challenge = await startPickerConsentChallenge({ asUrl, clientId, redirectUri, state });
  return await fetchPickerConsentModel(asUrl, challenge);
}

/**
 * The console's accept body for a whole-source approval of `chosen`. The
 * `decision_digest` is the CONSOLE's commitment to what it displayed — the
 * accept route never recomputes it from the submission — so it is computed
 * here over the chosen source keys and stream names, exactly as
 * `buildHostedMcpPickerForm` does for the form path.
 */
function pickerConsentAcceptBody({
  model,
  clientId,
  chosen,
  accessMode = "continuous",
  reviewDigest,
}: {
  model: PickerConsentModel;
  clientId: string;
  chosen: Array<{ source: PickerConsentSource; streams: PickerConsentStream[] }>;
  accessMode?: string;
  reviewDigest?: string;
}): Record<string, unknown> {
  return {
    access_mode: accessMode,
    decision_digest: computeHostedMcpDecisionDigest({
      accessMode,
      clientId,
      sources: chosen.map(({ source, streams }) => ({
        sourceKey: source.id,
        streamNames: streams.map((stream) => stream.name).sort(),
      })),
    }),
    grant_expiry: model.grantExpiry.defaultId,
    review_digest: reviewDigest ?? model.reviewDigest,
    source_id: chosen.map(({ source }) => source.id),
    stream: chosen.flatMap(({ streams }) => streams.map((stream) => stream.id)),
  };
}

function postPickerConsentChallenge(
  asUrl: string,
  challenge: string,
  action: "accept" | "reject",
  body: Record<string, unknown>
): Promise<JsonResponse> {
  return fetchJson(`${asUrl}/oauth/authorize/consent-challenges/${challenge}/${action}`, {
    body: JSON.stringify(body),
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    method: "POST",
  });
}

/** Every stream of every source in the model — a whole-source approval of all. */
function everyPickerConsentSource(
  model: PickerConsentModel
): Array<{ source: PickerConsentSource; streams: PickerConsentStream[] }> {
  return model.sources.map((source) => ({ source, streams: source.streams }));
}

test("hosted MCP OAuth code flow issues a scoped client token usable at /mcp", async () => {
  const server = await startOpenTestServer();
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;

  try {
    const manifest = await registerAuthorizedSpotify(asUrl);
    const client = await registerAuthCodeClient(asUrl);
    const {
      accessToken,
      expiresIn,
      refreshToken: maybeRefreshToken,
      grantId: maybeGrantId,
      code,
    } = await completeOauthCodeFlow({
      asUrl,
      client,
      manifest,
    });
    const refreshToken = mustExist(maybeRefreshToken, "authorization code flow must issue a refresh token");
    const grantId = mustExist(maybeGrantId, "authorization code flow must issue a grant id");
    assert.equal(refreshToken.startsWith("rt_"), true);
    assert.ok(expiresIn !== null && expiresIn > 0 && expiresIn <= 600, "code access token reports its short lifetime");

    const reused = await fetchJson(`${asUrl}/oauth/token`, {
      body: new URLSearchParams({
        client_id: client.client_id,
        code,
        code_verifier: randomBytes(32).toString("base64url"),
        grant_type: "authorization_code",
        redirect_uri: "https://client.example/callback",
      }).toString(),
      headers: { Accept: "text/html", "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    assert.equal(reused.status, 400);
    assert.equal(reused.body.error, "invalid_grant");

    const refreshed = await fetchJson(`${asUrl}/oauth/token`, {
      body: new URLSearchParams({
        client_id: client.client_id,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }).toString(),
      headers: { Accept: "text/html", "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    assert.equal(refreshed.status, 200);
    assert.equal(refreshed.body.token_type, "Bearer");
    assert.equal(Number.isInteger(refreshed.body.expires_in), true);
    assert.ok((refreshed.body.expires_in as number) > 0);
    assert.ok((refreshed.body.expires_in as number) <= 600);
    assert.notEqual(refreshed.body.refresh_token, refreshToken);
    assert.equal(refreshed.body.grant_id, grantId);
    assert.ok(refreshed.body.access_token);
    assert.notEqual(refreshed.body.access_token, accessToken);
    const refreshedAccessToken = stringField(refreshed.body, "access_token");
    const rotatedRefreshToken = stringField(refreshed.body, "refresh_token");

    const wrongClient = await fetchJson(`${asUrl}/oauth/token`, {
      body: new URLSearchParams({
        client_id: "cli_wrong",
        grant_type: "refresh_token",
        refresh_token: rotatedRefreshToken,
      }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    assert.equal(wrongClient.status, 400);
    assert.equal(wrongClient.body.error, "invalid_grant");

    const initialize = await postMcpJson(rsUrl, accessToken, {
      id: 1,
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        capabilities: {},
        clientInfo: { name: "hosted-test", version: "0.0.0" },
        protocolVersion: "2025-06-18",
      },
    });
    assert.equal(initialize.status, 200, JSON.stringify(initialize.body));
    const initializeServerInfo = resultOf(initialize).serverInfo as Record<string, unknown>;
    assert.equal(initializeServerInfo.name, "pdpp-reference-mcp");
    assert.deepEqual(initializeServerInfo.icons, [
      { mimeType: "image/svg+xml", sizes: ["any"], src: `${rsUrl}/icon.svg` },
    ]);
    assert.equal(initialize.resp.headers.get("link"), `<${rsUrl}/icon.svg>; rel="icon"; type="image/svg+xml"`);

    const tools = await postMcpJson(rsUrl, accessToken, {
      id: 2,
      jsonrpc: "2.0",
      method: "tools/list",
      params: {},
    });
    assert.equal(tools.status, 200);
    const toolList = resultOf(tools).tools as Array<{ name: string }>;
    const toolNames = toolList.map((tool) => tool.name).sort((a, b) => a.localeCompare(b));
    assert.deepEqual(toolNames, ["aggregate", "fetch", "query_records", "read_record_field", "schema", "search"]);
    assert.equal(toolNames.includes("list_streams"), false);
    assert.equal(toolNames.includes("fetch_blob"), false);
    assert.equal(
      toolNames.some((name) => name.includes("event_subscription")),
      false
    );
    const refreshedTools = await postMcpJson(rsUrl, refreshedAccessToken, {
      id: 22,
      jsonrpc: "2.0",
      method: "tools/list",
      params: {},
    });
    assert.equal(refreshedTools.status, 200);

    const schema = await postMcpJson(rsUrl, accessToken, {
      id: 3,
      jsonrpc: "2.0",
      method: "tools/call",
      params: { arguments: {}, name: "schema" },
    });
    assert.equal(schema.status, 200);
    assert.equal(resultOf(schema).isError, undefined);

    const untrustedHost = await postMcpWithHostHeader({
      host: "attacker.example",
      message: {
        id: 4,
        jsonrpc: "2.0",
        method: "tools/list",
        params: {},
      },
      rsPort: server.rsPort,
      token: accessToken,
    });
    assert.equal(untrustedHost.status, 421);

    await revokeGrant(grantId, { request_id: "hosted-mcp-refresh-test" });
    const afterRevoke = await fetchJson(`${asUrl}/oauth/token`, {
      body: new URLSearchParams({
        client_id: client.client_id,
        grant_type: "refresh_token",
        refresh_token: rotatedRefreshToken,
      }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    assert.equal(afterRevoke.status, 400);
    assert.equal(afterRevoke.body.error, "invalid_grant");

    const replayFlow = await completeOauthCodeFlow({ asUrl, client, manifest });
    const replayedRefreshToken = mustExist(replayFlow.refreshToken, "replay flow must issue a refresh token");
    const firstRotation = await fetchJson(`${asUrl}/oauth/token`, {
      body: new URLSearchParams({
        client_id: client.client_id,
        grant_type: "refresh_token",
        refresh_token: replayedRefreshToken,
      }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    assert.equal(firstRotation.status, 200);
    const successorRefreshToken = stringField(firstRotation.body, "refresh_token");
    assert.notEqual(successorRefreshToken, replayedRefreshToken);

    const replayed = await fetchJson(`${asUrl}/oauth/token`, {
      body: new URLSearchParams({
        client_id: client.client_id,
        grant_type: "refresh_token",
        refresh_token: replayedRefreshToken,
      }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    assert.equal(replayed.status, 400);
    assert.equal(replayed.body.error, "invalid_grant");
    assert.equal(replayed.body.fresh_authorization_required, true);

    const replayFamilyId = (
      getDb()
        .prepare("SELECT family_id FROM oauth_refresh_tokens WHERE refresh_token_hash = ?")
        .get(createHash("sha256").update(replayedRefreshToken).digest("base64url")) as { family_id: string }
    ).family_id;
    const replayFamilyBearers = getDb()
      .prepare(
        `SELECT token_id, expires_at, revoked
           FROM tokens
          WHERE refresh_family_id = ?
          ORDER BY created_at, token_id`
      )
      .all(replayFamilyId) as Array<{ expires_at: string; revoked: number; token_id: string }>;
    assert.equal(replayFamilyBearers.length, 2, "the initial and attacker-minted bearer are linked to the family");
    for (const bearer of replayFamilyBearers) {
      assert.equal(bearer.revoked, 1, "replay revokes every family-linked bearer row");
      const lifetimeSeconds = (Date.parse(bearer.expires_at) - Date.now()) / 1000;
      assert.ok(lifetimeSeconds > 0 && lifetimeSeconds <= 600, "every family bearer has a short token-specific expiry");
      // biome-ignore lint/performance/noAwaitInLoops: The attacker-first oracle introspects every family bearer.
      assert.equal((await introspectAccessToken(asUrl, bearer.token_id)).active, false);
    }

    const successorAfterReplay = await fetchJson(`${asUrl}/oauth/token`, {
      body: new URLSearchParams({
        client_id: client.client_id,
        grant_type: "refresh_token",
        refresh_token: successorRefreshToken,
      }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    assert.equal(successorAfterReplay.status, 400);
    assert.equal(successorAfterReplay.body.error, "invalid_grant");

    const concurrentFlow = await completeOauthCodeFlow({ asUrl, client, manifest });
    const concurrentRefreshToken = mustExist(
      concurrentFlow.refreshToken,
      "SQLite concurrency flow must issue a refresh token"
    );
    const exchangeConcurrently = () =>
      fetchJson(`${asUrl}/oauth/token`, {
        body: new URLSearchParams({
          client_id: client.client_id,
          grant_type: "refresh_token",
          refresh_token: concurrentRefreshToken,
        }).toString(),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        method: "POST",
      });
    const concurrentResults = await Promise.all([exchangeConcurrently(), exchangeConcurrently()]);
    assert.deepEqual(concurrentResults.map(({ status }) => status).sort(), [200, 400]);
    const concurrentFailure = concurrentResults.find(({ status }) => status === 400);
    assert.equal(concurrentFailure?.body.error, "invalid_grant");
    assert.equal(concurrentFailure?.body.fresh_authorization_required, true);
    const familyRows = getDb()
      .prepare(
        `SELECT generation, status
           FROM oauth_refresh_tokens
          WHERE family_id = (
            SELECT family_id FROM oauth_refresh_tokens WHERE refresh_token_hash = ?
          )
          ORDER BY generation`
      )
      .all(createHash("sha256").update(concurrentRefreshToken).digest("base64url")) as Array<{
      generation: number;
      status: string;
    }>;
    assert.deepEqual(familyRows, [
      { generation: 0, status: "revoked" },
      { generation: 1, status: "revoked" },
    ]);
  } finally {
    await closeServer(server);
  }
});

test("OAuth token lifetime and refresh eligibility follow the persisted grant contract", async () => {
  const server = await startOpenTestServer();
  const asUrl = `http://localhost:${server.asPort}`;
  try {
    const manifest = await registerAuthorizedSpotify(asUrl);

    const noRefreshClient = await registerAuthCodeClient(asUrl, { refreshToken: false });
    const continuous = await completeOauthCodeFlow({ asUrl, client: noRefreshClient, manifest });
    assert.equal(continuous.refreshToken, null);
    assert.equal(continuous.expiresIn, null, "expires_in is omitted when the persisted access token has no expiry");
    const continuousIntrospection = await introspectAccessToken(asUrl, continuous.accessToken);
    assert.equal(continuousIntrospection.active, true);
    assert.equal(Object.hasOwn(continuousIntrospection, "exp"), false, "RFC 7662 exp is omitted when absent");

    const refreshCapableClient = await registerAuthCodeClient(asUrl);
    const singleUse = await completeOauthCodeFlow({
      accessMode: "single_use",
      asUrl,
      client: refreshCapableClient,
      manifest,
    });
    assert.equal(singleUse.refreshToken, null, "single_use grants never issue refresh tokens");
    assert.ok(singleUse.expiresIn !== null && singleUse.expiresIn > 0, "single_use reports its actual token expiry");
    assert.ok(singleUse.expiresIn <= 24 * 60 * 60);
    const singleUseIntrospection = await introspectAccessToken(asUrl, singleUse.accessToken);
    assert.equal(typeof singleUseIntrospection.exp, "number");
  } finally {
    await closeServer(server);
  }
});

test("SQLite authorization-code failure rolls back consumption with initial refresh issuance", async () => {
  const server = await startOpenTestServer();
  const asUrl = `http://localhost:${server.asPort}`;
  try {
    const manifest = await registerAuthorizedSpotify(asUrl);
    const client = await registerAuthCodeClient(asUrl);
    const prepared = await prepareOauthCodeFlow({ asUrl, client, manifest });
    getDb().exec(`
      CREATE TRIGGER fail_initial_refresh_issuance
      BEFORE INSERT ON oauth_refresh_tokens
      BEGIN
        SELECT RAISE(ABORT, 'injected initial refresh failure');
      END
    `);
    const redeem = () =>
      fetchJson(`${asUrl}/oauth/token`, {
        body: new URLSearchParams({
          client_id: client.client_id,
          code: prepared.code,
          code_verifier: prepared.verifier,
          grant_type: "authorization_code",
          redirect_uri: "https://client.example/callback",
        }).toString(),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        method: "POST",
      });

    const failed = await redeem();
    assert.notEqual(failed.status, 200);
    const afterFailure = getDb()
      .prepare("SELECT status, consumed_at FROM oauth_authorization_codes WHERE code = ?")
      .get(prepared.code) as { consumed_at: string | null; status: string };
    assert.deepEqual(afterFailure, { consumed_at: null, status: "issued" });
    assert.equal(
      (getDb().prepare("SELECT COUNT(*) AS count FROM oauth_refresh_tokens").get() as { count: number }).count,
      0
    );

    getDb().exec("DROP TRIGGER fail_initial_refresh_issuance");
    const retried = await redeem();
    assert.equal(retried.status, 200);
    assert.equal(typeof retried.body.refresh_token, "string");
  } finally {
    await closeServer(server);
  }
});

test("pre-family SQLite refresh rows are rejected without reconstruction", async () => {
  const tempDirectory = mkdtempSync(join(tmpdir(), "pdpp-refresh-legacy-"));
  const dbPath = join(tempDirectory, "legacy.sqlite");
  const legacy = new Database(dbPath);
  legacy.exec(`
    CREATE TABLE oauth_refresh_tokens (
      refresh_token_hash TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      grant_id TEXT,
      package_id TEXT,
      subject_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      expires_at TEXT,
      last_used_at TEXT,
      revoked_at TEXT
    )
  `);
  legacy.close();

  const server = await startServer({
    asPort: 0,
    dbPath,
    ownerAuthPassword: "",
    quiet: true,
    rsPort: 0,
    ...TEST_INTROSPECTION_SERVER_OPTS,
  });
  const asUrl = `http://localhost:${server.asPort}`;
  try {
    const client = await registerAuthCodeClient(asUrl);
    const legacyRefreshToken = `rt_${randomBytes(32).toString("base64url")}`;
    const legacyHash = createHash("sha256").update(legacyRefreshToken).digest("base64url");
    getDb()
      .prepare(
        `INSERT INTO oauth_refresh_tokens(
           refresh_token_hash, client_id, grant_id, subject_id, status, created_at
         ) VALUES(?, ?, ?, ?, 'active', ?)`
      )
      .run(legacyHash, client.client_id, "grt_legacy", "owner_local", new Date().toISOString());

    const response = await fetchJson(`${asUrl}/oauth/token`, {
      body: new URLSearchParams({
        client_id: client.client_id,
        grant_type: "refresh_token",
        refresh_token: legacyRefreshToken,
      }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error, "invalid_grant");
    const row = getDb()
      .prepare(
        `SELECT family_id, generation, parent_generation, status
           FROM oauth_refresh_tokens
          WHERE refresh_token_hash = ?`
      )
      .get(legacyHash) as Record<string, unknown>;
    assert.deepEqual(row, {
      family_id: null,
      generation: null,
      parent_generation: null,
      status: "active",
    });

    const failedIssuanceToken = `rt_${randomBytes(32).toString("base64url")}`;
    const failedIssuanceHash = createHash("sha256").update(failedIssuanceToken).digest("base64url");
    getDb()
      .prepare(
        `INSERT INTO oauth_refresh_tokens(
           refresh_token_hash, family_id, generation, parent_generation, client_id,
           grant_id, subject_id, status, created_at
         ) VALUES(?, ?, 0, NULL, ?, ?, ?, 'active', ?)`
      )
      .run(
        failedIssuanceHash,
        "rtf_failed_access_issuance",
        client.client_id,
        "grt_missing_for_fault_injection",
        "owner_local",
        new Date().toISOString()
      );
    const failedIssuance = await fetchJson(`${asUrl}/oauth/token`, {
      body: new URLSearchParams({
        client_id: client.client_id,
        grant_type: "refresh_token",
        refresh_token: failedIssuanceToken,
      }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    assert.notEqual(failedIssuance.status, 200);
    const failedFamilyRows = getDb()
      .prepare("SELECT status FROM oauth_refresh_tokens WHERE family_id = ?")
      .all("rtf_failed_access_issuance") as Array<{ status: string }>;
    assert.ok(failedFamilyRows.length >= 1);
    assert.equal(
      failedFamilyRows.every(({ status }) => status === "revoked"),
      true,
      "access-token issuance failure revokes every persisted refresh generation"
    );
  } finally {
    await closeServer(server);
    closeDb();
    rmSync(tempDirectory, { force: true, recursive: true });
  }
});

test("SQLite migration revokes unlinked legacy refresh families and their bound bearers", () => {
  const tempDirectory = mkdtempSync(join(tmpdir(), "pdpp-refresh-family-migration-"));
  const dbPath = join(tempDirectory, "legacy-family.sqlite");
  try {
    initDb(dbPath);
    getDb()
      .prepare(
        `INSERT INTO tokens(token_id, grant_id, subject_id, client_id, token_kind)
         VALUES('tok_legacy_family', 'grt_legacy_family', 'owner_local', 'client_legacy', 'client')`
      )
      .run();
    getDb()
      .prepare(
        `INSERT INTO oauth_refresh_tokens(
           refresh_token_hash, family_id, generation, client_id, grant_id,
           subject_id, status, created_at
         ) VALUES('hash_legacy_family', 'rtf_legacy_family', 0, 'client_legacy',
                  'grt_legacy_family', 'owner_local', 'active', ?)`
      )
      .run(new Date().toISOString());
    closeDb();

    initDb(dbPath);
    const refresh = getDb()
      .prepare("SELECT status, revoked_at FROM oauth_refresh_tokens WHERE family_id = 'rtf_legacy_family'")
      .get() as { revoked_at: string | null; status: string };
    const bearer = getDb()
      .prepare("SELECT refresh_family_id, revoked FROM tokens WHERE token_id = 'tok_legacy_family'")
      .get() as { refresh_family_id: string | null; revoked: number };
    assert.equal(refresh.status, "revoked", "unlinked pre-migration family requires fresh authorization");
    assert.ok(refresh.revoked_at);
    assert.deepEqual(bearer, { refresh_family_id: null, revoked: 1 });
  } finally {
    closeDb();
    rmSync(tempDirectory, { force: true, recursive: true });
  }
});

test("SQLite refresh failure rolls back rotation and bearer issuance together", async () => {
  const tempDirectory = mkdtempSync(join(tmpdir(), "pdpp-refresh-fail-closed-"));
  const dbPath = join(tempDirectory, "refresh.sqlite");
  const server = await startServer({
    asPort: 0,
    dbPath,
    ownerAuthPassword: "",
    quiet: true,
    rsPort: 0,
    ...TEST_INTROSPECTION_SERVER_OPTS,
  });
  const asUrl = `http://localhost:${server.asPort}`;
  try {
    const manifest = await registerSpotify(asUrl);
    await seedDefaultHostedInstance(manifest);
    const client = await registerAuthCodeClient(asUrl);
    const issued = await completeOauthCodeFlow({ asUrl, client, manifest });
    const refreshToken = mustExist(issued.refreshToken, "fault flow must issue a refresh token");
    const grantId = mustExist(issued.grantId, "fault flow must issue a grant id");
    const activeBefore = getDb()
      .prepare("SELECT COUNT(*) AS count FROM tokens WHERE grant_id = ? AND revoked = 0")
      .get(grantId) as { count: number };

    getDb().exec(`
      CREATE TRIGGER fail_refresh_token_issued_event
      BEFORE INSERT ON spine_events
      WHEN NEW.event_type = 'token.issued'
       AND json_extract(NEW.data_json, '$.issuance_path') = 'oauth_refresh_token'
      BEGIN
        SELECT RAISE(ABORT, 'injected refresh token event failure');
      END
    `);

    const failed = await fetchJson(`${asUrl}/oauth/token`, {
      body: new URLSearchParams({
        client_id: client.client_id,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    assert.equal(failed.status, 400);

    const family = getDb()
      .prepare(
        `SELECT generation, status
           FROM oauth_refresh_tokens
          WHERE family_id = (
            SELECT family_id FROM oauth_refresh_tokens WHERE refresh_token_hash = ?
          )
          ORDER BY generation`
      )
      .all(createHash("sha256").update(refreshToken).digest("base64url")) as Array<{
      generation: number;
      status: string;
    }>;
    assert.deepEqual(family, [{ generation: 0, status: "active" }]);
    const activeAfter = getDb()
      .prepare("SELECT COUNT(*) AS count FROM tokens WHERE grant_id = ? AND revoked = 0")
      .get(grantId) as { count: number };
    assert.equal(activeAfter.count, activeBefore.count, "failed refresh does not add an active bearer");
  } finally {
    await closeServer(server);
    closeDb();
    rmSync(tempDirectory, { force: true, recursive: true });
  }
});

test("SQLite refresh replay containment rolls back the family and bearers together on failure", async () => {
  const tempDirectory = mkdtempSync(join(tmpdir(), "pdpp-refresh-replay-fail-closed-"));
  const server = await startServer({
    asPort: 0,
    dbPath: join(tempDirectory, "refresh.sqlite"),
    ownerAuthPassword: "",
    quiet: true,
    rsPort: 0,
    ...TEST_INTROSPECTION_SERVER_OPTS,
  });
  const asUrl = `http://localhost:${server.asPort}`;
  try {
    const manifest = await registerSpotify(asUrl);
    await seedDefaultHostedInstance(manifest);
    const client = await registerAuthCodeClient(asUrl);
    const issued = await completeOauthCodeFlow({ asUrl, client, manifest });
    const generationZero = mustExist(issued.refreshToken, "replay-fault flow must issue generation zero");
    const rotated = await fetchJson(`${asUrl}/oauth/token`, {
      body: new URLSearchParams({
        client_id: client.client_id,
        grant_type: "refresh_token",
        refresh_token: generationZero,
      }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    assert.equal(rotated.status, 200);
    const generationOne = stringField(rotated.body, "refresh_token");

    getDb().exec(`
      CREATE TRIGGER fail_family_bearer_revoke
      BEFORE UPDATE OF revoked ON tokens
      WHEN OLD.revoked = 0 AND NEW.revoked = 1 AND NEW.refresh_family_id IS NOT NULL
      BEGIN
        SELECT RAISE(ABORT, 'injected family bearer revoke failure');
      END
    `);
    try {
      const failedReplay = await fetch(`${asUrl}/oauth/token`, {
        body: new URLSearchParams({
          client_id: client.client_id,
          grant_type: "refresh_token",
          refresh_token: generationZero,
        }).toString(),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        method: "POST",
      });
      assert.notEqual(failedReplay.status, 200, "failed bearer revoke cannot commit partial containment");
    } finally {
      getDb().exec("DROP TRIGGER IF EXISTS fail_family_bearer_revoke");
    }

    const refreshHash = createHash("sha256").update(generationZero).digest("base64url");
    const family = getDb()
      .prepare(
        `SELECT generation, status
           FROM oauth_refresh_tokens
          WHERE family_id = (
            SELECT family_id FROM oauth_refresh_tokens WHERE refresh_token_hash = ?
          )
          ORDER BY generation`
      )
      .all(refreshHash) as Array<{ generation: number; status: string }>;
    assert.deepEqual(family, [
      { generation: 0, status: "superseded" },
      { generation: 1, status: "active" },
    ]);
    const bearers = getDb()
      .prepare(
        `SELECT revoked
           FROM tokens
          WHERE refresh_family_id = (
            SELECT family_id FROM oauth_refresh_tokens WHERE refresh_token_hash = ?
          )
          ORDER BY created_at, token_id`
      )
      .all(refreshHash) as Array<{ revoked: number }>;
    assert.deepEqual(
      bearers.map(({ revoked }) => revoked),
      [0, 0],
      "failed containment rolls bearer revocation back atomically"
    );

    const successor = await fetchJson(`${asUrl}/oauth/token`, {
      body: new URLSearchParams({
        client_id: client.client_id,
        grant_type: "refresh_token",
        refresh_token: generationOne,
      }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    assert.equal(successor.status, 200, "rolled-back successor remains usable");
  } finally {
    await closeServer(server);
    closeDb();
    rmSync(tempDirectory, { force: true, recursive: true });
  }
});

test("SQLite supersede failure rolls back the newly inserted family bearer", async () => {
  const tempDirectory = mkdtempSync(join(tmpdir(), "pdpp-refresh-supersede-fail-"));
  const server = await startServer({
    asPort: 0,
    dbPath: join(tempDirectory, "refresh.sqlite"),
    ownerAuthPassword: "",
    quiet: true,
    rsPort: 0,
    ...TEST_INTROSPECTION_SERVER_OPTS,
  });
  const asUrl = `http://localhost:${server.asPort}`;
  try {
    const manifest = await registerSpotify(asUrl);
    await seedDefaultHostedInstance(manifest);
    const client = await registerAuthCodeClient(asUrl);
    const issued = await completeOauthCodeFlow({ asUrl, client, manifest });
    const generationZero = mustExist(issued.refreshToken, "supersede-fault flow must issue generation zero");
    const refreshHash = createHash("sha256").update(generationZero).digest("base64url");

    getDb().exec(`
      CREATE TRIGGER fail_refresh_supersede
      BEFORE UPDATE OF status ON oauth_refresh_tokens
      WHEN OLD.status = 'active' AND NEW.status = 'superseded'
      BEGIN
        SELECT RAISE(ABORT, 'injected refresh supersede failure');
      END
    `);
    try {
      const failure = await fetch(`${asUrl}/oauth/token`, {
        body: new URLSearchParams({
          client_id: client.client_id,
          grant_type: "refresh_token",
          refresh_token: generationZero,
        }).toString(),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        method: "POST",
      });
      assert.notEqual(failure.status, 200);
    } finally {
      getDb().exec("DROP TRIGGER IF EXISTS fail_refresh_supersede");
    }

    const family = getDb()
      .prepare(
        `SELECT generation, status
           FROM oauth_refresh_tokens
          WHERE family_id = (
            SELECT family_id FROM oauth_refresh_tokens WHERE refresh_token_hash = ?
          )
          ORDER BY generation`
      )
      .all(refreshHash) as Array<{ generation: number; status: string }>;
    assert.deepEqual(family, [{ generation: 0, status: "active" }]);
    const bearers = getDb()
      .prepare(
        `SELECT revoked
           FROM tokens
          WHERE refresh_family_id = (
            SELECT family_id FROM oauth_refresh_tokens WHERE refresh_token_hash = ?
          )`
      )
      .all(refreshHash) as Array<{ revoked: number }>;
    assert.deepEqual(bearers, [{ revoked: 0 }], "failed supersede leaves no orphan refresh-derived bearer");

    const retried = await fetchJson(`${asUrl}/oauth/token`, {
      body: new URLSearchParams({
        client_id: client.client_id,
        grant_type: "refresh_token",
        refresh_token: generationZero,
      }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    assert.equal(retried.status, 200, "generation zero remains usable after rollback");
  } finally {
    await closeServer(server);
    closeDb();
    rmSync(tempDirectory, { force: true, recursive: true });
  }
});

// Regression: the legacy `connection:<connector_id>:<connection_id>` form
// shape collapsed when `connector_id` was URL-shaped because the AS split on
// the first `:` and tried to resolve `https` as a connector. The picker now
// emits opaque base64url(JSON) selection values, and the AS MUST refuse the
// legacy delimited shape with a clean typed error instead of leaking
// "Unknown connector: https" or guessing through a parser fallback.
test('POST /oauth/authorize/mcp-package rejects legacy delimited selection without leaking "https"', async () => {
  const server = await startOpenTestServer();
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    await registerSpotify(asUrl);
    // Hard-coded URL-shaped first-party connector id. The legacy delimited
    // shape under test (`connection:<url>:<connection_id>`) is the exact
    // pre-canonicalization bug surface: an owner-supplied URL embedded
    // inside a colon-delimited payload. The post-canonicalize-connector-keys
    // AS no longer stores manifests under URL keys, but the parser still
    // needs to reject this shape without leaking "https" or collapsing the
    // URL into the "Unknown connector" error branch.
    const legacyUrlShapedConnectorId = "https://registry.pdpp.dev/connectors/spotify";
    const client = await registerAuthCodeClient(asUrl);

    const verifier = randomBytes(32).toString("base64url");
    const challenge = pkceChallenge(verifier);

    const params = new URLSearchParams();
    params.append("client_id", client.client_id);
    params.append("redirect_uri", "https://client.example/callback");
    params.append("response_type", "code");
    params.append("state", "legacy-shape");
    params.append("code_challenge", challenge);
    params.append("code_challenge_method", "S256");
    // Exactly the bug-triggering shape: `connection:<url>:<connection_id>`.
    params.append("selection", `connection:${legacyUrlShapedConnectorId}:conn_owner_local`);

    const resp = await fetch(`${asUrl}/oauth/authorize/mcp-package`, {
      body: params.toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
      redirect: "manual",
    });
    const body = (await resp.json()) as Record<string, unknown>;

    assert.equal(resp.status, 400);
    assert.equal(body.error, "invalid_request");
    assert.ok(typeof body.error_description === "string", "response carries an error_description");
    const errorDescription = stringField(body, "error_description");
    assert.equal(
      errorDescription.toLowerCase().includes("https"),
      false,
      `error_description MUST NOT mention "https"; got: ${errorDescription}`
    );
    assert.equal(
      errorDescription.toLowerCase().includes("unknown connector"),
      false,
      'parser MUST NOT collapse the URL and reach the "Unknown connector" branch'
    );
  } finally {
    await closeServer(server);
  }
});

// DELETED: "hosted MCP source selection uses hosted-ui option styles".
//
// The whole test was styling of a server-rendered page that the picker branch
// no longer produces: `hosted-ui-option-group`, `hosted-ui-option`, the
// collapsed `<details class="hosted-ui-option-source">` sections, the
// select/clear-sources buttons, and the primary-button variant are all CSS
// classes on markup the console now owns. Nothing it asserted is orphaned:
//   - the `/__pdpp/hosted-ui.css` asset is still served and still tested, by
//     `hosted-ui.test.ts` ("shared stylesheet is served under
//     /__pdpp/hosted-ui.css");
//   - the "no URL-shaped connector id in owner-visible copy" regression is
//     held by "picker hides URL-shaped default connection labels from
//     owner-visible copy" below, rewritten against the model;
//   - the requester-named title is held by "hosted MCP picker names the
//     requester ...", also rewritten against the model.
// GAP: the picker's own CSS class names and the "You can revoke this access
// later from your grants page" copy are no longer asserted anywhere on the
// server side — both are now the console's rendering, outside this suite.

test("grant-scoped MCP device authorization requires resource and authorization_details", async () => {
  const server = await startOpenTestServer();
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;

  try {
    const manifest = await registerSpotify(asUrl);
    const client = await registerAuthCodeClient(asUrl);

    const missingDetails = await fetchJson(`${asUrl}/oauth/device_authorization`, {
      body: new URLSearchParams({
        client_id: client.client_id,
        resource: `${rsUrl}/mcp`,
      }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    assert.equal(missingDetails.status, 400);
    assert.equal(missingDetails.body.error, "invalid_request");
    assert.match(stringField(missingDetails.body, "error_description"), /authorization_details is required/);

    const missingResource = await fetchJson(`${asUrl}/oauth/device_authorization`, {
      body: new URLSearchParams({
        authorization_details: JSON.stringify(hostedMcpAuthorizationDetails(manifest)),
        client_id: client.client_id,
      }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    assert.equal(missingResource.status, 400);
    assert.equal(missingResource.body.error, "invalid_request");
    assert.match(stringField(missingResource.body, "error_description"), /resource is required/);
  } finally {
    await closeServer(server);
  }
});

test("grant-scoped MCP device authorization issues a client token usable at /mcp", async () => {
  const server = await startOpenTestServer();
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;

  try {
    const manifest = await registerAuthorizedSpotify(asUrl);
    const client = await registerAuthCodeClient(asUrl);

    const device = await startMcpDeviceAuthorization({ asUrl, client, manifest, rsUrl });
    assert.equal(device.status, 200);
    const deviceCode = stringField(device.body, "device_code");
    assert.equal(deviceCode.startsWith("dc_"), true);
    assert.equal(deviceCode.startsWith("dc_owner_"), false);
    assert.ok(device.body.user_code);
    assert.equal(device.body.verification_uri, `${asUrl}/consent`);
    assert.match(
      stringField(device.body, "verification_uri_complete"),
      /^http:\/\/localhost:\d+\/consent\?request_uri=/
    );
    assert.equal(device.body.interval, 2);

    const pending = await fetchJson(`${asUrl}/oauth/token`, {
      body: new URLSearchParams({
        client_id: client.client_id,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    assert.equal(pending.status, 400);
    assert.equal(pending.body.error, "authorization_pending");

    const tooFast = await fetchJson(`${asUrl}/oauth/token`, {
      body: new URLSearchParams({
        client_id: client.client_id,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    assert.equal(tooFast.status, 400);
    assert.equal(tooFast.body.error, "slow_down");

    const reviewRevision = await reviewConsent(asUrl, buildPendingConsentRequestUri(deviceCode));
    const approveResp = await fetch(`${asUrl}/consent/approve`, {
      body: new URLSearchParams({
        approval_review_revision: reviewRevision,
        request_uri: buildPendingConsentRequestUri(deviceCode),
      }).toString(),
      headers: { Accept: "text/html", "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
      redirect: "manual",
    });
    assert.equal(approveResp.status, 200);

    const token = await fetchJson(`${asUrl}/oauth/token`, {
      body: new URLSearchParams({
        client_id: client.client_id,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    assert.equal(token.status, 200);
    assert.equal(token.body.token_type, "Bearer");
    assert.ok(token.body.access_token);
    assert.ok(token.body.grant_id);
    assert.equal(token.body.grant_package_id, undefined);
    assert.equal(token.body.expires_in, undefined, "device token response omits an expiry absent from storage");
    const tokenAccessToken = stringField(token.body, "access_token");

    const introspected = await fetchJson(`${asUrl}/introspect`, {
      body: new URLSearchParams({ token: tokenAccessToken }).toString(),
      headers: {
        Authorization: INTROSPECTION_AUTHORIZATION,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      method: "POST",
    });
    assert.equal(introspected.status, 200);
    assert.equal(introspected.body.active, true);
    assert.equal(introspected.body.pdpp_token_kind, "client");
    assert.equal(introspected.body.client_id, client.client_id);
    assert.equal(introspected.body.grant_id, token.body.grant_id);
    assert.equal(Object.hasOwn(introspected.body, "exp"), false, "introspection omits an absent expiry");

    const tools = await postMcpJson(rsUrl, tokenAccessToken, {
      id: 2,
      jsonrpc: "2.0",
      method: "tools/list",
      params: {},
    });
    assert.equal(tools.status, 200);
    const toolList = resultOf(tools).tools as Array<{ name: string }>;
    assert.deepEqual(
      toolList.map((tool) => tool.name).sort((a, b) => a.localeCompare(b)),
      ["aggregate", "fetch", "query_records", "read_record_field", "schema", "search"]
    );
  } finally {
    await closeServer(server);
  }
});

test("/mcp rejects missing and owner bearers", async () => {
  const server = await startOpenTestServer();
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;

  try {
    const missing = await fetchJson(`${rsUrl}/mcp`, { method: "POST" });
    assert.equal(missing.status, 401);
    assert.equal(missing.resp.headers.get("link"), `<${rsUrl}/icon.svg>; rel="icon"; type="image/svg+xml"`);
    assert.equal(errorOf(missing).resource_metadata, `${rsUrl}/.well-known/oauth-protected-resource/mcp`);

    const mcpMetadata = await fetchProtectedResourceMetadata(stringField(errorOf(missing), "resource_metadata"));
    assert.equal(mcpMetadata.resource, `${rsUrl}/mcp`);
    assert.deepEqual(mcpMetadata.pdpp_token_kinds_supported, ["client", "mcp_package"]);
    const agentDiscovery = mcpMetadata.pdpp_agent_discovery as {
      mcp: { endpoint: string; authorization: Record<string, unknown> };
    };
    assert.equal(agentDiscovery.mcp.endpoint, `${rsUrl}/mcp`);
    assert.deepEqual(agentDiscovery.mcp.authorization.device_code, {
      authorization_details_type: "https://pdpp.dev/data-access",
      device_authorization_endpoint: `${asUrl}/oauth/device_authorization`,
      flow: "device_code",
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      owner_bearer_accepted: false,
      pdpp_token_kind: "client",
      required_parameters: ["client_id", "resource", "authorization_details"],
      resource: `${rsUrl}/mcp`,
      token_endpoint: `${asUrl}/oauth/token`,
    });
    assert.deepEqual(agentDiscovery.mcp.authorization.owner_agent_device_code, {
      advertised_in: "pdpp_owner_agent_onboarding",
      flow: "device_code",
      mcp_owner_bearer_rejected: true,
      normal_mcp_setup: false,
      pdpp_token_kind: "owner",
    });
    assert.equal(
      Object.hasOwn(mcpMetadata, "logo_uri"),
      false,
      "OAuth protected-resource metadata must not grow a non-standard logo_uri field"
    );

    const ownerToken = await issueOwnerToken(asUrl);
    const owner = await postMcpJson(rsUrl, ownerToken, {
      id: 1,
      jsonrpc: "2.0",
      method: "tools/list",
      params: {},
    });
    assert.equal(owner.status, 403);
    assert.equal(errorOf(owner).code, "permission_error");
    assert.match(stringField(errorOf(owner), "message"), /grant-scoped client or MCP package token/);
    assert.match(stringField(errorOf(owner), "message"), /owner-agent REST onboarding/);
  } finally {
    await closeServer(server);
  }
});

// Reproduces a real GDC-demo discrepancy: the Core Docker image used to bake
// PDPP_REFERENCE_ORIGIN=http://localhost:3000 (Dockerfile core-browser
// stage), and deploy/docker/docker-compose.yml repeated the same stale
// default. An operator who only overrides the published port
// (PDPP_WEB_PORT) — not PDPP_REFERENCE_ORIGIN too — ended up with a
// composed-mode `explicitResource` fixed at boot to the wrong port, because
// `resolveReferenceTopology`'s placeholder browser-origin fallback
// (DEFAULT_REFERENCE_BROWSER_ORIGIN, itself a fixed :3002/:3000-shaped
// value) leaked into the AS/RS's own protocol-critical `rsPublicUrl`/
// `asPublicUrl`, not just the advisory owner-agent-onboarding hint it was
// meant for. Fixed by no longer baking a default origin into the deploy
// artifacts, and by making `resolveReferenceTopology` only let an
// EXPLICITLY configured origin feed `rsPublicUrl`/`asPublicUrl` — an unset
// origin now correctly falls through to `resolvePublicUrl`'s per-request
// Host-header derivation. This test simulates that "operator never
// configured an origin, composed mode, live port differs from any
// placeholder default" shape directly (no explicit `rsPublicUrl`/
// `referenceOrigin`, `PDPP_REFERENCE_MODE=composed`), and proves a direct,
// unproxied client (a raw MCP client, no `x-forwarded-host`) gets the live
// port back on every unauthenticated/failed-auth 401 challenge — not just
// after some warm-up request.
test("/mcp 401 challenge uses the live request port when no origin is configured (composed mode)", async () => {
  const server = await startServer({
    asPort: 0,
    dbPath: ":memory:",
    ignoreAmbientPublicUrls: false,
    ownerAuthPassword: "",
    quiet: true,
    referenceMode: "composed",
    rsPort: 0,
    ...TEST_INTROSPECTION_SERVER_OPTS,
  });

  try {
    assert.notEqual(server.rsPort, 3000, "test is only meaningful when the live port differs from any placeholder");
    assert.notEqual(server.rsPort, 3002, "test is only meaningful when the live port differs from any placeholder");

    const first = await postMcpWithHostHeader({
      host: `localhost:${server.rsPort}`,
      message: { id: 1, jsonrpc: "2.0", method: "tools/list", params: {} },
      rsPort: server.rsPort,
      token: "not-a-real-token",
    });
    const second = await postMcpWithHostHeader({
      host: `localhost:${server.rsPort}`,
      message: { id: 2, jsonrpc: "2.0", method: "tools/list", params: {} },
      rsPort: server.rsPort,
      token: "not-a-real-token",
    });

    assert.equal(first.status, 401);
    assert.equal(second.status, 401);
    const firstError = errorOf({ body: JSON.parse(first.body), resp: new Response(), status: first.status ?? 0 });
    const secondError = errorOf({ body: JSON.parse(second.body), resp: new Response(), status: second.status ?? 0 });
    assert.equal(
      firstError.resource_metadata,
      `http://localhost:${server.rsPort}/.well-known/oauth-protected-resource/mcp`,
      "the very first 401 challenge must point at this instance's real port, not a placeholder default"
    );
    assert.equal(
      secondError.resource_metadata,
      `http://localhost:${server.rsPort}/.well-known/oauth-protected-resource/mcp`,
      "later challenges must keep pointing at the real port"
    );
  } finally {
    await closeServer(server);
  }
});

test("dynamic registration accepts only public authorization-code, refresh-token, and device-code metadata", async () => {
  const server = await startOpenTestServer();
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    await registerAuthCodeClient(asUrl);
    const noRefresh = await registerAuthCodeClient(asUrl, { refreshToken: false });
    assert.deepEqual(noRefresh.grant_types, ["authorization_code"]);

    const deviceOnly = await fetchJson(`${asUrl}/oauth/register`, {
      body: JSON.stringify({
        client_name: "Device-code client",
        grant_types: ["urn:ietf:params:oauth:grant-type:device_code"],
        token_endpoint_auth_method: "none",
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(deviceOnly.status, 201);
    assert.deepEqual(deviceOnly.body.grant_types, ["urn:ietf:params:oauth:grant-type:device_code"]);
    assert.equal(Object.hasOwn(deviceOnly.body, "redirect_uris"), false);
    assert.equal(Object.hasOwn(deviceOnly.body, "response_types"), false);

    const refreshWithoutCode = await fetchJson(`${asUrl}/oauth/register`, {
      body: JSON.stringify({
        client_name: "Refresh-only client",
        grant_types: ["refresh_token"],
        redirect_uris: ["https://client.example/callback"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(refreshWithoutCode.status, 400);
    assert.match(stringField(refreshWithoutCode.body, "error_description"), /requires authorization_code/);

    const implicit = await fetchJson(`${asUrl}/oauth/register`, {
      body: JSON.stringify({
        client_name: "Bad client",
        redirect_uris: ["https://client.example/callback"],
        response_types: ["token"],
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(implicit.status, 400);
    assert.match(stringField(implicit.body, "error_description"), /Unsupported response_types/);

    const confidential = await fetchJson(`${asUrl}/oauth/register`, {
      body: JSON.stringify({
        client_name: "Confidential client",
        grant_types: ["authorization_code"],
        redirect_uris: ["https://client.example/callback"],
        response_types: ["code"],
        token_endpoint_auth_method: "client_secret_basic",
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(confidential.status, 400);
    assert.match(stringField(confidential.body, "error_description"), /Unsupported token_endpoint_auth_method/);

    const unsafeScheme = await fetchJson(`${asUrl}/oauth/register`, {
      body: JSON.stringify({
        client_name: "Unsafe redirect client",
        grant_types: ["authorization_code"],
        redirect_uris: ["javascript:alert(1)"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(unsafeScheme.status, 400);
    assert.match(stringField(unsafeScheme.body, "error_description"), /redirect_uris must use https/);

    const insecureWeb = await fetchJson(`${asUrl}/oauth/register`, {
      body: JSON.stringify({
        application_type: "web",
        client_name: "Insecure web redirect client",
        grant_types: ["authorization_code"],
        redirect_uris: ["http://client.example/callback"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(insecureWeb.status, 400);
    assert.match(stringField(insecureWeb.body, "error_description"), /https for web clients/);

    const explicitWebLoopback = await fetchJson(`${asUrl}/oauth/register`, {
      body: JSON.stringify({
        application_type: "web",
        client_name: "Explicit web loopback redirect client",
        grant_types: ["authorization_code"],
        redirect_uris: ["http://127.0.0.1:43210/callback"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(explicitWebLoopback.status, 400);
    assert.match(stringField(explicitWebLoopback.body, "error_description"), /https for web clients/);

    const nativeLoopback = await fetchJson(`${asUrl}/oauth/register`, {
      body: JSON.stringify({
        application_type: "native",
        client_name: "Native loopback redirect client",
        grant_types: ["authorization_code"],
        redirect_uris: ["http://127.0.0.1:43210/callback"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(nativeLoopback.status, 201);
    assert.equal(nativeLoopback.body.application_type, "native");

    const inferredIpv4NativeLoopback = await fetchJson(`${asUrl}/oauth/register`, {
      body: JSON.stringify({
        client_name: "Inferred IPv4 native loopback redirect client",
        grant_types: ["authorization_code"],
        redirect_uris: ["http://127.0.0.1:43211/callback"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(inferredIpv4NativeLoopback.status, 201);
    assert.equal(inferredIpv4NativeLoopback.body.application_type, "native");

    const inferredLocalhostNativeLoopback = await fetchJson(`${asUrl}/oauth/register`, {
      body: JSON.stringify({
        client_name: "Inferred localhost native loopback redirect client",
        grant_types: ["authorization_code"],
        redirect_uris: ["http://localhost:43212/callback"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(inferredLocalhostNativeLoopback.status, 201);
    assert.equal(inferredLocalhostNativeLoopback.body.application_type, "native");

    const inferredIpv6NativeLoopback = await fetchJson(`${asUrl}/oauth/register`, {
      body: JSON.stringify({
        client_name: "Inferred IPv6 native loopback redirect client",
        grant_types: ["authorization_code"],
        redirect_uris: ["http://[::1]:43213/callback"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(inferredIpv6NativeLoopback.status, 201);
    assert.equal(inferredIpv6NativeLoopback.body.application_type, "native");
  } finally {
    await closeServer(server);
  }
});

test("CIMD native loopback redirect matching ignores only runtime port", async () => {
  const publicOrigin = "https://pdpp.example.test";
  const server = await startServer({
    asPort: 0,
    asPublicUrl: publicOrigin,
    dbPath: ":memory:",
    ownerAuthPassword: "",
    quiet: true,
    rsPort: 0,
  });
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    const spotify = await registerAuthorizedSpotify(asUrl);
    const client = await createCimdClientDocument(asUrl, {
      client_name: "Claude Code",
      redirect_uris: ["http://localhost/callback", "http://127.0.0.1/callback"],
      token_endpoint_auth_method: "none",
    });
    const clientId = stringField(client, "client_id");

    const verifier = randomBytes(32).toString("base64url");
    const challenge = pkceChallenge(verifier);
    const state = "native-loopback-state";
    const runtimeRedirectUri = "http://localhost:3118/callback";

    const mismatchUrl = new URL(`${asUrl}/oauth/authorize`);
    mismatchUrl.searchParams.set("client_id", clientId);
    mismatchUrl.searchParams.set("redirect_uri", "http://localhost:3118/not-callback");
    mismatchUrl.searchParams.set("response_type", "code");
    mismatchUrl.searchParams.set("state", state);
    mismatchUrl.searchParams.set("code_challenge", challenge);
    mismatchUrl.searchParams.set("code_challenge_method", "S256");
    const mismatch = await fetchJson(mismatchUrl);
    assert.equal(mismatch.status, 400);
    assert.equal(mismatch.body.error, "invalid_request");
    assert.match(stringField(mismatch.body, "error_description"), /redirect_uri does not match/);

    const authorizeUrl = new URL(`${asUrl}/oauth/authorize`);
    authorizeUrl.searchParams.set("client_id", clientId);
    authorizeUrl.searchParams.set("redirect_uri", runtimeRedirectUri);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("state", state);
    authorizeUrl.searchParams.set("code_challenge", challenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    authorizeUrl.searchParams.set("authorization_details", JSON.stringify(hostedMcpAuthorizationDetails(spotify)));

    const authorizeResp = await fetch(authorizeUrl, { redirect: "manual" });
    assert.equal(authorizeResp.status, 302);
    const consentUrl = new URL(
      mustExist(authorizeResp.headers.get("location"), "redirect must carry a Location header"),
      publicOrigin
    );
    const requestUri = consentUrl.searchParams.get("request_uri");
    assert.ok(requestUri);
    const reviewRevision = await reviewConsent(asUrl, requestUri);

    const approveResp = await fetch(`${asUrl}/consent/approve`, {
      body: new URLSearchParams({
        approval_review_revision: reviewRevision,
        request_uri: requestUri,
      }).toString(),
      headers: { Accept: "text/html", "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
      redirect: "manual",
    });
    assert.equal(approveResp.status, 302);
    const callback = new URL(mustExist(approveResp.headers.get("location"), "redirect must carry a Location header"));
    assert.equal(callback.origin, "http://localhost:3118");
    assert.equal(callback.pathname, "/callback");
    assert.equal(callback.searchParams.get("state"), state);
    const code = mustExist(callback.searchParams.get("code"), "redirect must carry an authorization code");
    assert.ok(code);

    const wrongRedirect = await fetchJson(`${asUrl}/oauth/token`, {
      body: new URLSearchParams({
        client_id: clientId,
        code,
        code_verifier: verifier,
        grant_type: "authorization_code",
        redirect_uri: "http://localhost/callback",
      }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    assert.equal(wrongRedirect.status, 400);
    assert.equal(wrongRedirect.body.error, "invalid_grant");
    assert.match(stringField(wrongRedirect.body, "error_description"), /redirect_uri mismatch/);

    const token = await fetchJson(`${asUrl}/oauth/token`, {
      body: new URLSearchParams({
        client_id: clientId,
        code,
        code_verifier: verifier,
        grant_type: "authorization_code",
        redirect_uri: runtimeRedirectUri,
      }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    assert.equal(token.status, 200);
    assert.equal(token.body.token_type, "Bearer");
    assert.ok(token.body.access_token);
    assert.ok(token.body.grant_id);
  } finally {
    await closeServer(server);
  }
});

// End-to-end coverage for the hosted-MCP grant-package construction
// (OpenSpec change `add-hosted-mcp-grant-packages`, tasks 5.1 / 5.5 / 5.6).
// These prove that the AS→package-token→`/mcp`→PackageRsClient chain holds
// under multi-source approval, child-grant revocation, and full package
// revocation. The unit suite in `package-rs-client.test.js` covers the
// adapter routing in isolation; this suite proves the live wiring.

test("multi-source hosted MCP picker issues a package token usable at /mcp with source-tagged reads", async () => {
  const server = await startOpenTestServer();
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;

  try {
    const spotify = await registerAuthorizedSpotify(asUrl);
    const github = await registerAuthorizedGithub(asUrl);
    const client = await registerAuthCodeClient(asUrl);

    const { accessToken, refreshToken, packageId } = await completeMultiSourcePackageFlow({
      asUrl,
      client,
      connectorIds: [spotify.connector_id, github.connector_id],
    });
    assert.ok(refreshToken, "multi-source package issues a refresh token");
    assert.equal(refreshToken.startsWith("rt_"), true);

    const initialize = await postMcpJson(rsUrl, accessToken, {
      id: 1,
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        capabilities: {},
        clientInfo: { name: "hosted-multi-source-test", version: "0.0.0" },
        protocolVersion: "2025-06-18",
      },
    });
    assert.equal(initialize.status, 200);
    assert.equal((resultOf(initialize).serverInfo as Record<string, unknown>).name, "pdpp-reference-mcp");

    // schema fan-out: streams from both children should appear, each
    // tagged with the source's connector_id and grant_id.
    const schemaCall = await postMcpJson(rsUrl, accessToken, {
      id: 2,
      jsonrpc: "2.0",
      method: "tools/call",
      params: { arguments: {}, name: "schema" },
    });
    assert.equal(schemaCall.status, 200);
    assert.equal(resultOf(schemaCall).isError, undefined);
    const schemaData = structuredContentData(resultOf(schemaCall));
    const schemaPackage = mustExist(schemaPackageMetadata(schemaData), "schema response carries package metadata");
    assert.ok(schemaPackage.grant_package, "schema response carries package metadata");
    assert.equal(schemaPackage.member_count, 2);
    const schemaConnectors = (schemaData.connectors as Record<string, unknown>[] | undefined) || [];
    const schemaStreams = schemaConnectors.flatMap((connector) =>
      ((connector.streams as Record<string, unknown>[] | undefined) || []).map((stream) => ({
        ...stream,
        source: stream.source || connector.source,
      }))
    );
    const schemaConnectorIds = new Set(
      schemaStreams
        .map((s) => {
          const source = s.source as Record<string, unknown> | undefined;
          const connectorId = source?.connector_id || source?.connector_key;
          return typeof connectorId === "string" ? (canonicalConnectorKey(connectorId) ?? connectorId) : connectorId;
        })
        .filter(Boolean)
    );
    assert.ok(schemaConnectorIds.has(spotify.connector_id), "schema fanout includes spotify streams");
    assert.ok(schemaConnectorIds.has(github.connector_id), "schema fanout includes github streams");
    const schemaGrantIds = new Set(
      schemaStreams.map((s) => (s.source as Record<string, unknown> | undefined)?.grant_id).filter(Boolean)
    );
    assert.equal(schemaGrantIds.size, 2, "each stream is tagged with its child grant_id");

    // The package token MUST NOT reach a non-/mcp REST surface. The
    // canonical REST surfaces are gated by `requireClient` (returns 403
    // permission_error for package tokens) or by manifest resolution
    // that does not know how to interpret a package token's missing
    // grant binding (surfaces as a typed 4xx). Either way the response
    // is not 200 and is not an OK envelope.
    const restProbe = await fetchJson(`${rsUrl}/v1/schema`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    assert.notEqual(restProbe.status, 200, "package tokens MUST NOT serve REST /v1/schema");
    assert.ok(
      restProbe.status === 403 || restProbe.status === 404,
      `expected REST surface to reject package token, got ${restProbe.status}`
    );

    // Refresh-token exchange must succeed and return a fresh package token.
    const refreshed = await fetchJson(`${asUrl}/oauth/token`, {
      body: new URLSearchParams({
        client_id: client.client_id,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    assert.equal(refreshed.status, 200);
    assert.equal(Number.isInteger(refreshed.body.expires_in), true);
    assert.ok((refreshed.body.expires_in as number) > 0);
    assert.equal(refreshed.body.grant_package_id, packageId);
    assert.equal(refreshed.body.grant_id, undefined);
    assert.ok(refreshed.body.access_token);
    assert.notEqual(refreshed.body.access_token, accessToken);
    const refreshedAccessToken = stringField(refreshed.body, "access_token");

    // The refreshed package token still reaches /mcp with both children.
    const refreshedSchema = await postMcpJson(rsUrl, refreshedAccessToken, {
      id: 4,
      jsonrpc: "2.0",
      method: "tools/call",
      params: { arguments: {}, name: "schema" },
    });
    assert.equal(refreshedSchema.status, 200);
    const refreshedSchemaData = structuredContentData(resultOf(refreshedSchema));
    assert.equal(
      mustExist(schemaPackageMetadata(refreshedSchemaData), "schema response carries package metadata").member_count,
      2
    );
  } finally {
    await closeServer(server);
  }
});

test("package refresh replay deactivates every family-linked package bearer", async () => {
  const server = await startOpenTestServer();
  const asUrl = `http://localhost:${server.asPort}`;
  try {
    const spotify = await registerAuthorizedSpotify(asUrl);
    const github = await registerAuthorizedGithub(asUrl);
    const client = await registerAuthCodeClient(asUrl);
    const issued = await completeMultiSourcePackageFlow({
      asUrl,
      client,
      connectorIds: [spotify.connector_id, github.connector_id],
    });
    const initialRefreshToken = mustExist(issued.refreshToken, "continuous package issues refresh");
    const attackerRotation = await fetchJson(`${asUrl}/oauth/token`, {
      body: new URLSearchParams({
        client_id: client.client_id,
        grant_type: "refresh_token",
        refresh_token: initialRefreshToken,
      }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    assert.equal(attackerRotation.status, 200);
    const attackerAccessToken = stringField(attackerRotation.body, "access_token");

    const legitimateReplay = await fetchJson(`${asUrl}/oauth/token`, {
      body: new URLSearchParams({
        client_id: client.client_id,
        grant_type: "refresh_token",
        refresh_token: initialRefreshToken,
      }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    assert.equal(legitimateReplay.status, 400);
    assert.equal(legitimateReplay.body.fresh_authorization_required, true);

    const familyId = (
      getDb()
        .prepare("SELECT family_id FROM oauth_refresh_tokens WHERE refresh_token_hash = ?")
        .get(createHash("sha256").update(initialRefreshToken).digest("base64url")) as { family_id: string }
    ).family_id;
    const familyBearers = getDb()
      .prepare("SELECT token_id, token_kind, revoked FROM tokens WHERE refresh_family_id = ? ORDER BY token_id")
      .all(familyId) as Array<{ revoked: number; token_id: string; token_kind: string }>;
    assert.deepEqual(
      new Set(familyBearers.map((bearer) => bearer.token_kind)),
      new Set(["mcp_package"]),
      "package refresh families contain package bearers only"
    );
    assert.equal(familyBearers.length, 2);
    assert.ok(familyBearers.some((bearer) => bearer.token_id === issued.accessToken));
    assert.ok(familyBearers.some((bearer) => bearer.token_id === attackerAccessToken));
    for (const bearer of familyBearers) {
      assert.equal(bearer.revoked, 1);
      // biome-ignore lint/performance/noAwaitInLoops: The containment oracle introspects every package bearer.
      assert.equal((await introspectAccessToken(asUrl, bearer.token_id)).active, false);
    }
  } finally {
    await closeServer(server);
  }
});

test("revoking one child grant silently removes that source from the package /mcp fanout", async () => {
  const server = await startOpenTestServer();
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;

  try {
    const spotify = await registerAuthorizedSpotify(asUrl);
    const github = await registerAuthorizedGithub(asUrl);
    const client = await registerAuthCodeClient(asUrl);

    const { accessToken, packageId } = await completeMultiSourcePackageFlow({
      asUrl,
      client,
      connectorIds: [spotify.connector_id, github.connector_id],
    });

    await postMcpJson(rsUrl, accessToken, {
      id: 0,
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        capabilities: {},
        clientInfo: { name: "revoke-child-test", version: "0.0.0" },
        protocolVersion: "2025-06-18",
      },
    });

    // Baseline: both sources present.
    const before = await postMcpJson(rsUrl, accessToken, {
      id: 1,
      jsonrpc: "2.0",
      method: "tools/call",
      params: { arguments: {}, name: "schema" },
    });
    assert.equal(before.status, 200);
    const beforeData = structuredContentData(resultOf(before));
    const beforePackage = mustExist(schemaPackageMetadata(beforeData), "schema response carries package metadata");
    assert.equal(beforePackage.member_count, 2);
    const childGrants = beforePackage.sources.map((s) => ({
      connector_id: canonicalConnectorKey(s.connector_id) ?? s.connector_id,
      grant_id: s.grant_id,
    }));
    const spotifyChild = mustExist(
      childGrants.find((c) => c.connector_id === spotify.connector_id),
      "spotify child must exist"
    );
    const githubChild = childGrants.find((c) => c.connector_id === github.connector_id);
    assert.ok(spotifyChild && githubChild, "package exposes one child grant per source");

    // Revoke just the spotify child grant. The package and the github child
    // stay active.
    await revokeGrant(spotifyChild.grant_id, { request_id: "multi-source-child-revoke-test" });

    const after = await postMcpJson(rsUrl, accessToken, {
      id: 2,
      jsonrpc: "2.0",
      method: "tools/call",
      params: { arguments: {}, name: "schema" },
    });
    assert.equal(after.status, 200);
    const afterData = structuredContentData(resultOf(after));
    const afterPackage = mustExist(schemaPackageMetadata(afterData), "schema response carries package metadata");
    assert.equal(afterPackage.member_count, 1, "revoked child is no longer counted in the package fanout");
    const afterConnectorIds = new Set(
      schemaStreamRows(afterData).map((stream) => {
        const connectorId = stream.source?.connector_id;
        return canonicalConnectorKey(connectorId) ?? connectorId;
      })
    );
    assert.ok(
      !afterConnectorIds.has(spotify.connector_id),
      "spotify streams are absent after its child grant is revoked"
    );
    assert.ok(afterConnectorIds.has(github.connector_id), "github streams still present");
    const afterSourceConnectorIds = afterPackage.sources.map(
      (source) => canonicalConnectorKey(source.connector_id) ?? source.connector_id
    );
    assert.deepEqual(afterSourceConnectorIds, [github.connector_id]);

    // The package token itself stays valid because the package is still
    // active and has one active member.
    assert.equal(resultOf(after).isError, undefined);

    // Sanity: the package is still active, only the child is revoked.
    assert.ok(packageId);
  } finally {
    await closeServer(server);
  }
});

test("revoking the package invalidates /mcp access and the refresh-token exchange", async () => {
  const server = await startOpenTestServer();
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;

  try {
    const spotify = await registerAuthorizedSpotify(asUrl);
    const github = await registerAuthorizedGithub(asUrl);
    const client = await registerAuthCodeClient(asUrl);

    const { accessToken, refreshToken, packageId } = await completeMultiSourcePackageFlow({
      asUrl,
      client,
      connectorIds: [spotify.connector_id, github.connector_id],
    });

    // Confirm the token works before revocation.
    const before = await postMcpJson(rsUrl, accessToken, {
      id: 1,
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        capabilities: {},
        clientInfo: { name: "pkg-revoke-test", version: "0.0.0" },
        protocolVersion: "2025-06-18",
      },
    });
    assert.equal(before.status, 200);

    // Revoke the package.
    await revokeGrantPackage(packageId, { request_id: "multi-source-package-revoke-test" });

    // /mcp must now reject the package bearer. introspection marks the
    // token inactive with `inactive_reason = 'package_revoked'`; that
    // does not map to a grant_revoked/grant_expired/grant_invalid 403,
    // so requireToken falls through to a 401 challenge.
    const after = await postMcpJson(rsUrl, accessToken, {
      id: 2,
      jsonrpc: "2.0",
      method: "tools/list",
      params: {},
    });
    assert.equal(after.status, 401);
    assert.equal(errorOf(after).code, "authentication_error");
    assert.equal(errorOf(after).resource_metadata, `${rsUrl}/.well-known/oauth-protected-resource/mcp`);

    // The refresh-token exchange must also fail — the package's refresh
    // token row gets revoked alongside the package.
    const refreshAttempt = await fetchJson(`${asUrl}/oauth/token`, {
      body: new URLSearchParams({
        client_id: client.client_id,
        grant_type: "refresh_token",
        refresh_token: mustExist(refreshToken, "multi-source package flow must issue a refresh token"),
      }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    assert.equal(refreshAttempt.status, 400);
    assert.equal(refreshAttempt.body.error, "invalid_grant");
  } finally {
    await closeServer(server);
  }
});

// G1 regression: source-targeted read routing in a live multi-source package.
//
// The fan-out tests above prove that /mcp/schema returns rows from both
// children. This test proves the other side of the routing contract: supplying
// a connection_id argument to a normal read tool routes to exactly one child.
//
// Source-targeted routing only activates when the package members carry a
// non-null connection_id. That requires connection-scoped (not just
// connector-scoped) selections. We seed two named connector instances so the
// picker can render per-connection rows and the resulting child grants bind to
// specific cin_* ids that PackageRsClient uses for routing.
//
// The unit suite in package-rs-client.test.js stubs fetch; this test
// exercises the full stack from MCP tool call → PackageRsClient → live RI RS.

test("query_records with connection_id routes to one source only (G1 source-targeted routing)", async () => {
  const server = await startOpenTestServer();
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;

  try {
    const spotify = await registerSpotify(asUrl);
    const github = await registerGithub(asUrl);

    // Seed one named connection per connector so the picker renders
    // per-connection rows and the resulting members carry connection_id.
    const store = createSqliteConnectorInstanceStore();
    const now = new Date().toISOString();
    const spotifyConnId = "cin_g1_spotify";
    const githubConnId = "cin_g1_github";
    await store.upsert({
      connectorId: spotify.connector_id,
      connectorInstanceId: spotifyConnId,
      createdAt: now,
      displayName: "My Spotify",
      ownerSubjectId: "owner_local",
      sourceBinding: { account: "spotify@example.com" },
      sourceBindingKey: "spotify@example.com",
      sourceKind: "account",
      status: "active",
      updatedAt: now,
    });
    await store.upsert({
      connectorId: github.connector_id,
      connectorInstanceId: githubConnId,
      createdAt: now,
      displayName: "My GitHub",
      ownerSubjectId: "owner_local",
      sourceBinding: { account: "github@example.com" },
      sourceBindingKey: "github@example.com",
      sourceKind: "account",
      status: "active",
      updatedAt: now,
    });

    const client = await registerAuthCodeClient(asUrl);
    const verifier = randomBytes(32).toString("base64url");
    const codeChallenge = pkceChallenge(verifier);
    const state = "g1-routing-test";

    // The picker branch parks the request under a consent challenge; the
    // console's render model publishes one row per named connection. Approving
    // every stream of both rows is the same connection-scoped whole-source
    // approval the picker form used to submit — the routing contract under test
    // depends on the resulting members carrying a connection_id, which is what
    // the per-connection rows produce.
    const challenge = await startPickerConsentChallenge({
      asUrl,
      clientId: client.client_id,
      codeChallenge,
      state,
    });
    const model = await fetchPickerConsentModel(asUrl, challenge);
    const bySelection = new Map(model.sources.map((source) => [source.selectionValue, source]));
    const spotifySourceRow = mustExist(
      bySelection.get(encodeHostedMcpSelection({ connectionId: spotifyConnId, connectorId: spotify.connector_id })),
      "the model must publish a row for the named spotify connection"
    );
    const githubSourceRow = mustExist(
      bySelection.get(encodeHostedMcpSelection({ connectionId: githubConnId, connectorId: github.connector_id })),
      "the model must publish a row for the named github connection"
    );
    const chosen = [
      { source: spotifySourceRow, streams: spotifySourceRow.streams },
      { source: githubSourceRow, streams: githubSourceRow.streams },
    ];

    const approve = await postPickerConsentChallenge(
      asUrl,
      challenge,
      "accept",
      pickerConsentAcceptBody({ chosen, clientId: client.client_id, model })
    );
    assert.equal(approve.status, 200, JSON.stringify(approve.body));
    const callback = new URL(stringField(approve.body, "redirect_url"));
    const code = mustExist(callback.searchParams.get("code"), "redirect must carry an authorization code");
    assert.ok(code);

    const { body: tokenBody } = await fetchJson(`${asUrl}/oauth/token`, {
      body: new URLSearchParams({
        client_id: client.client_id,
        code,
        code_verifier: verifier,
        grant_type: "authorization_code",
        redirect_uri: "https://client.example/callback",
      }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    assert.ok(tokenBody.grant_package_id, "connection-scoped multi-source package issued");
    const accessToken = stringField(tokenBody, "access_token");

    await postMcpJson(rsUrl, accessToken, {
      id: 0,
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        capabilities: {},
        clientInfo: { name: "g1-routing-test", version: "0.0.0" },
        protocolVersion: "2025-06-18",
      },
    });

    // Step 1: fan-out schema to confirm both connection_id values are present.
    const schemaCall = await postMcpJson(rsUrl, accessToken, {
      id: 1,
      jsonrpc: "2.0",
      method: "tools/call",
      params: { arguments: {}, name: "schema" },
    });
    assert.equal(schemaCall.status, 200);
    assert.equal(resultOf(schemaCall).isError, undefined);
    const schemaData = structuredContentData(resultOf(schemaCall));
    // biome-ignore lint/suspicious/noUnnecessaryConditions: the helper intentionally returns null for absent package metadata.
    const sources = schemaPackageMetadata(schemaData)?.sources ?? [];
    assert.equal(sources.length, 2, "package exposes two sources");

    const spotifySource = sources.find((s) => s.connection_id === spotifyConnId);
    const githubSource = sources.find((s) => s.connection_id === githubConnId);
    assert.ok(spotifySource, "spotify connection is present in package sources");
    assert.ok(githubSource, "github connection is present in package sources");

    // Step 2: schema fan-out exposes stream names and source tags for both
    // children. Pick one stream per source for targeted read calls.
    const allRows = schemaStreamRows(schemaData);
    assert.ok(allRows.length > 0, "schema returns streams from package sources");
    const allConnectorIds = new Set(allRows.map((r) => r.source?.connector_id).filter(Boolean));
    assert.ok(allConnectorIds.has(spotify.connector_id), "schema fan-out includes spotify streams");
    assert.ok(allConnectorIds.has(github.connector_id), "schema fan-out includes github streams");
    const spotifyRow = allRows.find((r) => r.source?.connection_id === spotifyConnId);
    const githubRow = allRows.find((r) => r.source?.connection_id === githubConnId);
    assert.ok(spotifyRow?.name, "spotify connection has a stream to query");
    assert.ok(githubRow?.name, "github connection has a stream to query");

    // Step 3: query_records scoped to spotify's connection_id routes to that child.
    const spotifyQuery = await postMcpJson(rsUrl, accessToken, {
      id: 3,
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        arguments: { connection_id: spotifyConnId, limit: 1, stream: spotifyRow.name },
        name: "query_records",
      },
    });
    assert.equal(spotifyQuery.status, 200);
    assert.equal(resultOf(spotifyQuery).isError, undefined, "spotify-scoped query_records must not be an error");

    // Step 4: query_records scoped to github's connection_id routes to that child.
    const githubQuery = await postMcpJson(rsUrl, accessToken, {
      id: 4,
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        arguments: { connection_id: githubConnId, limit: 1, stream: githubRow.name },
        name: "query_records",
      },
    });
    assert.equal(githubQuery.status, 200);
    assert.equal(resultOf(githubQuery).isError, undefined, "github-scoped query_records must not be an error");

    // Step 5: unknown connection_id must return a structured MCP error
    // (isError: true), not a server crash — proves the PackageRsClient
    // not_found error path is wired through the full live stack.
    const unknownQuery = await postMcpJson(rsUrl, accessToken, {
      id: 5,
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        arguments: { connection_id: "cin_does_not_exist", limit: 1, stream: spotifyRow.name },
        name: "query_records",
      },
    });
    assert.equal(unknownQuery.status, 200, "unknown connection_id returns HTTP 200 (MCP error envelope)");
    assert.equal(resultOf(unknownQuery).isError, true, "unknown connection_id returns isError: true");
  } finally {
    await closeServer(server);
  }
});

// Stream-narrowing inside the hosted MCP picker.
//
// `completeMultiSourcePackageFlow` above always submits the wildcard form by
// selecting sources and explicitly submitting every stream. These tests prove
// the rest of the matrix:
//
//   - the picker renders collapsed source summaries with an owner-controllable
//     checkbox per manifest stream, and the default visual state is source
//     unchecked + child streams unchecked but enabled;
//   - the POST handler narrows a child grant when a subset of streams is
//     submitted;
//   - leaving every stream checked for a source preserves the canonical
//     wildcard so future manifest revisions extend cleanly;
//   - leaving a selected source with zero streams re-renders the picker with
//     HTML validation instead of silently dropping the source or returning JSON;

interface SourceSelection {
  connectionId?: string | null;
  connectorId: string;
  streamNames: string[];
}

function buildHostedMcpPickerForm({
  client,
  state,
  challenge,
  sourceSelections,
  accessMode,
}: {
  client: RegisteredClient;
  state: string;
  challenge: string;
  sourceSelections: SourceSelection[];
  accessMode?: string;
}): URLSearchParams {
  const params = new URLSearchParams();
  params.append("client_id", client.client_id);
  params.append("redirect_uri", "https://client.example/callback");
  params.append("response_type", "code");
  params.append("state", state);
  params.append("code_challenge", challenge);
  params.append("code_challenge_method", "S256");
  if (typeof accessMode === "string") {
    params.append("access_mode", accessMode);
  }
  for (const { connectorId, connectionId = null, streamNames } of sourceSelections) {
    params.append("selection", encodeHostedMcpSelection({ connectionId, connectorId }));
    for (const streamName of streamNames) {
      params.append("stream", encodeHostedMcpStreamSelection({ connectionId, connectorId, streamName }));
    }
  }
  // The approval binding (spec-core.md:881-885): the picker's script writes
  // this over the exact decision the review panel displayed, and the server
  // recomputes it from the decision it independently resolves. A submission
  // without it fails closed, so every test that models a real approval must
  // carry one, exactly as a browser would.
  params.append(
    "decision_digest",
    computeHostedMcpDecisionDigest({
      accessMode: accessMode ?? "continuous",
      clientId: client.client_id,
      sources: sourceSelections.map(({ connectorId, connectionId = null, streamNames }) => ({
        sourceKey: hostedMcpSourceKey({ connectionId, connectorId }),
        streamNames: [...streamNames].sort(),
      })),
    })
  );
  return params;
}

async function exchangePackageCode({
  asUrl,
  params,
}: {
  asUrl: string;
  client: RegisteredClient;
  params: URLSearchParams;
}): Promise<Response> {
  const approveResp = await fetch(`${asUrl}/oauth/authorize/mcp-package`, {
    body: params.toString(),
    headers: { Accept: "text/html", "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
    redirect: "manual",
  });
  return approveResp;
}

// Opens the real picker branch and reads back the `reviewDigest` the owner's
// surface is served — the exact snapshot digest
// `rejectIfHostedMcpReviewDigestStale` (as-authorize.ts) will require a POST to
// reproduce fresh. Tests exercising the stale-review-revision guard get their
// digest here (never by fabricating one) so the value they carry is genuine.
//
// It used to be scraped from a `name="review_digest"` hidden field in the
// picker HTML. The picker branch no longer renders HTML: the same digest is now
// published as `reviewDigest` on the console's JSON render model, computed by
// the same `computeHostedMcpPickerSnapshotDigest` call over the same rows.
async function fetchHostedMcpReviewDigest(asUrl: string, client: RegisteredClient, state: string): Promise<string> {
  const model = await fetchPickerConsentModelFor({ asUrl, clientId: client.client_id, state });
  assert.equal(typeof model.reviewDigest, "string", "the render model must carry a review digest");
  assert.ok(model.reviewDigest.length > 0, "the review digest must not be empty");
  return model.reviewDigest;
}

test("hosted MCP picker surfaces each row's resolved source kind as a protocol fact (source-kinds:731-743)", async () => {
  const server = await startOpenTestServer();
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    const spotify = await registerAuthorizedSpotify(asUrl);
    const client = await registerAuthCodeClient(asUrl);

    const model = await fetchPickerConsentModelFor({
      asUrl,
      clientId: client.client_id,
      state: "source-kind-render",
    });

    // FIX 3: with every row resolving to the same kind (the common case, and
    // the only case this fixture exercises), the picker stated it once above
    // the list rather than repeating the full sentence on every row.
    // `source.kind` is real protocol, but its audience is the CLIENT. To the
    // owner, "connector" answers a question nobody asked, and because every
    // row resolves to the same kind it distinguished nothing while consuming
    // a badge slot on every row. It stays in the grant and audit record.
    //
    // What moved: the assertion used to read the picker HTML for the absence
    // of the kind badge and the uniform-kind summary line. The render model is
    // the owner-surface contract now, and it carries NO source-kind field at
    // all — the strongest possible form of the same guarantee, since the
    // console cannot render a fact the server never hands it.
    // GAP: this no longer asserts anything about the wording of a kind badge
    // or a uniform-kind summary line, because neither can exist: no field
    // carries `source.kind` to the owner surface. If a future model adds one,
    // this test will not catch its COPY — only its presence, below.
    const source = mustExist(model.sources[0], "the model must publish a source row");
    assert.equal(
      Object.hasOwn(source, "sourceKind"),
      false,
      `no source-kind field reaches the owner surface (server-resolved, spotify.connector_id=${spotify.connector_id})`
    );
    assert.equal(Object.hasOwn(source, "kind"), false, "and not under a shorter name either");
    // The row still carries the owner-facing identity facts it always did, so
    // the absence above is a deliberate omission, not an empty model.
    assert.equal(typeof source.id, "string");
    assert.ok(source.name.length > 0, "the row still names the connector type");
    assert.ok(source.streams.length > 0, "the row still publishes its streams");
  } finally {
    await closeServer(server);
  }
});

test("hosted MCP picker renders collapsed source summaries with per-stream controls", async () => {
  const server = await startOpenTestServer();
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    const spotify = await registerAuthorizedSpotify(asUrl);
    const github = await registerAuthorizedGithub(asUrl);
    const client = await registerAuthCodeClient(asUrl);

    const model = await fetchPickerConsentModelFor({
      asUrl,
      clientId: client.client_id,
      state: "streams-render-test",
    });

    // The picker groups every stream under its own source, and each stream is
    // individually choosable — that is what made a subset grant possible at
    // all. The grouping used to be `<details class="hosted-ui-option-source">`
    // wrapping `hosted-ui-stream-option` checkboxes; it is now the model's
    // `sources[].streams[]` nesting, which is the same structure with the
    // markup removed.
    assert.ok(model.sources.length >= 2, `both registered sources are published: ${model.sources.length}`);
    const bySelection = new Map(model.sources.map((source) => [source.selectionValue, source]));

    // Every manifest stream must be published as its own choosable entry with
    // owner-readable copy. Nothing is disabled and nothing is pre-checked, so
    // a source cannot be granted while every one of its streams is clear.
    for (const manifest of [spotify, github]) {
      const source = mustExist(
        bySelection.get(
          encodeHostedMcpSelection({
            connectionId: defaultHostedInstanceId(manifest.connector_id),
            connectorId: manifest.connector_id,
          })
        ),
        `the model must publish a row for ${manifest.connector_id}`
      );
      const publishedNames = source.streams.map((stream) => stream.name).sort();
      assert.deepEqual(
        publishedNames,
        manifest.streams.map((stream) => stream.name).sort(),
        `${manifest.connector_id} publishes every manifest stream, no more and no fewer`
      );
      for (const stream of source.streams) {
        assert.equal(stream.selected, false, `${manifest.connector_id}::${stream.name} must not start selected`);
        assert.equal(stream.id, `${source.id}:${stream.name}`, "each stream is addressable under its own source");
        assert.ok(stream.label.length > 0, `${stream.name} must carry an owner-readable label`);
        assert.ok(stream.sentence.length > 0, `${stream.name} must carry an owner-readable sentence`);
        assert.equal(typeof stream.fieldsTotal, "number", `${stream.name} must state how many fields it covers`);
        assert.ok(stream.selectionValue.length > 0, `${stream.name} must carry its own opaque selection value`);
      }
    }

    // GAP: the picker's own selection UI — the collapsed-by-default `<details>`
    // sections, the tri-state parent checkbox and its
    // `data-source-selection-mode="streams"` derivation, the global
    // select-all/clear/expand-all/collapse-all controls and their owner
    // labels, and the absence of per-source select/clear buttons and of prose
    // teaching the checkbox model — is now the console's. None of it can be
    // asserted here: the server hands over facts, and every one of those was a
    // statement about markup or about the browser script that read it. The
    // runtime behaviour of that UI is covered by the console's own suite.
  } finally {
    await closeServer(server);
  }
});

test("hosted MCP picker pre-selects nothing: zero checked sources and zero checked streams on first render", async () => {
  // UAT regression (owner-reported): "Streams should not be selected by
  // default while parent connection is not selected." The existing render
  // test asserts no-checked per known input; this locks the coupled aggregate
  // invariant directly — across the whole picker surface there must be zero
  // selected streams, and therefore no source can be derived as selected.
  // A future change that pre-checks either side (e.g. defaulting one stream
  // on) breaks this single assertion.
  //
  // What moved: the render is the console's, so "checked" is no longer an
  // HTML attribute to count. The server states the default explicitly, as
  // `selected` on every published stream, and the source's selected state is
  // derived from its streams exactly as before — so zero selected streams
  // still means zero selected sources.
  const server = await startOpenTestServer();
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    await registerAuthorizedSpotify(asUrl);
    await registerAuthorizedGithub(asUrl);
    const client = await registerAuthCodeClient(asUrl);

    const model = await fetchPickerConsentModelFor({
      asUrl,
      clientId: client.client_id,
      state: "nothing-preselected",
    });

    // The model must actually contain pickable sources and streams, otherwise
    // "zero selected" would pass vacuously.
    const streams = model.sources.flatMap((source) => source.streams);
    assert.ok(model.sources.length >= 2, `model must contain the registered sources: ${model.sources.length}`);
    assert.ok(streams.length >= 2, `model must contain streams to choose from: ${streams.length}`);

    const selectedStreams = streams.filter((stream) => stream.selected);
    assert.equal(selectedStreams.length, 0, "no stream may be selected on first render");
    // GAP: there is no longer a separate source-level "selected" flag to
    // assert. Source selection is derived from stream selection (see
    // `buildChallengeApprovalBody`, which resolves a source only when its id
    // is submitted alongside its chosen streams), so zero selected streams is
    // the whole of the invariant the server can state.
    for (const source of model.sources) {
      assert.equal(
        Object.hasOwn(source, "selected"),
        false,
        "a source carries no independent selected state to pre-set"
      );
    }
  } finally {
    await closeServer(server);
  }
});

test("POST /oauth/authorize/mcp-package narrows the child grant to the submitted stream subset", async () => {
  const server = await startOpenTestServer();
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    const spotify = await registerAuthorizedSpotify(asUrl);
    const github = await registerAuthorizedGithub(asUrl);
    const client = await registerAuthCodeClient(asUrl);

    const verifier = randomBytes(32).toString("base64url");
    const state = "streams-narrow";
    const challenge = pkceChallenge(verifier);

    // Owner approves both connectors but narrows each one. The picker is
    // free-form: any subset of source-enabled streams may be submitted.
    const params = buildHostedMcpPickerForm({
      challenge,
      client,
      sourceSelections: [
        {
          connectorId: spotify.connector_id,
          streamNames: ["saved_tracks"],
        },
        {
          connectorId: github.connector_id,
          streamNames: ["repositories"],
        },
      ],
      state,
    });

    const approveResp = await exchangePackageCode({ asUrl, client, params });
    assert.equal(approveResp.status, 302);
    const callback = new URL(mustExist(approveResp.headers.get("location"), "redirect must carry a Location header"));
    const code = mustExist(callback.searchParams.get("code"), "redirect must carry an authorization code");
    assert.ok(code);

    const { status, body } = await fetchJson(`${asUrl}/oauth/token`, {
      body: new URLSearchParams({
        client_id: client.client_id,
        code,
        code_verifier: verifier,
        grant_type: "authorization_code",
        redirect_uri: "https://client.example/callback",
      }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    assert.equal(status, 200);
    const packageId = body.grant_package_id;
    assert.ok(packageId, "narrowed approval still issues a package-bound token");

    // Inspect the persisted child grants. `getGrantPackageAccess` returns
    // members ordered by `added_at, grant_id` — i.e. spotify first because
    // the picker emits selections in iteration order — but we MUST NOT rely
    // on that ordering. Sort by connector instead.
    const access = mustExist(await getGrantPackageAccess(packageId), "package access must exist") as GrantPackageAccess;
    assert.ok(access, "package is retrievable after issuance");
    assert.equal(access.members.length, 2);
    const byConnector = new Map(
      access.members.map((member) => [canonicalConnectorKey(member.grant.source.id), member])
    );
    const spotifyChild = byConnector.get(spotify.connector_id);
    const githubChild = byConnector.get(github.connector_id);
    assert.ok(spotifyChild && githubChild, "one child per approved connector");

    const spotifyStreamNames = spotifyChild.grant.streams.map((s) => s.name).sort();
    const githubStreamNames = githubChild.grant.streams.map((s) => s.name).sort();
    assert.deepEqual(spotifyStreamNames, ["saved_tracks"], "spotify child carries only the approved stream");
    assert.deepEqual(githubStreamNames, ["repositories"], "github child carries exactly the approved subset");

    // Defense-in-depth: the manifest declares more streams than what the
    // owner approved, so the picker MUST NOT have silently widened the
    // grant. Compare against the manifest itself rather than reasserting
    // the literal list above.
    const spotifyManifestStreamNames = spotify.streams.map((s) => s.name);
    const githubManifestStreamNames = github.streams.map((s) => s.name);
    assert.ok(
      spotifyManifestStreamNames.length > spotifyStreamNames.length,
      "spotify manifest declares more streams than the owner approved"
    );
    assert.ok(
      githubManifestStreamNames.length > githubStreamNames.length,
      "github manifest declares more streams than the owner approved"
    );
  } finally {
    await closeServer(server);
  }
});

test("POST /oauth/authorize/mcp-package preserves the wildcard when every stream is submitted", async () => {
  const server = await startOpenTestServer();
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    const spotify = await registerAuthorizedSpotify(asUrl);
    const client = await registerAuthCodeClient(asUrl);

    const verifier = randomBytes(32).toString("base64url");
    const state = "streams-wildcard";
    const challenge = pkceChallenge(verifier);

    // Submit every stream the manifest declares. This is the explicit
    // "use all streams" path.
    const params = buildHostedMcpPickerForm({
      challenge,
      client,
      sourceSelections: [
        {
          connectorId: spotify.connector_id,
          streamNames: spotify.streams.map((stream) => stream.name),
        },
      ],
      state,
    });

    const approveResp = await exchangePackageCode({ asUrl, client, params });
    assert.equal(approveResp.status, 302);
    const code = mustExist(
      new URL(mustExist(approveResp.headers.get("location"), "redirect must carry a Location header")).searchParams.get(
        "code"
      ),
      "redirect must carry an authorization code"
    );
    const { status, body } = await fetchJson(`${asUrl}/oauth/token`, {
      body: new URLSearchParams({
        client_id: client.client_id,
        code,
        code_verifier: verifier,
        grant_type: "authorization_code",
        redirect_uri: "https://client.example/callback",
      }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    assert.equal(status, 200);
    const packageId = stringField(body, "grant_package_id");
    const access = mustExist(await getGrantPackageAccess(packageId), "package access must exist") as GrantPackageAccess;
    assert.equal(access.members.length, 1);
    const child = mustExist(access.members[0], "package must carry one member");
    const grantedNames = new Set(child.grant.streams.map((s) => s.name));
    for (const stream of spotify.streams) {
      assert.ok(grantedNames.has(stream.name), `child grant must include ${stream.name} when no narrowing happened`);
    }
    assert.equal(grantedNames.size, spotify.streams.length, "child grant must not include extra streams");
  } finally {
    await closeServer(server);
  }
});

test("POST /oauth/authorize/mcp-package renders picker error when a selected source has no streams", async () => {
  const server = await startOpenTestServer();
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    const spotify = await registerAuthorizedSpotify(asUrl);
    const github = await registerAuthorizedGithub(asUrl);
    const client = await registerAuthCodeClient(asUrl);

    const verifier = randomBytes(32).toString("base64url");
    const state = "streams-partial-drop";
    const challenge = pkceChallenge(verifier);

    // Owner selected spotify but left every stream inside it unchecked. github
    // keeps a single stream. The AS must not silently drop the selected
    // spotify source because that hides ambiguous owner intent.
    const params = buildHostedMcpPickerForm({
      challenge,
      client,
      sourceSelections: [
        { connectorId: spotify.connector_id, streamNames: [] },
        { connectorId: github.connector_id, streamNames: ["commits"] },
      ],
      state,
    });

    const resp = await exchangePackageCode({ asUrl, client, params });
    assert.equal(resp.status, 400);
    assert.match(resp.headers.get("content-type") || "", /text\/html/);
    const html = await resp.text();
    assert.match(html, /Hosted MCP test client wants to read your data/);
    assert.match(html, /Choose data from/i);
    assert.match(html, /data-hosted-mcp-picker-error/);
    assert.match(html, /class="hosted-ui-error hosted-ui-picker-error"/);
  } finally {
    await closeServer(server);
  }
});

test("POST /oauth/authorize/mcp-package renders picker error when every selected source has zero streams", async () => {
  const server = await startOpenTestServer();
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    const spotify = await registerAuthorizedSpotify(asUrl);
    const github = await registerAuthorizedGithub(asUrl);
    const client = await registerAuthCodeClient(asUrl);

    const verifier = randomBytes(32).toString("base64url");
    const state = "streams-all-empty";
    const challenge = pkceChallenge(verifier);

    const params = buildHostedMcpPickerForm({
      challenge,
      client,
      sourceSelections: [
        { connectorId: spotify.connector_id, streamNames: [] },
        { connectorId: github.connector_id, streamNames: [] },
      ],
      state,
    });

    const resp = await exchangePackageCode({ asUrl, client, params });
    assert.equal(resp.status, 400);
    const html = await resp.text();
    // Error names the affected sources by manifest display name. It MUST
    // NOT leak a raw registry URL or a cin_ id. Scope the leak checks to the
    // error banner: the re-rendered picker page legitimately echoes the
    // client redirect_uri as a hidden OAuth input.
    assert.match(html, /Choose data from each selected source, or clear the source\./);
    const errorText = renderedHostedMcpPickerErrorText(html).toLowerCase();
    assert.equal(errorText.includes("https://"), false, "error message MUST NOT leak registry URLs");
    assert.equal(errorText.includes("cin_"), false, "error message MUST NOT leak raw connection ids");
  } finally {
    await closeServer(server);
  }
});

test("POST /oauth/authorize/mcp-package reports declared zero-eligible streams and creates no package", async () => {
  // Production regression (owner-reported 2026-08-23, and again 2026-08-30 as
  // "the consent picker shows streams the owner does not have"): approving a
  // source whose declared stream has no installed connector instance
  // detonated the whole authorize flow with `statusCode: 500` — Fastify's
  // default error handler, meaning `CoreSourceAuthorizationError` escaped
  // every route-level catch. The 2026-08-30 root cause went one layer
  // shallower: the picker itself rendered a selectable row for a connector
  // the owner never connected (`buildConnectorPickerRows` iterated the whole
  // registered-connector catalog, not owner holdings), so a legitimate
  // "select all" over what the picker offered could submit a source with zero
  // eligible instances. `accumulateSourceEntry` now rejects any selection
  // naming a connector with zero active bindings before it ever reaches the
  // grant engine, so this either can't happen from the real picker anymore,
  // or — for a stale/forged submission — fails fast with a plain 4xx instead
  // of the grant engine's `source.authorization_details_invalid` blowing up
  // the whole multi-source package.
  //
  // `registerSpotify` (unlike `registerAuthorizedSpotify`) registers the
  // connector manifest WITHOUT seeding any connector instance — this is the
  // "zero eligible instance" condition exactly as production hit it, now
  // exercised as a stale/forged picker submission rather than the picker's
  // own offering.
  const server = await startOpenTestServer();
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    const spotify = await registerSpotify(asUrl);
    const client = await registerAuthCodeClient(asUrl);

    const verifier = randomBytes(32).toString("base64url");
    const state = "zero-eligible-instances";
    const challenge = pkceChallenge(verifier);

    const packageCountBefore = await countGrantPackagesForOwner();
    const params = buildHostedMcpPickerForm({
      challenge,
      client,
      sourceSelections: [{ connectorId: spotify.connector_id, streamNames: ["saved_tracks", "archive_jobs"] }],
      state,
    });

    const resp = await exchangePackageCode({ asUrl, client, params });
    const bodyText = await resp.text();

    assert.ok(
      resp.status >= 400 && resp.status < 500,
      `zero-eligible-instance approval must return an actionable 4xx, not ${resp.status}: ${bodyText}`
    );

    let body: Record<string, unknown>;
    try {
      body = JSON.parse(bodyText);
    } catch {
      assert.fail(`expected a structured JSON error envelope, got: ${bodyText}`);
    }

    assert.equal(body.error, "invalid_request");
    assert.match(
      String(body.error_description),
      /no active connection/i,
      `error must name the connector as having no active connection, got: ${JSON.stringify(body)}`
    );
    assert.deepEqual(
      body.streams,
      ["saved_tracks"],
      "the structured envelope names the declared zero-eligible stream, not a submitted undeclared stream"
    );
    assert.equal(
      await countGrantPackagesForOwner(),
      packageCountBefore,
      "a rejected zero-eligible submission must not create a package"
    );
  } finally {
    await closeServer(server);
  }
});

test("POST /oauth/authorize/mcp-package still rejects an ambiguous omitted-instance_ids selection (>1 eligible instance)", async () => {
  // Safety-property regression guard: the fix for the zero-eligible-instance
  // case above must NOT weaken this genuinely-ambiguous case. When a stream
  // has MORE THAN ONE eligible instance and the request omits instance_ids,
  // resolveCoreEligibleInstanceIds must still fail — the owner must
  // disambiguate. This must keep failing with an actionable 4xx (it already
  // did before the fix; this only guards against regression).
  const server = await startOpenTestServer();
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    const spotify = await registerSpotify(asUrl);
    // Seed two active instances for the same connector so eligible.size > 1.
    const now = new Date().toISOString();
    const instanceStore = createSqliteConnectorInstanceStore();
    await Promise.all(
      ["a", "b"].map((suffix) => {
        const connectorInstanceId = `cin_hosted_${spotify.connector_id}_${suffix}`;
        return instanceStore.upsert({
          connectorId: spotify.connector_id,
          connectorInstanceId,
          createdAt: now,
          displayName: `${spotify.connector_id} test account ${suffix}`,
          ownerSubjectId: "owner_local",
          sourceBinding: { fixture: connectorInstanceId },
          sourceBindingKey: connectorInstanceId,
          sourceKind: "account",
          status: "active",
          updatedAt: now,
        });
      })
    );
    const client = await registerAuthCodeClient(asUrl);

    const verifier = randomBytes(32).toString("base64url");
    const state = "ambiguous-multi-instance";
    const challenge = pkceChallenge(verifier);

    const params = buildHostedMcpPickerForm({
      challenge,
      client,
      sourceSelections: [{ connectorId: spotify.connector_id, streamNames: ["saved_tracks"] }],
      state,
    });

    const resp = await exchangePackageCode({ asUrl, client, params });
    const bodyText = await resp.text();
    assert.ok(
      resp.status >= 400 && resp.status < 500,
      `ambiguous multi-instance approval must still be rejected with a 4xx, not ${resp.status}: ${bodyText}`
    );
    assert.notEqual(resp.status, 500, "ambiguity guard must not regress to a 500");
  } finally {
    await closeServer(server);
  }
});

test("POST /oauth/authorize/mcp-package renders picker error when streams are submitted without a source", async () => {
  const server = await startOpenTestServer();
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    const spotify = await registerAuthorizedSpotify(asUrl);
    const github = await registerAuthorizedGithub(asUrl);
    const client = await registerAuthCodeClient(asUrl);

    const verifier = randomBytes(32).toString("base64url");
    const challenge = pkceChallenge(verifier);
    const params = new URLSearchParams();
    params.append("client_id", client.client_id);
    params.append("redirect_uri", "https://client.example/callback");
    params.append("response_type", "code");
    params.append("state", "streams-without-source");
    params.append("code_challenge", challenge);
    params.append("code_challenge_method", "S256");
    params.append(
      "stream",
      encodeHostedMcpStreamSelection({
        connectionId: null,
        connectorId: spotify.connector_id,
        streamName: "saved_tracks",
      })
    );
    params.append(
      "stream",
      encodeHostedMcpStreamSelection({
        connectionId: null,
        connectorId: github.connector_id,
        streamName: "repositories",
      })
    );

    const resp = await exchangePackageCode({ asUrl, client, params });
    assert.equal(resp.status, 400);
    assert.match(resp.headers.get("content-type") || "", /text\/html/);
    const html = await resp.text();

    assert.match(html, /Hosted MCP test client wants to read your data/);
    assert.match(html, /data-hosted-mcp-picker-error/);
    assert.match(html, /Choose at least one data type to continue/);
    assert.equal(
      html.includes('{"error"'),
      false,
      "ordinary picker validation should not fall through to the raw JSON OAuth error page"
    );
  } finally {
    await closeServer(server);
  }
});

test("POST /oauth/authorize/mcp-package ignores stream entries whose source was not also selected", async () => {
  const server = await startOpenTestServer();
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    const spotify = await registerAuthorizedSpotify(asUrl);
    const github = await registerAuthorizedGithub(asUrl);
    const client = await registerAuthCodeClient(asUrl);

    const verifier = randomBytes(32).toString("base64url");
    const state = "streams-orphan";
    const challenge = pkceChallenge(verifier);

    const params = new URLSearchParams();
    params.append("client_id", client.client_id);
    params.append("redirect_uri", "https://client.example/callback");
    params.append("response_type", "code");
    params.append("state", state);
    params.append("code_challenge", challenge);
    params.append("code_challenge_method", "S256");
    // Only spotify's source checkbox is submitted. The picker would have
    // also submitted github's stream entries if the owner clicked them
    // before unchecking the source; the AS MUST ignore orphan streams so a
    // stale stream toggle cannot smuggle authority into a deselected
    // source.
    params.append(
      "selection",
      encodeHostedMcpSelection({
        connectionId: null,
        connectorId: spotify.connector_id,
      })
    );
    params.append(
      "stream",
      encodeHostedMcpStreamSelection({
        connectionId: null,
        connectorId: spotify.connector_id,
        streamName: "saved_tracks",
      })
    );
    params.append(
      "stream",
      encodeHostedMcpStreamSelection({
        connectionId: null,
        connectorId: github.connector_id,
        streamName: "repositories",
      })
    );
    // The digest binds what the server RESOLVES, which is spotify alone —
    // the orphaned github stream is dropped before it can become a grant, so
    // it must not appear in the decision the owner is bound to either.
    appendDecisionDigest(params, {
      clientId: client.client_id,
      sources: [{ connectionId: null, connectorId: spotify.connector_id, streamNames: ["saved_tracks"] }],
    });

    const approveResp = await exchangePackageCode({ asUrl, client, params });
    assert.equal(approveResp.status, 302);
    const code = mustExist(
      new URL(mustExist(approveResp.headers.get("location"), "redirect must carry a Location header")).searchParams.get(
        "code"
      ),
      "redirect must carry an authorization code"
    );
    const { status, body } = await fetchJson(`${asUrl}/oauth/token`, {
      body: new URLSearchParams({
        client_id: client.client_id,
        code,
        code_verifier: verifier,
        grant_type: "authorization_code",
        redirect_uri: "https://client.example/callback",
      }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    assert.equal(status, 200);
    const access = mustExist(
      await getGrantPackageAccess(body.grant_package_id),
      "package access must exist"
    ) as GrantPackageAccess;
    assert.equal(access.members.length, 1, "orphan stream entries MUST NOT create a child grant");
    assert.equal(
      mustExist(access.members[0], "package must carry one member").grant.source.id,
      publicSourceIdForManifest(spotify)
    );
  } finally {
    await closeServer(server);
  }
});

// ─── Access-mode narrowing ──────────────────────────────────────────────────
// The hosted MCP picker exposes one package-level access-mode radio that
// applies the chosen mode (`continuous` default, `single_use` opt-in) to every
// child grant in the package. The picker:
//   - renders both options with `continuous` pre-selected so the no-action
//     default preserves prior behavior;
//   - the picker copy is honest that the page does NOT set a retention limit
//     for data the app saves after reading from the owner's server;
//   - submitting `access_mode=single_use` narrows every child grant in the
//     package to single_use without any other change to the form;
//   - submitting `access_mode=continuous` (or omitting the field) keeps every
//     child grant continuous;
//   - submitting any other value returns a typed `invalid_request` envelope
//     and issues no grants;
//   - `grant.issued` spine events for every child grant record the resolved
//     access mode, stream names, and an explicit `retention: null` so the
//     operator dashboard can tell narrowed grants from wildcard ones without
//     re-deriving the picker submission and can see that no retention limit
//     was encoded.

test("hosted MCP picker renders an access-mode radio with continuous default and surfaces the retention caveat", async () => {
  const server = await startOpenTestServer();
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    await registerAuthorizedSpotify(asUrl);
    const client = await registerAuthCodeClient(asUrl);

    const model = await fetchPickerConsentModelFor({
      asUrl,
      clientId: client.client_id,
      state: "access-mode-render",
    });

    // What moved: the radio group is the console's markup now, so the default
    // and the vocabulary are asserted where the server states them — on the
    // model, which is also exactly what the accept route validates against.
    assert.equal(model.accessMode.value, "continuous", "continuous is the default access mode");
    assert.ok(
      model.accessMode.supported.includes("continuous"),
      `continuous must be offered: ${model.accessMode.supported.join(", ")}`
    );
    assert.ok(
      model.accessMode.supported.includes("single_use"),
      `single_use must be offered as the narrowing option: ${model.accessMode.supported.join(", ")}`
    );

    // Retention copy honesty: the model must not promise an owner-narrowable
    // retention knob, must not advertise the off-spec `client_policy`
    // classification, and must state the real server-generated retention bound
    // (request-params:726) rather than the old "no time limit" disclaimer,
    // which was accurate only before any retention policy existed.
    assert.equal(typeof model.retention, "string");
    assert.ok(model.retention.length > 0, "retention must be a rendered sentence, not empty");
    assert.equal(
      model.retention.includes("client-policy retention"),
      false,
      "retention must not assert the legacy client-policy phrase"
    );
    assert.equal(
      model.retention.includes("client_policy"),
      false,
      "retention must not surface the off-spec retention.classification value"
    );
    // The page told the owner "data it reads is deleted within 90 days". Read
    // plainly, the subject is what the APP does — a promise the client never
    // made and this server cannot cause (spec-core.md:948, :951). No feature
    // makes that sentence true, so the fix is to state the absence.
    assert.match(
      model.retention,
      /did not say how long it keeps the data it receives\./,
      "retention must state the absence of a commitment, naming the app"
    );
    assert.doesNotMatch(
      model.retention,
      /deleted within 90\s*days/i,
      "the server must never tell the owner the client deletes their data on a schedule it never accepted"
    );
    // GAP: the authorship CLASSES are gone from this assertion. The server
    // used to prove structurally that retention rendered under
    // `data-authorship="manifest"` and never inside the
    // `data-authorship="protocol"` ("Streams and access mode your server will
    // enforce") block. The model carries `retention` and `accessMode` as
    // separate top-level fields, which keeps them from being conflated, but
    // marking retention as a recipient commitment PDPP does not enforce
    // (spec-core.md:951) is now the console's responsibility and is not
    // asserted here.
    assert.notEqual(
      model.retention,
      String(model.accessMode.value),
      "retention and access mode remain distinct facts, not one merged claim"
    );
  } finally {
    await closeServer(server);
  }
});

test("POST /oauth/authorize/mcp-package narrows every child grant to single_use when the picker submits it", async () => {
  const server = await startOpenTestServer();
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    const spotify = await registerAuthorizedSpotify(asUrl);
    const github = await registerAuthorizedGithub(asUrl);
    const client = await registerAuthCodeClient(asUrl);

    const verifier = randomBytes(32).toString("base64url");
    const state = "access-mode-single-use";
    const challenge = pkceChallenge(verifier);

    const params = buildHostedMcpPickerForm({
      accessMode: "single_use",
      challenge,
      client,
      sourceSelections: [
        { connectorId: spotify.connector_id, streamNames: spotify.streams.map((s) => s.name) },
        { connectorId: github.connector_id, streamNames: github.streams.map((s) => s.name) },
      ],
      state,
    });

    const approveResp = await exchangePackageCode({ asUrl, client, params });
    assert.equal(approveResp.status, 302);
    const code = mustExist(
      new URL(mustExist(approveResp.headers.get("location"), "redirect must carry a Location header")).searchParams.get(
        "code"
      ),
      "redirect must carry an authorization code"
    );

    const { status, body } = await fetchJson(`${asUrl}/oauth/token`, {
      body: new URLSearchParams({
        client_id: client.client_id,
        code,
        code_verifier: verifier,
        grant_type: "authorization_code",
        redirect_uri: "https://client.example/callback",
      }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    assert.equal(status, 200);
    assert.equal(body.refresh_token, undefined, "a package containing single_use grants never issues refresh tokens");
    assert.equal(body.expires_in, undefined, "the response omits expires_in when the package bearer has no expiry");
    const introspection = await introspectAccessToken(asUrl, stringField(body, "access_token"));
    assert.equal(introspection.active, true);
    assert.equal(Object.hasOwn(introspection, "exp"), false, "introspection omits exp when storage has no expiry");
    const access = mustExist(
      await getGrantPackageAccess(body.grant_package_id),
      "package access must exist"
    ) as GrantPackageAccess;
    assert.equal(access.members.length, 2);
    for (const member of access.members) {
      assert.equal(
        member.grant.access_mode,
        "single_use",
        `child grant for ${member.grant.source.id} must be single_use when picker submits single_use`
      );
    }
  } finally {
    await closeServer(server);
  }
});

test("POST /oauth/authorize/mcp-package defaults every child grant to continuous when access_mode is absent", async () => {
  const server = await startOpenTestServer();
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    const spotify = await registerAuthorizedSpotify(asUrl);
    const client = await registerAuthCodeClient(asUrl);

    const verifier = randomBytes(32).toString("base64url");
    const state = "access-mode-default";
    const challenge = pkceChallenge(verifier);

    // Omit `accessMode` from the helper → no `access_mode` field on the form.
    // This is the "stale picker / no radio submitted" path.
    const params = buildHostedMcpPickerForm({
      challenge,
      client,
      sourceSelections: [{ connectorId: spotify.connector_id, streamNames: spotify.streams.map((s) => s.name) }],
      state,
    });

    const approveResp = await exchangePackageCode({ asUrl, client, params });
    assert.equal(approveResp.status, 302);
    const code = mustExist(
      new URL(mustExist(approveResp.headers.get("location"), "redirect must carry a Location header")).searchParams.get(
        "code"
      ),
      "redirect must carry an authorization code"
    );

    const { status, body } = await fetchJson(`${asUrl}/oauth/token`, {
      body: new URLSearchParams({
        client_id: client.client_id,
        code,
        code_verifier: verifier,
        grant_type: "authorization_code",
        redirect_uri: "https://client.example/callback",
      }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    assert.equal(status, 200);
    const access = mustExist(
      await getGrantPackageAccess(body.grant_package_id),
      "package access must exist"
    ) as GrantPackageAccess;
    assert.equal(access.members.length, 1);
    assert.equal(
      mustExist(access.members[0], "package must carry one member").grant.access_mode,
      "continuous",
      "missing access_mode must default to continuous (prior baseline)"
    );
  } finally {
    await closeServer(server);
  }
});

test("POST /oauth/authorize/mcp-package rejects an unsupported access_mode value without issuing grants", async () => {
  const server = await startOpenTestServer();
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    const spotify = await registerSpotify(asUrl);
    const client = await registerAuthCodeClient(asUrl);

    const verifier = randomBytes(32).toString("base64url");
    const state = "access-mode-bad";
    const challenge = pkceChallenge(verifier);

    const params = buildHostedMcpPickerForm({
      accessMode: "forever",
      challenge,
      client,
      sourceSelections: [{ connectorId: spotify.connector_id, streamNames: spotify.streams.map((s) => s.name) }],
      state,
    });

    const approveResp = await fetch(`${asUrl}/oauth/authorize/mcp-package`, {
      body: params.toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
      redirect: "manual",
    });
    assert.equal(approveResp.status, 400);
    const errorBody = (await approveResp.json()) as Record<string, unknown>;
    assert.equal(errorBody.error, "invalid_request");
    assert.match(stringField(errorBody, "error_description"), /access_mode/);
  } finally {
    await closeServer(server);
  }
});

test("hosted MCP child-grant grant.issued spine event records access_mode, stream_names, and the server-generated retention bound", async () => {
  const server = await startOpenTestServer();
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    const spotify = await registerAuthorizedSpotify(asUrl);
    const client = await registerAuthCodeClient(asUrl);

    const verifier = randomBytes(32).toString("base64url");
    const state = "access-mode-spine-event";
    const challenge = pkceChallenge(verifier);

    const params = buildHostedMcpPickerForm({
      accessMode: "single_use",
      challenge,
      client,
      sourceSelections: [
        // Narrow streams to a subset so the test can verify stream_names
        // surfaces narrowing as well.
        { connectorId: spotify.connector_id, streamNames: ["saved_tracks"] },
      ],
      state,
    });

    const approveResp = await exchangePackageCode({ asUrl, client, params });
    assert.equal(approveResp.status, 302);
    const code = mustExist(
      new URL(mustExist(approveResp.headers.get("location"), "redirect must carry a Location header")).searchParams.get(
        "code"
      ),
      "redirect must carry an authorization code"
    );
    const { status, body } = await fetchJson(`${asUrl}/oauth/token`, {
      body: new URLSearchParams({
        client_id: client.client_id,
        code,
        code_verifier: verifier,
        grant_type: "authorization_code",
        redirect_uri: "https://client.example/callback",
      }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    assert.equal(status, 200);
    const access = mustExist(
      await getGrantPackageAccess(body.grant_package_id),
      "package access must exist"
    ) as GrantPackageAccess;
    const childGrantId = mustExist(access.members[0], "package must carry one member").grant.grant_id as string;

    // Owner-session middleware is a no-op when `ownerAuthPassword: ''`
    // (see `startOpenTestServer`), so the timeline read here matches the
    // existing security-auth-surfaces fixtures: anonymous fetch, envelope
    // exposes spine events under `.data`.
    const { status: timelineStatus, body: timeline } = await fetchJson(
      `${asUrl}/_ref/grants/${encodeURIComponent(childGrantId)}/timeline`
    );
    assert.equal(timelineStatus, 200);
    const timelineEvents = timeline.data as Record<string, unknown>[];
    const issuedEvent = mustExist(
      timelineEvents.find((e) => e.event_type === "grant.issued"),
      "child grant timeline must contain a grant.issued event"
    );
    const issuedEventData = issuedEvent.data as Record<string, unknown>;
    assert.equal(issuedEventData.access_mode, "single_use");
    assert.deepEqual(issuedEventData.stream_names, ["saved_tracks"]);
    // Retention is a commitment BY THE RECIPIENT (spec-core.md:951), and a
    // hosted-MCP request carries no `authorization_details` at all — the
    // client has declared none. The picker used to write a hardcoded
    // `{ max_duration: "P90D", on_expiry: "delete" }` into every grant,
    // recording as ChatGPT's commitment a promise ChatGPT never made and this
    // server cannot enforce (:948 — PDPP does not retroactively reach into
    // client-side data stores). The grant must now record no recipient
    // commitment, because there is none.
    assert.equal(
      issuedEventData.retention ?? null,
      null,
      "no retention may be written into a grant as the client's commitment when the client declared none"
    );
  } finally {
    await closeServer(server);
  }
});

// --- Consent-flow repair regression tests ---------------------------------
//
// These lock the behavior of the GET surfaces an owner's browser actually
// hits, which are not otherwise exercised end-to-end:
//   - GET /oauth/authorize/mcp-package (the path from the production symptom
//     report) has no GET route; it MUST 404 cleanly and MUST NOT surface the
//     legacy "Unknown connector: https" parser error.
//   - GET /oauth/authorize?connector_id=<URL-shaped first-party id> MUST
//     resolve via canonical mapping and stage a pending grant, never leak the
//     URL into an "Unknown connector" branch.
//   - GET /consent?request_uri=<urn> MUST render the consent page for a live
//     pending grant, and MUST return a recoverable, branded 404 (not a bare
//     "Not found" string) when the pending grant is expired/unknown.

function buildAuthorizeGetUrl({
  asUrl,
  client,
  extra = {},
}: {
  asUrl: string;
  client: RegisteredClient;
  extra?: Record<string, string>;
}): URL {
  const url = new URL(`${asUrl}/oauth/authorize`);
  url.searchParams.set("client_id", client.client_id);
  url.searchParams.set("redirect_uri", "https://client.example/callback");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("code_challenge", pkceChallenge(randomBytes(32).toString("base64url")));
  url.searchParams.set("code_challenge_method", "S256");
  for (const [k, v] of Object.entries(extra)) {
    url.searchParams.set(k, v);
  }
  return url;
}

test('GET /oauth/authorize/mcp-package 404s cleanly and never leaks "Unknown connector: https"', async () => {
  const server = await startOpenTestServer();
  const asUrl = `http://localhost:${server.asPort}`;
  try {
    await registerSpotify(asUrl);
    const resp = await fetch(`${asUrl}/oauth/authorize/mcp-package`, { redirect: "manual" });
    assert.equal(resp.status, 404, "mcp-package has no GET route; the picker submits via POST");
    const text = await resp.text();
    assert.equal(
      text.toLowerCase().includes("unknown connector"),
      false,
      'GET to the package endpoint MUST NOT reach the "Unknown connector" branch'
    );
    assert.equal(
      text.toLowerCase().includes('"https"') || /unknown connector: https/i.test(text),
      false,
      'GET to the package endpoint MUST NOT leak a truncated "https" connector id'
    );
  } finally {
    await closeServer(server);
  }
});

test('GET /oauth/authorize?connector_id=<URL-shaped id> resolves canonically without leaking "https"', async () => {
  const server = await startOpenTestServer();
  const asUrl = `http://localhost:${server.asPort}`;
  try {
    await registerSpotify(asUrl);
    const client = await registerAuthCodeClient(asUrl);
    const url = buildAuthorizeGetUrl({
      asUrl,
      client,
      extra: { connector_id: "https://registry.pdpp.dev/connectors/spotify" },
    });
    const resp = await fetch(url, { redirect: "manual" });
    // A URL-shaped first-party connector id must canonicalize and stage a
    // pending grant (302 to /consent), not collapse to "Unknown connector".
    assert.equal(resp.status, 302, "URL-shaped connector_id should stage a pending grant and redirect");
    const location = resp.headers.get("location") || "";
    assert.ok(location.includes("/consent?request_uri="), "redirect must target the consent page");
    assert.ok(
      location.includes("urn%3Apdpp%3Apending-consent%3A") || location.includes("urn:pdpp:pending-consent:"),
      "redirect must carry a pending-consent request_uri"
    );
  } finally {
    await closeServer(server);
  }
});

test("GET /consent renders the consent page for a freshly staged pending grant", async () => {
  const server = await startOpenTestServer();
  const asUrl = `http://localhost:${server.asPort}`;
  try {
    await registerAuthorizedSpotify(asUrl);
    const client = await registerAuthCodeClient(asUrl);
    // Stage a pending grant via the canonical short key path.
    const authorizeResp = await fetch(buildAuthorizeGetUrl({ asUrl, client, extra: { connector_id: "spotify" } }), {
      redirect: "manual",
    });
    assert.equal(authorizeResp.status, 302);
    const consentUrl = new URL(
      mustExist(authorizeResp.headers.get("location"), "redirect must carry a Location header"),
      asUrl
    );
    const requestUri = consentUrl.searchParams.get("request_uri");
    assert.ok(requestUri?.startsWith("urn:pdpp:pending-consent:"));

    const consentResp = await fetch(consentUrl, { redirect: "manual" });
    const html = await consentResp.text();
    assert.equal(consentResp.status, 200, "a live pending-consent request_uri must render the consent page");
    assert.ok(html.includes("<!DOCTYPE html>"), "consent page is a full hosted document");
    assert.ok(
      /action="\/consent\/review"/.test(html),
      "consent page must require review before approval for this request_uri"
    );
    assert.doesNotMatch(html, /action="\/consent\/approve"/, "an unreviewed request must not offer final approval");
  } finally {
    await closeServer(server);
  }
});

test("GET /consent returns a recoverable, branded 404 for an expired or unknown request_uri", async () => {
  const server = await startOpenTestServer();
  const asUrl = `http://localhost:${server.asPort}`;
  try {
    // Well-formed pending-consent URN that addresses no live row (expired,
    // already decided, or minted on another instance).
    const bogus = `${asUrl}/consent?request_uri=${encodeURIComponent("urn:pdpp:pending-consent:dc_does_not_exist")}`;
    const resp = await fetch(bogus, { redirect: "manual" });
    assert.equal(resp.status, 404, "an unknown pending grant genuinely does not exist on this instance");
    const text = await resp.text();
    // The defect this repairs: a bare "Not found" string. The page must now
    // be a branded hosted document that tells the owner how to recover.
    assert.ok(
      text.includes("<!DOCTYPE html>"),
      "expired-consent response must be a branded hosted page, not a bare string"
    );
    assert.notEqual(text.trim(), "Not found", 'must not return the legacy bare "Not found" body');
    assert.ok(
      /expired|already (approved|used)|start the request again/i.test(text),
      "expired-consent page must explain how to recover (restart the request)"
    );
  } finally {
    await closeServer(server);
  }
});

// ── Boundary canonicalization and picker filtering tests ──────────────────────

test("GET /oauth/authorize?connector_id=<URL> stages pending consent with canonical connector_id in storage_binding", async () => {
  // Regression: a URL-shaped connector_id passed via the `connector_id=`
  // shortcut must be canonicalized at the boundary so the pending consent
  // (and the issued grant) store a canonical short key, not a registry URL.
  const server = await startOpenTestServer();
  const asUrl = `http://localhost:${server.asPort}`;
  try {
    await registerAuthorizedSpotify(asUrl);
    const client = await registerAuthCodeClient(asUrl);
    const verifier = randomBytes(32).toString("base64url");
    const url = new URL(`${asUrl}/oauth/authorize`);
    url.searchParams.set("client_id", client.client_id);
    url.searchParams.set("redirect_uri", "https://client.example/callback");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("state", "boundary-norm-test");
    url.searchParams.set("code_challenge", pkceChallenge(verifier));
    url.searchParams.set("code_challenge_method", "S256");
    // URL-shaped connector id — the bug: before the fix this staged a pending
    // consent with storage_binding.connector_id = 'https://...'
    url.searchParams.set("connector_id", "https://registry.pdpp.dev/connectors/spotify");

    const resp = await fetch(url, { redirect: "manual" });
    assert.equal(resp.status, 302, "URL-shaped connector_id must stage a pending grant and redirect");
    const location = resp.headers.get("location") || "";
    assert.ok(location.includes("/consent?request_uri="), "redirect must target the consent page");

    // Retrieve the pending consent and verify the storage_binding holds the
    // canonical key, not the URL. Stage a full approval round-trip to get
    // the issued grant (which inherits storage_binding from the pending row).
    const consentUrl = new URL(location, asUrl);
    const requestUri = mustExist(consentUrl.searchParams.get("request_uri"), "redirect must carry request_uri");
    const ownerToken = await issueOwnerToken(asUrl);

    const authorization = `Bearer ${ownerToken}`;
    const reviewRevision = await reviewConsent(asUrl, requestUri, "owner_local", authorization);

    // POST /consent/approve
    const approveParams = new URLSearchParams();
    approveParams.set("approval_review_revision", reviewRevision);
    approveParams.set("request_uri", requestUri);
    const approveResp = await fetch(`${asUrl}/consent/approve`, {
      body: approveParams.toString(),
      headers: {
        Accept: "text/html",
        Authorization: authorization,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      method: "POST",
      redirect: "manual",
    });
    if (approveResp.status !== 302) {
      assert.fail(`expected consent approval redirect, got ${approveResp.status}: ${await approveResp.text()}`);
    }
    const codeLocation = approveResp.headers.get("location") || "";
    const codeUrl = new URL(codeLocation, asUrl);
    const code = mustExist(
      codeUrl.searchParams.get("code"),
      `redirect must carry an authorization code: ${codeLocation}`
    );
    assert.ok(code, "approval must issue an authorization code");

    // Exchange the code for a token
    const tokenParams = new URLSearchParams();
    tokenParams.set("grant_type", "authorization_code");
    tokenParams.set("code", code);
    tokenParams.set("redirect_uri", "https://client.example/callback");
    tokenParams.set("client_id", client.client_id);
    tokenParams.set("code_verifier", verifier);
    const { status: tokenStatus, body: tokenBody } = await fetchJson(`${asUrl}/oauth/token`, {
      body: tokenParams.toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    assert.equal(tokenStatus, 200, "token exchange must succeed");
    const grantId = tokenBody.grant_id;
    assert.ok(grantId, "token response must carry grant_id");

    // Inspect the issued grant source identity — must be canonical key, not URL.
    const grantResp = await fetchJson(`${asUrl}/_ref/grants/${grantId}`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    // If the endpoint doesn't exist, just verify the token came back.
    if (grantResp.status === 200) {
      const grantData = grantResp.body.data as Record<string, unknown> | undefined;
      const grant = grantData?.grant as Record<string, unknown> | undefined;
      const source = grant?.source as Record<string, unknown> | undefined;
      const sourceId = source?.id as string | undefined;
      if (sourceId) {
        assert.equal(
          sourceId.startsWith("https://"),
          false,
          `issued grant source.id MUST be a canonical key, not a URL; got: ${sourceId}`
        );
        assert.equal(sourceId, "spotify", 'issued grant source.id must be the canonical key "spotify"');
      }
    }

    // The token itself is proof the boundary normalization worked —
    // a URL-shaped connector_id that failed manifest lookup would have
    // produced a 400 "Unknown connector" or "Unknown source" error instead.
    assert.ok(tokenBody.access_token, "access token must be present, proving canonical lookup succeeded");
  } finally {
    await closeServer(server);
  }
});

test("hosted MCP picker excludes internal/test/stub connectors", async () => {
  // Connectors whose id contains test/stub/internal markers (e.g.
  // `manual_action_stub`, `pg_runtime_*`, `stream-test-stub`) must not
  // appear in the owner-facing consent picker. These are implementation
  // artifacts registered during testing; they are never user-configured
  // sources and must not show up as selectable consent targets.
  const server = await startOpenTestServer();
  const asUrl = `http://localhost:${server.asPort}`;
  try {
    await registerAuthorizedSpotify(asUrl);

    // Register a stub connector with a marker id. The AS accepts arbitrary
    // connector manifests; the picker is the surface that must filter it out.
    // The manifest must pass full validation (schema.properties, primary_key,
    // cursor_field with a compatible type) — the marker is in the connector_id.
    const stubManifest = {
      connector_id: "stream-test-stub-picker-regression",
      display_name: "Stream Test Stub",
      manifest_uri: "https://registry.pdpp.dev/connectors/stream-test-stub-picker-regression",
      protocol_version: "0.1.0",
      streams: [
        {
          cursor_field: "ts",
          name: "events",
          primary_key: ["id"],
          schema: {
            properties: {
              id: { type: "string" },
              ts: { format: "date-time", type: "string" },
            },
            type: "object",
          },
          selection: { fields: true, resources: false },
          semantics: "append_only",
        },
      ],
      version: "0.1.0",
    };
    const regResp = await fetchJson(`${asUrl}/connectors`, {
      body: JSON.stringify(stubManifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.ok(
      regResp.status === 201 || regResp.status === 200,
      `stub connector registration returned unexpected status ${regResp.status}: ${JSON.stringify(regResp.body)}`
    );
    // Seed a connection for the stub connector too, so this test proves the
    // internal-id filter itself excludes it — not merely that it has no
    // connection (which would also exclude a real, non-stub connector).
    await seedDefaultHostedInstance(stubManifest as unknown as ConnectorManifest);

    const client = await registerAuthCodeClient(asUrl);

    const model = await fetchPickerConsentModelFor({
      asUrl,
      clientId: client.client_id,
      state: "stub-filter-test",
    });

    // The picker must not expose the stub connector's id or display name
    // in any selectable row. Spotify (real connector) must still appear.
    // The row list is the model's `sources[]` now rather than the picker HTML,
    // but "selectable row" means the same thing: an entry the owner can
    // approve.
    const rendered = JSON.stringify(model.sources);
    assert.equal(
      rendered.includes("stream-test-stub"),
      false,
      "the model MUST NOT publish the internal stub connector id as a selectable source"
    );
    assert.equal(
      rendered.includes("Stream Test Stub"),
      false,
      "the model MUST NOT publish the internal stub connector display name as a selectable source"
    );
    assert.match(rendered, /spotify/i, "real connector (spotify) must still be a selectable source");
  } finally {
    await closeServer(server);
  }
});

test("sourceMetadata.display_name uses human-readable connection name, not raw cin_* id", async () => {
  // Regression for the bug where `display_name: resolvedConnectionId || null`
  // set the package member's display_name to the opaque `cin_*` connection ID
  // instead of the owner-readable name returned by `projectBindingForWire`.
  // The package member source in `_ref/grant-packages/:id` MUST carry the
  // human display name; it MUST NOT surface the raw connection ID as a label.
  const server = await startOpenTestServer();
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    const spotify = await registerSpotify(asUrl);

    // Seed a named connection for the spotify connector directly into the store.
    const instanceId = "cin_test_spotify_account";
    const humanDisplayName = "My Spotify Premium";
    const store = createSqliteConnectorInstanceStore();
    const now = new Date().toISOString();
    await store.upsert({
      connectorId: spotify.connector_id,
      connectorInstanceId: instanceId,
      createdAt: now,
      displayName: humanDisplayName,
      ownerSubjectId: "owner_local",
      sourceBinding: { account: "spotify-user@example.com" },
      sourceBindingKey: "spotify-user@example.com",
      sourceKind: "account",
      status: "active",
      updatedAt: now,
    });

    const client = await registerAuthCodeClient(asUrl);
    const verifier = randomBytes(32).toString("base64url");
    const codeChallenge = pkceChallenge(verifier);
    const state = "display-name-regression-test";

    // What moved: the owner surface is the console's now, so the mint is
    // driven through the consent-challenge accept route instead of the picker
    // form POST. The assertions on the MINTED artifact below are unchanged —
    // they are the point of this test.
    const challenge = await startPickerConsentChallenge({
      asUrl,
      clientId: client.client_id,
      codeChallenge,
      state,
    });
    const model = await fetchPickerConsentModel(asUrl, challenge);

    // The owner surface must show the connection under its human name.
    const source = mustExist(
      model.sources.find(
        (row) =>
          row.selectionValue ===
          encodeHostedMcpSelection({ connectionId: instanceId, connectorId: spotify.connector_id })
      ),
      "the model must publish a row for the named connection"
    );
    assert.equal(
      source.account,
      humanDisplayName,
      `the model MUST surface the human display name "${humanDisplayName}" as the row's account label`
    );

    // Approve the connection-scoped row whole.
    const approve = await postPickerConsentChallenge(
      asUrl,
      challenge,
      "accept",
      pickerConsentAcceptBody({
        chosen: [{ source, streams: source.streams }],
        clientId: client.client_id,
        model,
      })
    );
    assert.equal(approve.status, 200, JSON.stringify(approve.body));
    const callback = new URL(stringField(approve.body, "redirect_url"));
    const code = mustExist(callback.searchParams.get("code"), "redirect must carry an authorization code");
    assert.ok(code);

    const { body: tokenBody } = await fetchJson(`${asUrl}/oauth/token`, {
      body: new URLSearchParams({
        client_id: client.client_id,
        code,
        code_verifier: verifier,
        grant_type: "authorization_code",
        redirect_uri: "https://client.example/callback",
      }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    assert.ok(tokenBody.grant_package_id, "connection-scoped package issued");
    const grantPackageId = stringField(tokenBody, "grant_package_id");

    // Inspect the package member source — display_name MUST be the human
    // name, never the raw cin_* connection ID.
    const { status: detailStatus, body: detail } = await fetchJson(
      `${asUrl}/_ref/grant-packages/${encodeURIComponent(grantPackageId)}`
    );
    assert.equal(detailStatus, 200);
    const detailChildren = detail.children as Record<string, unknown>[];
    assert.equal(detailChildren.length, 1);
    const child = mustExist(detailChildren[0], "package detail must carry one child");
    assert.ok(child.source, "child carries a source envelope");
    const childSource = child.source as Record<string, unknown>;

    // The raw cin_* id MUST NOT appear as display_name.
    assert.notEqual(
      childSource.display_name,
      instanceId,
      "sourceMetadata.display_name MUST NOT be the raw cin_* connection ID"
    );
    // The human name MUST appear.
    assert.equal(
      childSource.display_name,
      humanDisplayName,
      "sourceMetadata.display_name MUST be the human-readable connection name"
    );
    // The connection_id IS the raw id and may appear in the source envelope —
    // but only on the dedicated connection_id field, not as display_name.
    assert.equal(
      childSource.connection_id,
      instanceId,
      "source.connection_id carries the stable connection ID for programmatic use"
    );
  } finally {
    await closeServer(server);
  }
});

test("picker renders connector type and connection name as distinct semantic elements", async () => {
  // Acceptance target: the picker must make it clear that "Claude Code" is the
  // connector *type* and "laptop Claude Code" is the *connection name* —
  // not two competing ontologies. This used to be enforced as two separate
  // HTML elements (class="hosted-ui-connector-type" and
  // class="hosted-ui-connection-name"). The console renders now, so the
  // separation is enforced one level earlier and more strongly: the model
  // carries them as two distinct FIELDS, `name` (type) and `account`
  // (connection), which no rendering can conflate back together.
  const server = await startOpenTestServer();
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    const spotify = await registerSpotify(asUrl);

    // Seed a named connection so the picker renders a connection row.
    const instanceId = "cin_test_type_vs_connection";
    const connectionDisplayName = "My Work Spotify";
    const store = createSqliteConnectorInstanceStore();
    const now = new Date().toISOString();
    await store.upsert({
      connectorId: spotify.connector_id,
      connectorInstanceId: instanceId,
      createdAt: now,
      displayName: connectionDisplayName,
      ownerSubjectId: "owner_local",
      sourceBinding: { account: "work@example.com" },
      sourceBindingKey: "work@example.com",
      sourceKind: "account",
      status: "active",
      updatedAt: now,
    });

    const client = await registerAuthCodeClient(asUrl);
    const model = await fetchPickerConsentModelFor({
      asUrl,
      clientId: client.client_id,
      state: "type-vs-connection-test",
    });

    const source = mustExist(
      model.sources.find(
        (row) =>
          row.selectionValue ===
          encodeHostedMcpSelection({ connectionId: instanceId, connectorId: spotify.connector_id })
      ),
      "the model must publish a row for the named connection"
    );

    // The connector type (Spotify display name) is its own field.
    assert.match(source.name, /Spotify/, "the connector type label must be the row's `name`");
    // The connection name is its own field, distinct from the connector type,
    // so type and instance are never ambiguous.
    assert.equal(source.account, connectionDisplayName, "the connection name must be the row's `account`");
    // The two MUST NOT be the same value — the whole point is that they are
    // distinguished.
    assert.notEqual(source.name, source.account, "connector type and connection name must be separate values");
    assert.equal(
      source.name.includes(connectionDisplayName),
      false,
      "the connector type MUST NOT contain the connection name — they must stay separate fields"
    );
  } finally {
    await closeServer(server);
  }
});

test("picker hides URL-shaped default connection labels from owner-visible copy", async () => {
  const server = await startOpenTestServer();
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    const spotify = await registerSpotify(asUrl);

    // Production/default connector instances can carry the connector URI as a
    // fallback display name. That value is useful as an identifier, but it is
    // not owner-readable copy and must not be shown next to the connector type.
    const store = createSqliteConnectorInstanceStore();
    const now = new Date().toISOString();
    await store.upsert({
      connectorId: spotify.connector_id,
      connectorInstanceId: "cin_test_url_label",
      createdAt: now,
      displayName: spotify.connector_id,
      ownerSubjectId: "owner_local",
      sourceBinding: { account: "default" },
      sourceBindingKey: "default",
      sourceKind: "account",
      status: "active",
      updatedAt: now,
    });

    const client = await registerAuthCodeClient(asUrl);
    const model = await fetchPickerConsentModelFor({
      asUrl,
      clientId: client.client_id,
      state: "url-label-test",
    });

    // What moved: "owner-visible picker text" was the visible text of the
    // rendered page; it is now the owner-facing label fields the model hands
    // the console. Opaque selection values are excluded on purpose — they are
    // machine identifiers, exactly as the form values were.
    const source = mustExist(model.sources[0], "the model must publish the seeded connection");
    assert.equal(
      /^https?:\/\//.test(String(source.account ?? "")),
      false,
      `a URL-shaped connection label must never render as owner copy: ${source.account}`
    );
    const ownerVisibleCopy = model.sources.flatMap((row) => [
      row.name,
      row.account ?? "",
      ...row.streams.flatMap((stream) => [stream.label, stream.sentence]),
    ]);
    for (const copy of ownerVisibleCopy) {
      assert.equal(
        copy.includes("https://registry.pdpp.dev/connectors/spotify"),
        false,
        `URL-shaped connector ids must not appear in owner-visible copy: ${copy}`
      );
    }
  } finally {
    await closeServer(server);
  }
});

// ─── Connection-pin: selection → enforceable grant scope ────────────────────
//
// The picker validates the owner's chosen connection, but the bug the scout
// report surfaced is that the value never reached `grant.streams[].instance_ids`.
// — it was stored only in the package member's `source_json` (audit/display),
// so a "Slack work" pick still fanned in across every Slack connection at read
// time. These tests prove the enforcement parity invariant end-to-end:
//
//   - a connection chosen among active bindings freezes `streams[].instance_ids`
//     on the persisted child grant;
//   - a single-connection grant freezes its one eligible instance (fan-in preserved,
//     no brittle stored id, no reissuance pressure);
//   - the frozen `instance_ids` set is enforced on the read path. A grant-scoped
//     read under the persisted child grant excludes the unselected sibling's
//     records (the decisive anti-Goodhart check: `source_json` alone is the
//     pre-existing bug, so we run the real fan-in resolver, not metadata);
//   - the wildcard stream case expands into streams with frozen `instance_ids`;
//   - audit metadata (`source_json.connection_id`) and the enforced grant scope
//     agree for the pinned member (no drift between shown and enforced).
//
// A custom connector with an ingestible `messages` stream lets us seed real
// records per connection and prove disclosure narrowing, which the
// spotify/github fixtures (no ingestible records) cannot.

const PIN_CONNECTOR_ID = "pin-fixture";
const PIN_SOURCE_ID = "https://registry.pdpp.dev/connectors/pin-fixture";
const PIN_STREAM = "messages";

function pinConnectorManifest(): ConnectorManifest {
  return {
    capabilities: { human_interaction: [] },
    connector_id: PIN_CONNECTOR_ID,
    display_name: "Pin Fixture Connector",
    protocol_version: "0.1.0",
    source_declaration: {
      declaration_version: "hosted-mcp.pin-fixture.v1",
      display: { name: "Pin Fixture Connector" },
      protocol_version: "0.1.0",
      publisher: { id: "https://pdpp.dev/reference-implementation/tests" },
      source: { id: PIN_SOURCE_ID, kind: "connector" },
      streams: [
        {
          consent_time_field: "received_at",
          cursor_field: "received_at",
          name: PIN_STREAM,
          primary_key: ["id"],
          schema: {
            properties: {
              id: { type: "string" },
              received_at: { format: "date-time", type: "string" },
              subject: { type: "string" },
            },
            required: ["id", "subject", "received_at"],
            type: "object",
          },
          selection: { fields: true, resources: true },
          semantics: "mutable_state",
        },
      ],
    },
    streams: [
      {
        consent_time_field: "received_at",
        cursor_field: "received_at",
        name: PIN_STREAM,
        primary_key: ["id"],
        schema: {
          properties: {
            id: { type: "string" },
            received_at: { format: "date-time", type: "string" },
            subject: { type: "string" },
          },
          required: ["id", "subject", "received_at"],
          type: "object",
        },
      },
    ],
    version: "1.0.0",
  };
}

async function registerPinConnector(asUrl: string): Promise<ConnectorManifest> {
  const manifest = pinConnectorManifest();
  const { status } = await fetchJson(`${asUrl}/connectors`, {
    body: JSON.stringify(manifest),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  assert.equal(status, 201);
  return manifest;
}

type ConnectorInstanceStore = ReturnType<typeof createSqliteConnectorInstanceStore>;

async function seedPinConnection({
  store,
  connectionId,
  displayName,
  account,
}: {
  store: ConnectorInstanceStore;
  connectionId: string;
  displayName: string;
  account: string;
}): Promise<void> {
  const now = new Date().toISOString();
  await store.upsert({
    connectorId: PIN_CONNECTOR_ID,
    connectorInstanceId: connectionId,
    createdAt: now,
    displayName,
    ownerSubjectId: "owner_local",
    sourceBinding: { account },
    sourceBindingKey: account,
    sourceKind: "account",
    status: "active",
    updatedAt: now,
  });
}

function pinRecord(id: string, subject: string, receivedAt: string): PinRecordEnvelope {
  return {
    data: { id, received_at: receivedAt, subject },
    emitted_at: receivedAt,
    key: id,
    stream: PIN_STREAM,
  };
}

// Drive the picker for a single source/connection, narrowing to `streamNames`
// (pass null to submit the whole-source wildcard via every-stream selection),
// and return the persisted package access object.
async function approvePinPackage({
  asUrl,
  client,
  connectionId,
  streamNames,
}: {
  asUrl: string;
  client: RegisteredClient;
  connectionId: string | null;
  streamNames: string[] | null;
}): Promise<GrantPackageAccess> {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = pkceChallenge(verifier);
  const state = `pin-${connectionId || "none"}`;

  const params = new URLSearchParams();
  params.append("client_id", client.client_id);
  params.append("redirect_uri", "https://client.example/callback");
  params.append("response_type", "code");
  params.append("state", state);
  params.append("code_challenge", challenge);
  params.append("code_challenge_method", "S256");
  params.append("selection", encodeHostedMcpSelection({ connectionId, connectorId: PIN_CONNECTOR_ID }));
  const names = streamNames || [PIN_STREAM];
  for (const streamName of names) {
    params.append(
      "stream",
      encodeHostedMcpStreamSelection({ connectionId, connectorId: PIN_CONNECTOR_ID, streamName })
    );
  }
  appendDecisionDigest(params, {
    clientId: client.client_id,
    sources: [{ connectionId, connectorId: PIN_CONNECTOR_ID, streamNames: names }],
  });

  const approveResp = await fetch(`${asUrl}/oauth/authorize/mcp-package`, {
    body: params.toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
    redirect: "manual",
  });
  if (approveResp.status !== 302) {
    assert.fail(`expected pin approval redirect, got ${approveResp.status}: ${await approveResp.text()}`);
  }
  const code = mustExist(
    new URL(mustExist(approveResp.headers.get("location"), "redirect must carry a Location header")).searchParams.get(
      "code"
    ),
    "redirect must carry an authorization code"
  );
  assert.ok(code);
  const { status, body } = await fetchJson(`${asUrl}/oauth/token`, {
    body: new URLSearchParams({
      client_id: client.client_id,
      code,
      code_verifier: verifier,
      grant_type: "authorization_code",
      redirect_uri: "https://client.example/callback",
    }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  assert.equal(status, 200);
  assert.ok(body.grant_package_id, "pin approval issues a package-bound token");
  return mustExist(
    await getGrantPackageAccess(stringField(body, "grant_package_id")),
    "package access must exist"
  ) as GrantPackageAccess;
}

test("hosted MCP picker freezes streams[].instance_ids for a selected sibling and enforces it on reads", async () => {
  const server = await startOpenTestServer();
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    await registerPinConnector(asUrl);
    const store = createSqliteConnectorInstanceStore();
    const connA = "cin_pin_work";
    const connB = "cin_pin_personal";
    await seedPinConnection({ account: "work@example.com", connectionId: connA, displayName: "Work", store });
    await seedPinConnection({ account: "me@example.com", connectionId: connB, displayName: "Personal", store });
    // Distinct records per connection so the read-path proof can show the
    // unselected sibling's records are excluded — not merely de-emphasised.
    await ingestRecord(
      { connector_id: PIN_CONNECTOR_ID, connector_instance_id: connA },
      pinRecord("rec-work-1", "Work first", "2026-05-18T12:00:00.000Z")
    );
    await ingestRecord(
      { connector_id: PIN_CONNECTOR_ID, connector_instance_id: connA },
      pinRecord("rec-work-2", "Work second", "2026-05-18T12:01:00.000Z")
    );
    await ingestRecord(
      { connector_id: PIN_CONNECTOR_ID, connector_instance_id: connB },
      pinRecord("rec-personal-1", "Personal first", "2026-05-18T12:02:00.000Z")
    );

    const client = await registerAuthCodeClient(asUrl);
    const access = await approvePinPackage({ asUrl, client, connectionId: connA, streamNames: [PIN_STREAM] });
    assert.equal(access.members.length, 1);
    const member = mustExist(access.members[0], "package must carry one member");

    // The persisted child grant carries the selected instance on every stream.
    const pinnedStreams = member.grant.streams.filter((s) => s.name === PIN_STREAM);
    assert.ok(pinnedStreams.length >= 1, "child grant carries the messages stream");
    for (const stream of member.grant.streams) {
      assert.deepEqual(
        stream.instance_ids,
        [connA],
        `every issued stream entry must freeze instance_ids=[${connA}]; got ${JSON.stringify(stream)}`
      );
    }

    // Criterion 3: audit/display metadata and the enforced grant scope agree.
    assert.equal(member.connection_id, connA, "package member audit metadata pins the same connection");
    assert.equal(member.source?.connection_id, connA, "source_json connection_id matches the enforced grant");

    // Criterion 2 (decisive, anti-Goodhart): run a real grant-authorized read
    // through the fan-in resolver under the PERSISTED child grant and prove the
    // unselected sibling's records are absent. Testing source_json alone would
    // reproduce the original bug as a green check.
    const { bindings } = await resolveReadRequestBindings({
      grant: member.grant,
      ownerSubjectId: "owner_local",
      requestParams: {},
      storageBinding: member.grant_storage_binding,
      streamName: PIN_STREAM,
    });
    assert.equal(bindings.length, 1, "pinned grant resolves to exactly one binding");
    assert.equal(
      mustExist(bindings[0], "must resolve at least one binding").connectorInstanceId,
      connA,
      "resolved binding is the selected connection"
    );

    const response = await queryRecordsAcrossBindings(bindings, PIN_STREAM, member.grant, {}, pinConnectorManifest());
    const returnedIds = response.data.map((r) => r.id).sort((a, b) => String(a).localeCompare(String(b)));
    assert.deepEqual(returnedIds, ["rec-work-1", "rec-work-2"], "read returns only the selected connection records");
    for (const record of response.data) {
      assert.equal(record.connection_id, connA, "every returned record is attributed to the selected connection");
      assert.notEqual(record.id, "rec-personal-1", "the unselected sibling record MUST NOT be disclosed");
    }
  } finally {
    await closeServer(server);
  }
});

test("hosted MCP picker freezes the sole eligible instance for a single-connection connector", async () => {
  const server = await startOpenTestServer();
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    await registerPinConnector(asUrl);
    const store = createSqliteConnectorInstanceStore();
    const soleConn = "cin_pin_sole";
    await seedPinConnection({ account: "sole@example.com", connectionId: soleConn, displayName: "Sole", store });
    await ingestRecord(
      { connector_id: PIN_CONNECTOR_ID, connector_instance_id: soleConn },
      pinRecord("rec-sole-1", "Sole first", "2026-05-18T12:00:00.000Z")
    );

    const client = await registerAuthCodeClient(asUrl);
    // Owner picks the only connection row. Because there is exactly one active
    // binding, this is not a disambiguating choice — the grant must stay fan-in.
    const access = await approvePinPackage({ asUrl, client, connectionId: soleConn, streamNames: [PIN_STREAM] });
    assert.equal(access.members.length, 1);
    const member = mustExist(access.members[0], "package must carry one member");

    for (const stream of member.grant.streams) {
      assert.deepEqual(
        stream.instance_ids,
        [soleConn],
        `single-connection grant must freeze its sole instance; got ${JSON.stringify(stream)}`
      );
    }

    // Fan-in over a set of one still resolves and reads the sole connection.
    const { bindings } = await resolveReadRequestBindings({
      grant: member.grant,
      ownerSubjectId: "owner_local",
      requestParams: {},
      storageBinding: member.grant_storage_binding,
      streamName: PIN_STREAM,
    });
    assert.equal(bindings.length, 1);
    assert.equal(mustExist(bindings[0], "must resolve at least one binding").connectorInstanceId, soleConn);
  } finally {
    await closeServer(server);
  }
});

test("hosted MCP picker pins the wildcard stream entry when the whole source is approved for a chosen sibling", async () => {
  const server = await startOpenTestServer();
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    const manifest = await registerPinConnector(asUrl);
    const store = createSqliteConnectorInstanceStore();
    const connA = "cin_pin_wild_a";
    const connB = "cin_pin_wild_b";
    await seedPinConnection({ account: "a@example.com", connectionId: connA, displayName: "Wild A", store });
    await seedPinConnection({ account: "b@example.com", connectionId: connB, displayName: "Wild B", store });

    const client = await registerAuthCodeClient(asUrl);
    // Submit every manifest stream for connection A → the AS emits the
    // canonical wildcard authorization detail (`{ name: "*", connection_id }`),
    // which `resolveGrantSelection` expands into the enforceable narrowed
    // wildcard: one entry per manifest stream, each carrying the connection
    // pin. Criterion 4 accepts that equivalent enforceable form.
    const allStreamNames = manifest.streams.map((s) => s.name);
    const access = await approvePinPackage({ asUrl, client, connectionId: connA, streamNames: allStreamNames });
    assert.equal(access.members.length, 1);
    const member = mustExist(access.members[0], "package must carry one member");

    // Criterion 4: the persisted grant covers every manifest stream and pins
    // the chosen connection on every entry — no stream escapes the pin.
    const grantedNames = member.grant.streams.map((s) => s.name).sort();
    assert.deepEqual(grantedNames, [...allStreamNames].sort(), "whole-source approval covers every manifest stream");
    for (const stream of member.grant.streams) {
      assert.deepEqual(
        stream.instance_ids,
        [connA],
        `wildcard-expanded stream "${stream.name}" must freeze the selected instance; got ${JSON.stringify(stream)}`
      );
    }
  } finally {
    await closeServer(server);
  }
});

// ─── Picker client-identity, purpose, and review-digest rendering ──────────
//
// Covers the consent-UI spec audit's picker-flow gaps: client identity
// (client-display:672-677), policy_uri/tos_uri secondary links
// (client-display:674), the registry purpose code (Appendix A), three-class
// semantic separation on the picker (semantic-classes:716), and the
// final-approval digest binding (AS-conformance #15).

// A ChatGPT-shaped external CIMD client: an https:// client_id metadata
// document URL resolved via network fetch (not the local
// `_ref/cimd-client-documents` same-origin store, which has no
// policy_uri/tos_uri fields — see cimd.ts's `createCimdDocument`). Injecting
// `cimdFetchDependencies` lets the test exercise the exact resolution path a
// real hosted MCP connector (ChatGPT, Claude, ...) takes without touching the
// network.
function startServerWithCimdDocFetch(doc: Record<string, unknown>) {
  return startServer({
    asPort: 0,
    cimdFetchDependencies: {
      dnsLookupImpl: async () => [{ address: "93.184.216.34", family: 4 }],
      fetchImpl: async () =>
        new Response(JSON.stringify(doc), { headers: { "Content-Type": "application/json" }, status: 200 }),
      isGlobalUnicastAddressImpl: () => true,
    },
    dbPath: ":memory:",
    ownerAuthPassword: "",
    quiet: true,
    rsPort: 0,
  }) as Promise<CloseableTestServer>;
}

// `fetchCimdDocument` caches by client_id in a module-level (process-wide)
// Map — see cimd.ts's `cimdCache`. Every test that fetches a CIMD doc MUST
// use its own unique client_id (a fresh path segment), or it will silently
// read back a different test's cached document instead of exercising its own
// fetchImpl.
function chatgptShapedClientId(): string {
  return `https://chatgpt.example/oauth/${randomBytes(6).toString("hex")}/client.json`;
}

function chatgptShapedRedirectUri(clientId: string): string {
  const url = new URL(clientId);
  return `${url.origin}/connector/oauth/${url.pathname.split("/").at(-2)}`;
}

function chatgptShapedCimdDoc(clientId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    client_id: clientId,
    client_name: "ChatGPT",
    redirect_uris: [chatgptShapedRedirectUri(clientId)],
    token_endpoint_auth_method: "none",
    ...overrides,
  };
}

// Was `fetchHostedMcpPickerHtml`. The picker branch no longer renders HTML, so
// the client-identity facts these tests assert on are read from the console's
// JSON render model instead — the same values, resolved by the same
// `buildConsentClientDisplay` call that fed the markup.
async function fetchHostedMcpPickerModel(
  asUrl: string,
  clientId: string,
  redirectUri = "https://client.example/callback"
): Promise<PickerConsentModel> {
  return await fetchPickerConsentModelFor({ asUrl, clientId, redirectUri, state: "chatgpt-shape-state" });
}

test("hosted MCP picker renders the CIMD client's resolved display name and its verified domain", async () => {
  const clientId = chatgptShapedClientId();
  const server = await startServerWithCimdDocFetch(chatgptShapedCimdDoc(clientId));
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    await registerAuthorizedSpotify(asUrl);
    const model = await fetchHostedMcpPickerModel(asUrl, clientId, chatgptShapedRedirectUri(clientId));

    // spec-core.md:673 — the resolved display name MUST be shown when
    // available; client_id is only the fallback. The header used to lead with
    // the origin and label the actual name "Self-described app name", so a
    // request from ChatGPT rendered as a URL while we held the answer.
    // What moved: the header is the console's markup, so the same precedence
    // is asserted on the fields the console is handed.
    assert.equal(model.client.name, "ChatGPT", "the model must lead with the resolved display name");
    assert.equal(model.client.domain, "chatgpt.example", "the origin stays, as its own quiet field");
    // Trust status as a neutral fact rather than an unconditional badge. This
    // client reached the picker through CIMD resolution, which means it served
    // a valid metadata document at its own https client_id — so it has proven
    // control of that domain, and the surface says exactly that much.
    assert.equal(
      model.client.trust,
      "domain",
      "a client that proved domain control must be marked distinctly (spec-core.md:675)"
    );
    // The claim never widens from the domain to the application: `domain` is a
    // narrower tier than `verified`, which only an operator registration earns.
    assert.notEqual(model.client.trust, "verified", "domain control is not an endorsement of the app");
    // The metadata-document URL never reaches the owner surface as copy.
    assert.equal(model.client.name.includes("client.json"), false);
    assert.equal(model.client.domain.includes("client.json"), false);
    // GAP: the exact owner-facing trust SENTENCE ("Verified domain:
    // chatgpt.example — this app controls that domain.") and the absence of
    // the strings "Verified app" / "Unverified app" / "Metadata document" are
    // no longer asserted here. The server now hands over the trust TIER and
    // the console writes the sentence, so the wording moved out of this suite;
    // the tier itself, which is what the wording must not overstate, is
    // asserted above.
  } finally {
    await closeServer(server);
  }
});

test("hosted MCP picker renders a text monogram, never an <img>, for client identity", async () => {
  const clientId = chatgptShapedClientId();
  const server = await startServerWithCimdDocFetch(
    chatgptShapedCimdDoc(clientId, { logo_uri: "https://chatgpt.example/logo.png" })
  );
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    await registerAuthorizedSpotify(asUrl);
    const model = await fetchHostedMcpPickerModel(asUrl, clientId, chatgptShapedRedirectUri(clientId));

    assert.equal(typeof model.client.monogram, "string", "the model must carry a monogram for client identity");
    assert.equal(
      model.client.monogram.trim(),
      "CH",
      "monogram is a two-letter mark from the RESOLVED display name (ChatGPT -> CH), matching the design system's .pdpp-monogram; a lone 'C' derived from the URL string sat in a two-letter slot"
    );

    // The forbidden remote logo fetch (client-display:676) can no longer be a
    // question of markup: assert the ABSENCE of any logo field on the model.
    // The console cannot render an <img> from a URL it was never given, and
    // the CIMD doc under test declares `logo_uri` precisely so this proves the
    // server drops it rather than merely failing to use it.
    for (const field of ["logo", "logoUri", "logo_uri", "iconUrl", "imageUrl"]) {
      assert.equal(
        Object.hasOwn(model.client, field),
        false,
        `the client identity MUST NOT carry a logo URL field (${field})`
      );
    }
    assert.equal(
      JSON.stringify(model.client).includes("logo.png"),
      false,
      "the client-supplied logo_uri must never reach the owner surface, even in another field"
    );
  } finally {
    await closeServer(server);
  }
});

test("hosted MCP picker renders CIMD policy_uri/tos_uri as secondary links when present", async () => {
  const clientId = chatgptShapedClientId();
  const server = await startServerWithCimdDocFetch(
    chatgptShapedCimdDoc(clientId, {
      policy_uri: "https://chatgpt.example/privacy",
      tos_uri: "https://chatgpt.example/terms",
    })
  );
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    await registerAuthorizedSpotify(asUrl);
    const model = await fetchHostedMcpPickerModel(asUrl, clientId, chatgptShapedRedirectUri(clientId));

    // What moved: the `<a href=...>` markup is the console's; the links
    // themselves — href and label — are the fact the server resolves.
    const byHref = new Map(model.client.policyLinks.map((link) => [link.href, link.label]));
    assert.equal(
      byHref.get("https://chatgpt.example/privacy"),
      "Privacy policy",
      "the model must publish policy_uri as a labelled link"
    );
    assert.equal(
      byHref.get("https://chatgpt.example/terms"),
      "Terms of service",
      "the model must publish tos_uri as a labelled link"
    );
  } finally {
    await closeServer(server);
  }
});

test("hosted MCP picker omits policy/tos links when the CIMD doc carries neither", async () => {
  const clientId = chatgptShapedClientId();
  const server = await startServerWithCimdDocFetch(chatgptShapedCimdDoc(clientId));
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    await registerAuthorizedSpotify(asUrl);
    const model = await fetchHostedMcpPickerModel(asUrl, clientId, chatgptShapedRedirectUri(clientId));

    assert.deepEqual(model.client.policyLinks, [], "no links should be published with no data");
  } finally {
    await closeServer(server);
  }
});

test("hosted MCP picker names the requester in its title instead of a generic app-agnostic title", async () => {
  const server = await startOpenTestServer();
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    await registerAuthorizedSpotify(asUrl);
    const client = await registerAuthCodeClient(asUrl);
    const model = await fetchHostedMcpPickerModel(asUrl, client.client_id);

    // What moved: the `<h1>` is the console's, so what is asserted is the
    // input it can only write a named title from — the resolved requester
    // name. A generic app-agnostic heading ("Choose what this app can read")
    // is exactly what a model without a real name would force.
    assert.equal(
      model.client.name,
      "Hosted MCP test client",
      "the model must name the resolved requester, not a generic stand-in"
    );
    assert.equal(model.client.name, model.client.name.trim());
    assert.notEqual(model.client.name, "This app", "the app-agnostic fallback must not be what a named client gets");
  } finally {
    await closeServer(server);
  }
});

test("hosted MCP picker renders the registry purpose code and description, not the invented personal_ai_assistant code", async () => {
  const server = await startOpenTestServer();
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    await registerAuthorizedSpotify(asUrl);
    const client = await registerAuthCodeClient(asUrl);
    const model = await fetchHostedMcpPickerModel(asUrl, client.client_id);

    // The registry code is a protocol identifier, not owner-facing copy: it
    // stays in the grant and the audit record, and the model carries it on its
    // own field so the console can keep it off the owner surface.
    assert.equal(model.purpose.code, "https://pdpp.dev/purpose/agent_context");
    assert.equal(
      model.purpose.code.includes("personal_ai_assistant"),
      false,
      "the unregistered personal_ai_assistant purpose code must never be minted"
    );
    assert.equal(
      model.purpose.description.includes("personal_ai_assistant"),
      false,
      "and it must not leak through the description either"
    );
    assert.ok(
      model.purpose.description.length > 0,
      "the purpose must carry a description, not just a code"
    );
    assert.equal(
      model.purpose.description.includes("://"),
      false,
      `the description must be prose, not a second identifier: ${model.purpose.description}`
    );
    // GAP: the picker's plain-words rewording of the purpose ("use the data
    // you select as context for your AI assistant") and the sentence naming
    // the purpose's ORIGIN ("Set by this server because <app> didn't give
    // one") are no longer asserted. Both were picker copy composed from the
    // canonical description plus the client name; the model hands the console
    // the canonical `HOSTED_MCP_PICKER_PURPOSE_DESCRIPTION` and the client
    // name, and the owner-facing rewording is now the console's to write. What
    // survives here is the protocol identity of the purpose — the part that
    // the invented `personal_ai_assistant` code got wrong.
  } finally {
    await closeServer(server);
  }
});

test("hosted MCP picker wraps stream selection and access mode in the protocol authorship class", async () => {
  const server = await startOpenTestServer();
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    await registerAuthorizedSpotify(asUrl);
    const client = await registerAuthCodeClient(asUrl);
    const model = await fetchHostedMcpPickerModel(asUrl, client.client_id);

    // GAP: authorship marking is now the console's responsibility and is not
    // asserted here. The picker used to wrap its own selection controls in a
    // `<div class="hosted-ui-authorship" data-authorship="protocol"
    // aria-label="Streams and access mode your server will enforce">` block,
    // which is how the owner could tell which terms this server enforces from
    // which are only what the app said. That block is markup the AS no longer
    // emits for this branch, and nothing on the model records the authorship
    // class of a field.
    //
    // What this test still locks is the input that marking needs: the two
    // protocol-enforced facts — the stream selection and the access mode —
    // must both be carried, and carried as protocol facts distinct from the
    // manifest-authored and client-said ones (`purpose`, `retention`), so the
    // console has something to mark and cannot mark the wrong thing.
    const streams = model.sources.flatMap((source) => source.streams);
    assert.ok(streams.length > 0, "the enforced stream selection must be published");
    assert.ok(model.accessMode.supported.length > 0, "the enforced access mode must be published");
    assert.equal(model.accessMode.value, "continuous");
    assert.equal(typeof model.retention, "string", "the recipient commitment stays a separate field");
    assert.equal(typeof model.purpose.description, "string", "as does the server-set purpose");
  } finally {
    await closeServer(server);
  }
});

test("hosted MCP grant.issued spine event carries a non-null review_digest binding the resolved decision", async () => {
  const server = await startOpenTestServer();
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    const spotify = await registerAuthorizedSpotify(asUrl);
    const client = await registerAuthCodeClient(asUrl);

    const verifier = randomBytes(32).toString("base64url");
    const state = "review-digest-state";
    const challenge = pkceChallenge(verifier);

    const params = buildHostedMcpPickerForm({
      challenge,
      client,
      sourceSelections: [{ connectorId: spotify.connector_id, streamNames: ["saved_tracks"] }],
      state,
    });

    const approveResp = await exchangePackageCode({ asUrl, client, params });
    assert.equal(approveResp.status, 302);
    const code = mustExist(
      new URL(mustExist(approveResp.headers.get("location"), "redirect must carry a Location header")).searchParams.get(
        "code"
      ),
      "redirect must carry an authorization code"
    );
    const { status, body } = await fetchJson(`${asUrl}/oauth/token`, {
      body: new URLSearchParams({
        client_id: client.client_id,
        code,
        code_verifier: verifier,
        grant_type: "authorization_code",
        redirect_uri: "https://client.example/callback",
      }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    assert.equal(status, 200);
    const access = mustExist(
      await getGrantPackageAccess(body.grant_package_id),
      "package access must exist"
    ) as GrantPackageAccess;
    const childGrantId = mustExist(access.members[0], "package must carry one member").grant.grant_id as string;

    const { status: timelineStatus, body: timeline } = await fetchJson(
      `${asUrl}/_ref/grants/${encodeURIComponent(childGrantId)}/timeline`
    );
    assert.equal(timelineStatus, 200);
    const timelineEvents = timeline.data as Record<string, unknown>[];
    const issuedEvent = mustExist(
      timelineEvents.find((e) => e.event_type === "grant.issued"),
      "child grant timeline must contain a grant.issued event"
    );
    const issuedEventData = issuedEvent.data as Record<string, unknown>;
    assert.equal(typeof issuedEventData.review_digest, "string", "grant.issued must carry a review_digest string");
    assert.match(
      issuedEventData.review_digest as string,
      /^sha256:/,
      "review_digest must be a sha256 digest binding the resolved decision"
    );
  } finally {
    await closeServer(server);
  }
});

// --- client_claims and ai_training: structurally unreachable, not silently
// --- accepted (client-claims:693, ai-training-consent:745-747) -----------
//
// CONSENT-UI-SPEC-GAP-0902.md §3/§7 found these MISSING on the hosted-MCP
// picker/package flow: `client_claims` has no field in the picker POST body
// at all (this flow is owner-driven checkbox selection, not a client-sent
// `authorization_details` payload — there is no client input channel a
// `client_claims` value could ever arrive through), and the AI-training
// explicit-consent gate can never trigger because the picker hardcodes
// `purpose_code: agent_context` for every grant it issues. Both are real
// gaps in the audit's sense (the spec describes obligations this flow
// cannot satisfy), but the fix is not "invent a field" — inventing a
// `client_claims` or `purpose_code` input on a flow the picker's own
// owner-driven selection model doesn't have would fabricate protocol
// surface no real hosted-MCP client sends, not close the gap. What IS a
// real, testable defect is a flow that silently ACCEPTS and ignores such
// fields rather than proving they have no effect — i.e. that an attacker
// (or a future client hoping this input is honored) cannot smuggle
// `client_claims` or an `ai_training` purpose into an issued grant by
// simply including them in the POST body. These tests are that proof.
test("POST /oauth/authorize/mcp-package ignores an injected client_claims field — no field exists to bind it", async () => {
  const server = await startOpenTestServer();
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    const spotify = await registerAuthorizedSpotify(asUrl);
    const client = await registerAuthCodeClient(asUrl);
    const verifier = randomBytes(32).toString("base64url");
    const state = "client-claims-injection-attempt";
    const challenge = pkceChallenge(verifier);

    const reviewDigest = await fetchHostedMcpReviewDigest(asUrl, client, state);
    const params = buildHostedMcpPickerForm({
      challenge,
      client,
      sourceSelections: [{ connectorId: spotify.connector_id, streamNames: ["saved_tracks"] }],
      state,
    });
    params.append("review_digest", reviewDigest);
    // Not a real picker field — an attempt to smuggle client-authored claims
    // through a flow that has no client_claims plumbing at all.
    params.append("client_claims", JSON.stringify({ commitments: ["injected claim"] }));

    const approveResp = await exchangePackageCode({ asUrl, client, params });
    assert.equal(
      approveResp.status,
      302,
      `an unrecognized extra field must not affect minting: ${await approveResp.clone().text()}`
    );
    const location = mustExist(approveResp.headers.get("location"), "redirect must carry a Location header");
    const code = mustExist(new URL(location).searchParams.get("code"), "redirect must carry an authorization code");

    const { status, body } = await fetchJson(`${asUrl}/oauth/token`, {
      body: new URLSearchParams({
        client_id: client.client_id,
        code,
        code_verifier: verifier,
        grant_type: "authorization_code",
        redirect_uri: "https://client.example/callback",
      }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    assert.equal(status, 200);
    const access = mustExist(
      await getGrantPackageAccess(body.grant_package_id),
      "package access must exist"
    ) as GrantPackageAccess;
    const childGrantId = mustExist(access.members[0], "package must carry one member").grant.grant_id as string;
    const { status: timelineStatus, body: timeline } = await fetchJson(
      `${asUrl}/_ref/grants/${encodeURIComponent(childGrantId)}/timeline`
    );
    assert.equal(timelineStatus, 200);
    const timelineEvents = timeline.data as Record<string, unknown>[];
    const issuedEvent = mustExist(
      timelineEvents.find((e) => e.event_type === "grant.issued"),
      "child grant timeline must contain a grant.issued event"
    );
    const issuedEventData = issuedEvent.data as Record<string, unknown>;
    assert.ok(
      JSON.stringify(issuedEventData).indexOf("injected claim") === -1,
      "an injected client_claims field must never reach the issued grant's audit event"
    );
  } finally {
    await closeServer(server);
  }
});

test("POST /oauth/authorize/mcp-package ignores an injected ai_training purpose_code — the AI-training gate cannot be bypassed on this flow", async () => {
  const server = await startOpenTestServer();
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    const spotify = await registerAuthorizedSpotify(asUrl);
    const client = await registerAuthCodeClient(asUrl);
    const verifier = randomBytes(32).toString("base64url");
    const state = "ai-training-injection-attempt";
    const challenge = pkceChallenge(verifier);

    const reviewDigest = await fetchHostedMcpReviewDigest(asUrl, client, state);
    const params = buildHostedMcpPickerForm({
      challenge,
      client,
      sourceSelections: [{ connectorId: spotify.connector_id, streamNames: ["saved_tracks"] }],
      state,
    });
    params.append("review_digest", reviewDigest);
    // Not a real picker field — the picker hardcodes HOSTED_MCP_PICKER_PURPOSE_CODE
    // (agent_context); this attempts to override it to the one purpose code
    // with a mandatory-consent requirement, with no consent checkbox submitted.
    params.append("purpose_code", "https://pdpp.dev/purpose/ai_training");

    const approveResp = await exchangePackageCode({ asUrl, client, params });
    assert.equal(
      approveResp.status,
      302,
      `an unrecognized extra field must not affect minting: ${await approveResp.clone().text()}`
    );
    const location = mustExist(approveResp.headers.get("location"), "redirect must carry a Location header");
    const code = mustExist(new URL(location).searchParams.get("code"), "redirect must carry an authorization code");

    const { status, body } = await fetchJson(`${asUrl}/oauth/token`, {
      body: new URLSearchParams({
        client_id: client.client_id,
        code,
        code_verifier: verifier,
        grant_type: "authorization_code",
        redirect_uri: "https://client.example/callback",
      }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    assert.equal(status, 200);
    const access = mustExist(
      await getGrantPackageAccess(body.grant_package_id),
      "package access must exist"
    ) as GrantPackageAccess;
    const childGrantId = mustExist(access.members[0], "package must carry one member").grant.grant_id as string;
    const { status: timelineStatus, body: timeline } = await fetchJson(
      `${asUrl}/_ref/grants/${encodeURIComponent(childGrantId)}/timeline`
    );
    assert.equal(timelineStatus, 200);
    const timelineEvents = timeline.data as Record<string, unknown>[];
    const issuedEvent = mustExist(
      timelineEvents.find((e) => e.event_type === "grant.issued"),
      "child grant timeline must contain a grant.issued event"
    );
    const issuedEventData = issuedEvent.data as Record<string, unknown>;
    assert.ok(
      JSON.stringify(issuedEventData).indexOf("ai_training") === -1,
      "an injected ai_training purpose_code must never reach the issued grant — the picker always mints its own fixed purpose"
    );
  } finally {
    await closeServer(server);
  }
});

// --- Stale-review-revision rejection (AS-conformance #15) -----------------
//
// These exercise `rejectIfHostedMcpReviewDigestStale` (as-authorize.ts): a
// picker POST that carries a `review_digest` must reproduce it from a FRESH
// re-resolve of the picker's eligibility snapshot before anything mints.

test("POST /oauth/authorize/mcp-package mints normally when the carried review_digest is unchanged", async () => {
  const server = await startOpenTestServer();
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    const spotify = await registerAuthorizedSpotify(asUrl);
    const client = await registerAuthCodeClient(asUrl);
    const verifier = randomBytes(32).toString("base64url");
    const state = "digest-happy-path";
    const challenge = pkceChallenge(verifier);

    const reviewDigest = await fetchHostedMcpReviewDigest(asUrl, client, state);
    const params = buildHostedMcpPickerForm({
      challenge,
      client,
      sourceSelections: [{ connectorId: spotify.connector_id, streamNames: ["saved_tracks"] }],
      state,
    });
    params.append("review_digest", reviewDigest);

    const approveResp = await exchangePackageCode({ asUrl, client, params });
    assert.equal(
      approveResp.status,
      302,
      `an unmodified digest must still mint and redirect exactly as before: ${await approveResp.clone().text()}`
    );
    const location = mustExist(approveResp.headers.get("location"), "redirect must carry a Location header");
    assert.ok(new URL(location).searchParams.get("code"), "redirect must carry an authorization code");
  } finally {
    await closeServer(server);
  }
});

test("POST /oauth/authorize/mcp-package rejects a tampered review_digest and mints nothing", async () => {
  const server = await startOpenTestServer();
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    const spotify = await registerAuthorizedSpotify(asUrl);
    const client = await registerAuthCodeClient(asUrl);
    const verifier = randomBytes(32).toString("base64url");
    const state = "digest-tampered";
    const challenge = pkceChallenge(verifier);

    const packageCountBefore = await countGrantPackagesForOwner();
    const params = buildHostedMcpPickerForm({
      challenge,
      client,
      sourceSelections: [{ connectorId: spotify.connector_id, streamNames: ["saved_tracks"] }],
      state,
    });
    // A well-formed but wrong digest — not merely absent. Absence is a
    // different, intentionally unchecked case (see
    // `rejectIfHostedMcpReviewDigestStale`'s doc comment).
    params.append("review_digest", "sha256:0000000000000000000000000000000000000000000000000000000000000000");

    const approveResp = await exchangePackageCode({ asUrl, client, params });
    assert.equal(approveResp.status, 400, "a tampered digest must be rejected, not redirected");
    const html = await approveResp.text();
    assert.match(
      html,
      /changed since you loaded the page/i,
      "rejection must tell the owner to review and approve again"
    );
    // The re-rendered page must carry a fresh digest for the CURRENT state,
    // not the tampered one, so the owner's next submission can succeed.
    const freshMatch = html.match(/name="review_digest" value="([^"]+)"/);
    assert.ok(freshMatch, "rejected re-render must still carry a review_digest for the current state");
    assert.notEqual(
      freshMatch?.[1],
      "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      "the re-rendered digest must not echo the tampered one back"
    );
    assert.equal(
      await countGrantPackagesForOwner(),
      packageCountBefore,
      "a rejected tampered-digest submission must not create a package"
    );
  } finally {
    await closeServer(server);
  }
});

test("POST /oauth/authorize/mcp-package rejects a stale review_digest after a connection is revoked mid-flow, mints nothing", async () => {
  const server = await startOpenTestServer();
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    const spotify = await registerAuthorizedSpotify(asUrl);
    const client = await registerAuthCodeClient(asUrl);
    const verifier = randomBytes(32).toString("base64url");
    const state = "digest-drift-revoked";
    const challenge = pkceChallenge(verifier);

    // Owner loads the picker: spotify is offered because its default hosted
    // instance is active.
    const reviewDigest = await fetchHostedMcpReviewDigest(asUrl, client, state);

    // Between page-load and submission, the owner's spotify connection is
    // revoked (e.g. from another tab, or an automated policy). The picker's
    // eligibility snapshot has now genuinely changed.
    await createSqliteConnectorInstanceStore().upsert({
      connectorId: spotify.connector_id,
      connectorInstanceId: defaultHostedInstanceId(spotify.connector_id),
      createdAt: new Date().toISOString(),
      displayName: "spotify test account",
      ownerSubjectId: "owner_local",
      sourceBinding: { fixture: defaultHostedInstanceId(spotify.connector_id) },
      sourceBindingKey: defaultHostedInstanceId(spotify.connector_id),
      sourceKind: "account",
      status: "revoked",
      updatedAt: new Date().toISOString(),
    });

    const packageCountBefore = await countGrantPackagesForOwner();
    const params = buildHostedMcpPickerForm({
      challenge,
      client,
      sourceSelections: [{ connectorId: spotify.connector_id, streamNames: ["saved_tracks"] }],
      state,
    });
    params.append("review_digest", reviewDigest);

    const approveResp = await exchangePackageCode({ asUrl, client, params });
    assert.equal(approveResp.status, 400, "a request that drifted from what was rendered must be rejected");
    const html = await approveResp.text();
    assert.match(
      html,
      /changed since you loaded the page/i,
      "rejection must tell the owner the request changed since page-load"
    );
    assert.equal(
      await countGrantPackagesForOwner(),
      packageCountBefore,
      "a rejected drifted submission must not create a package"
    );
  } finally {
    await closeServer(server);
  }
});

// --- Instance branding (PDPP_INSTANCE_NAME) --------------------------------

// DELETED: "hosted MCP picker headers the configured instance name alone, with
// PDPP as a footer attribution".
//
// Everything it asserted was the shared server-rendered page chrome — the
// `<title>`, the `hosted-ui-provider` header label, the absence of an operator
// monogram and of a `hosted-ui-wordmark` PDPP header, and the "Secured by
// PDPP" footer attribution. The picker branch renders no page, and the render
// model carries no provider name at all (the console reads the instance name
// from its own configuration), so there is no surface here to assert against.
//
// Nothing it covered is orphaned. The identical chrome contract is held
// against the shared helpers by `hosted-ui.test.ts` ("no protocol wordmark in
// the header" / "header carries the instance name" / "PDPP attribution moves
// to the footer") and by `hosted-ui-theme-and-mark.test.ts`
// ("renderBrandFooter: links Secured by PDPP to https://pdpp.dev"). This test
// was the picker page's instance of that same contract.
//
// GAP: nothing asserts that the CONSENT screen specifically is branded with
// the operator rather than the protocol. That claim now has to be made against
// the console, which is where the screen lives.

// --- Refusal (RFC 6749 §4.1.2.1) -------------------------------------------
//
// Before the cancel route existed, the picker had 59 buttons and every one of
// them was affirmative. The only way out was to close the tab, which leaves
// the client waiting for a response that never arrives — and no code path in
// the reference implementation could return an OAuth error to a client at
// all (both redirect builders set only `code` and `state`).
//
// `/consent/deny` exists, but it operates on a pending-consent row the picker
// flow never writes, so it cannot serve this surface.

test("POST /oauth/authorize/mcp-package/cancel redirects with error=access_denied and the original state", async () => {
  const server = await startOpenTestServer();
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    await registerAuthorizedSpotify(asUrl);
    const client = await registerAuthCodeClient(asUrl);
    const state = "refusal-state";
    const packageCountBefore = await countGrantPackagesForOwner();

    const params = new URLSearchParams();
    params.append("client_id", client.client_id);
    params.append("redirect_uri", "https://client.example/callback");
    params.append("state", state);
    params.append("decision", "cancel");

    const resp = await fetch(`${asUrl}/oauth/authorize/mcp-package/cancel`, {
      body: params.toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
      redirect: "manual",
    });

    assert.equal(resp.status, 302, "refusal must redirect the owner back to the client");
    const location = new URL(
      mustExist(resp.headers.get("location"), "refusal redirect must carry a Location header")
    );
    assert.equal(location.origin, "https://client.example");
    assert.equal(location.pathname, "/callback");
    assert.equal(location.searchParams.get("error"), "access_denied", "RFC 6749 §4.1.2.1 error code");
    assert.equal(location.searchParams.get("state"), state, "the client's state must round-trip");
    assert.equal(location.searchParams.get("code"), null, "a refusal must never carry an authorization code");

    assert.equal(
      await countGrantPackagesForOwner(),
      packageCountBefore,
      "a refusal must mint nothing"
    );
  } finally {
    await closeServer(server);
  }
});

test("POST /oauth/authorize/mcp-package/cancel refuses to redirect to an unregistered redirect_uri", async () => {
  // The refusal echoes the client's own redirect_uri back as a redirect
  // target, so it must be validated exactly as hard as an approval is. An
  // unregistered URI is an open-redirect vector whether it carries a code or
  // an error.
  const server = await startOpenTestServer();
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    await registerAuthorizedSpotify(asUrl);
    const client = await registerAuthCodeClient(asUrl);

    const params = new URLSearchParams();
    params.append("client_id", client.client_id);
    params.append("redirect_uri", "https://attacker.example/steal");
    params.append("state", "open-redirect-attempt");
    params.append("decision", "cancel");

    const resp = await fetch(`${asUrl}/oauth/authorize/mcp-package/cancel`, {
      body: params.toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
      redirect: "manual",
    });

    assert.equal(resp.status, 400, "an unregistered redirect_uri must be rejected, not redirected to");
    assert.equal(resp.headers.get("location"), null, "no redirect to an unregistered origin, error or otherwise");
    const body = (await resp.json()) as Record<string, unknown>;
    assert.equal(body.error, "invalid_request");
  } finally {
    await closeServer(server);
  }
});

test("POST /oauth/authorize/mcp-package/cancel rejects an unknown client without redirecting", async () => {
  const server = await startOpenTestServer();
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    const params = new URLSearchParams();
    params.append("client_id", "https://not-registered.example/client.json");
    params.append("redirect_uri", "https://client.example/callback");
    params.append("state", "unknown-client");
    params.append("decision", "cancel");

    const resp = await fetch(`${asUrl}/oauth/authorize/mcp-package/cancel`, {
      body: params.toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
      redirect: "manual",
    });

    assert.equal(resp.status, 400);
    assert.equal(resp.headers.get("location"), null, "an unknown client gets no redirect");
    const body = (await resp.json()) as Record<string, unknown>;
    // A URL-shaped client_id is resolved as a CIMD document first, so the
    // typed failure is whichever resolution step rejects it. What matters
    // here is that an unresolvable client never becomes a redirect target.
    assert.ok(
      body.error === "invalid_client" || body.error === "cimd_fetch_failed",
      `refusal must fail closed on an unresolvable client, got ${JSON.stringify(body)}`
    );
  } finally {
    await closeServer(server);
  }
});

test("the picker renders Cancel as a first-class action beside Allow", async () => {
  const server = await startOpenTestServer();
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    await registerAuthorizedSpotify(asUrl);
    const client = await registerAuthCodeClient(asUrl);
    const state = "cancel-is-first-class";
    const packageCountBefore = await countGrantPackagesForOwner();

    // GAP: the picker's own Cancel button — that it posts to the refusal
    // route, is labelled "Cancel" and not "Deny", sits beside "Allow access",
    // carries `formnovalidate`, and is let through by the submit guard's
    // `event.submitter.value === "cancel"` check — is markup and script the AS
    // no longer emits. Whether the console gives refusal equal billing cannot
    // be asserted from here.
    //
    // What this test still locks is the guarantee that made the button
    // possible: refusal must be reachable on the SAME artifact as approval,
    // with no selection made and nothing minted. A challenge the owner has
    // done nothing with must be refusable, and the client must be told.
    const challenge = await startPickerConsentChallenge({ asUrl, clientId: client.client_id, state });

    const { status, body } = await postPickerConsentChallenge(asUrl, challenge, "reject", {});

    assert.equal(status, 200, JSON.stringify(body));
    const redirectUrl = new URL(stringField(body, "redirect_url"));
    assert.equal(
      redirectUrl.searchParams.get("error"),
      "access_denied",
      "declining is answered as a refusal, not an error the owner caused"
    );
    assert.equal(redirectUrl.searchParams.get("state"), state, "the client's state round-trips on a refusal");
    assert.equal(redirectUrl.searchParams.get("code"), null, "a refusal must never carry an authorization code");
    assert.equal(
      await countGrantPackagesForOwner(),
      packageCountBefore,
      "refusing with nothing selected mints nothing"
    );
  } finally {
    await closeServer(server);
  }
});

// --- The approval artifact and its binding (spec-core.md:873-885) ----------
//
// AS-conformance #15 requires the approval to bind to an immutable review
// revision or digest over the authorization DECISION fields, and requires a
// stale review to fail. Two digests existed and neither did that:
//
//   `review_digest` covers what the GET rendered as *choosable*, so checking
//   three streams or thirty produced an identical value — it detects drift in
//   the menu and is blind to the order. Its handler also opened with
//   `if (!carriedDigest) return false;`, so omitting the field skipped the
//   check rather than failing it.
//
//   `computeHostedMcpPickerReviewDigest` does cover the exact selection, but
//   is computed server-side AFTER the POST; its own comment concedes it
//   "cannot itself reject anything stale, because nothing is compared
//   against it".
//
// So no page in this flow was the approval artifact. These tests pin the one
// that is: `decision_digest`, submitted by the owner over the terms the
// review panel displayed, recomputed server-side from the decision actually
// resolved, and failing closed when absent.

test("the picker renders a live summary of the decision as the approval artifact", async () => {
  const server = await startOpenTestServer();
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    await registerAuthorizedSpotify(asUrl);
    const client = await registerAuthCodeClient(asUrl);
    const state = "approval-artifact-binding";
    const challenge = await startPickerConsentChallenge({ asUrl, clientId: client.client_id, state });
    const model = await fetchPickerConsentModel(asUrl, challenge);
    const source = mustExist(model.sources[0], "the model must publish a source to approve");
    assert.ok(source.streams.length >= 2, `this test needs a source with at least two streams: ${source.streams.length}`);
    const packageCountBefore = await countGrantPackagesForOwner();

    // What moved: the review panel ("What you're allowing", its empty state,
    // the scope/duration/expiry/retention lines) is composed by the console
    // now, so there is no server-rendered summary to read. The GUARANTEE the
    // panel existed to serve is unchanged and is what this asserts: the
    // decision the owner approved is BOUND, so an approval whose digest does
    // not cover what is actually being granted mints nothing.
    //
    // The digest here is computed over ONE stream while the submission asks
    // for TWO — exactly the drift a live summary is supposed to make visible,
    // and the case where a summary that lied would otherwise mint silently.
    const submittedStreams = source.streams.slice(0, 2);
    const wrongDigest = computeHostedMcpDecisionDigest({
      accessMode: "continuous",
      clientId: client.client_id,
      sources: [{ sourceKey: source.id, streamNames: [mustExist(submittedStreams[0], "stream").name] }],
    });

    const { status, body } = await postPickerConsentChallenge(asUrl, challenge, "accept", {
      access_mode: "continuous",
      decision_digest: wrongDigest,
      grant_expiry: model.grantExpiry.defaultId,
      review_digest: model.reviewDigest,
      source_id: [source.id],
      stream: submittedStreams.map((stream) => stream.id),
    });

    assert.equal(status, 400, JSON.stringify(body));
    assert.equal(typeof body.error, "string", "the rejection is a typed error, not a silent mint");
    assert.equal(
      await countGrantPackagesForOwner(),
      packageCountBefore,
      "an approval that does not bind the decision it grants must mint nothing"
    );

    // Positive control: the guard is a binding, not a blanket refusal. The
    // same submission with a digest that DOES cover it mints.
    const secondChallenge = await startPickerConsentChallenge({
      asUrl,
      clientId: client.client_id,
      state: `${state}-bound`,
    });
    const secondModel = await fetchPickerConsentModel(asUrl, secondChallenge);
    const secondSource = mustExist(secondModel.sources[0], "the model must publish a source to approve");
    const bound = await postPickerConsentChallenge(
      asUrl,
      secondChallenge,
      "accept",
      pickerConsentAcceptBody({
        chosen: [{ source: secondSource, streams: secondSource.streams.slice(0, 2) }],
        clientId: client.client_id,
        model: secondModel,
      })
    );
    assert.equal(bound.status, 200, JSON.stringify(bound.body));
    assert.equal(
      await countGrantPackagesForOwner(),
      packageCountBefore + 1,
      "a correctly bound approval mints exactly one package"
    );
  } finally {
    await closeServer(server);
  }
});

test("POST /oauth/authorize/mcp-package rejects a submission carrying NO decision_digest and mints nothing", async () => {
  // The specific fail-open this closes: an approval that never claimed to
  // have reviewed anything is exactly the approval that must not mint.
  const server = await startOpenTestServer();
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    const spotify = await registerAuthorizedSpotify(asUrl);
    const client = await registerAuthCodeClient(asUrl);
    const packageCountBefore = await countGrantPackagesForOwner();

    const params = buildHostedMcpPickerForm({
      challenge: pkceChallenge(randomBytes(32).toString("base64url")),
      client,
      sourceSelections: [{ connectorId: spotify.connector_id, streamNames: ["saved_tracks"] }],
      state: "no-decision-digest",
    });
    params.delete("decision_digest");

    const resp = await fetch(`${asUrl}/oauth/authorize/mcp-package`, {
      body: params.toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
      redirect: "manual",
    });

    assert.equal(resp.status, 400, "an unbound approval must not mint");
    assert.equal(resp.headers.get("location"), null, "no redirect, so no authorization code reaches the client");
    const html = await resp.text();
    assert.match(
      html,
      /We couldn&#39;t confirm what you approved/,
      "the owner is sent back to review, not silently approved"
    );
    assert.equal(await countGrantPackagesForOwner(), packageCountBefore, "nothing was minted");
  } finally {
    await closeServer(server);
  }
});

test("POST /oauth/authorize/mcp-package rejects a decision_digest that does not cover the submitted streams", async () => {
  // The mutation the old snapshot digest could not see: same menu, different
  // order. The owner reviews one stream; the submission carries two. The
  // digest must not still match.
  const server = await startOpenTestServer();
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    const spotify = await registerAuthorizedSpotify(asUrl);
    const client = await registerAuthCodeClient(asUrl);
    const packageCountBefore = await countGrantPackagesForOwner();

    const params = buildHostedMcpPickerForm({
      challenge: pkceChallenge(randomBytes(32).toString("base64url")),
      client,
      sourceSelections: [{ connectorId: spotify.connector_id, streamNames: ["saved_tracks"] }],
      state: "widened-after-review",
    });
    // The digest above binds `saved_tracks` alone. Now widen what is actually
    // submitted, exactly as a tampered or stale form would.
    params.append(
      "stream",
      encodeHostedMcpStreamSelection({
        connectionId: null,
        connectorId: spotify.connector_id,
        streamName: "top_artists",
      })
    );

    const resp = await fetch(`${asUrl}/oauth/authorize/mcp-package`, {
      body: params.toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
      redirect: "manual",
    });

    assert.equal(resp.status, 400, "a decision wider than the one reviewed must not mint");
    assert.equal(resp.headers.get("location"), null, "no authorization code reaches the client");
    assert.match(await resp.text(), /This request changed since you reviewed it/);
    assert.equal(await countGrantPackagesForOwner(), packageCountBefore, "nothing was minted");
  } finally {
    await closeServer(server);
  }
});

test("POST /oauth/authorize/mcp-package rejects a decision_digest computed for a different access mode", async () => {
  // Access mode is a decision field (spec-core.md:873-877), so flipping the
  // radio after review must invalidate the binding. The old snapshot digest
  // hashed the *set of available modes*, so this mutation was invisible to it.
  const server = await startOpenTestServer();
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    const spotify = await registerAuthorizedSpotify(asUrl);
    const client = await registerAuthCodeClient(asUrl);
    const packageCountBefore = await countGrantPackagesForOwner();

    const params = buildHostedMcpPickerForm({
      accessMode: "single_use",
      challenge: pkceChallenge(randomBytes(32).toString("base64url")),
      client,
      sourceSelections: [{ connectorId: spotify.connector_id, streamNames: ["saved_tracks"] }],
      state: "access-mode-flipped",
    });
    // Reviewed as single_use; submitted as continuous.
    params.set("access_mode", "continuous");

    const resp = await fetch(`${asUrl}/oauth/authorize/mcp-package`, {
      body: params.toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
      redirect: "manual",
    });

    assert.equal(resp.status, 400, "a mode the owner did not review must not mint");
    assert.equal(await countGrantPackagesForOwner(), packageCountBefore, "nothing was minted");
  } finally {
    await closeServer(server);
  }
});

test("POST /oauth/authorize/mcp-package mints when the decision_digest matches the resolved decision", async () => {
  // The positive control: the guard must not be a blanket refusal.
  const server = await startOpenTestServer();
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    const spotify = await registerAuthorizedSpotify(asUrl);
    const client = await registerAuthCodeClient(asUrl);
    const packageCountBefore = await countGrantPackagesForOwner();

    const params = buildHostedMcpPickerForm({
      challenge: pkceChallenge(randomBytes(32).toString("base64url")),
      client,
      sourceSelections: [{ connectorId: spotify.connector_id, streamNames: ["saved_tracks"] }],
      state: "bound-approval",
    });

    const resp = await fetch(`${asUrl}/oauth/authorize/mcp-package`, {
      body: params.toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
      redirect: "manual",
    });

    assert.equal(resp.status, 302, "a correctly bound approval mints and redirects");
    const callback = new URL(mustExist(resp.headers.get("location"), "must carry a Location header"));
    assert.ok(callback.searchParams.get("code"), "the client receives an authorization code");
    assert.equal(
      await countGrantPackagesForOwner(),
      packageCountBefore + 1,
      "exactly one package is minted"
    );
  } finally {
    await closeServer(server);
  }
});

// ─── Consent challenge API (console-rendered consent screen) ────────────────
//
// `GET /oauth/authorize` no longer renders the picker HTML for the hosted-MCP
// branch. It parks the authorize params under an opaque `cc_...` challenge id
// and redirects the owner to the console, which fetches a JSON render model
// and posts the decision back. The tests below drive that handoff end to end.

/** A ChatGPT-shaped authorize request for the hosted-MCP picker branch: no
 * `authorization_details` and no `connector_id`, so the owner picks. */
/**
 * The registered redirect for these clients, and one FIXED PKCE verifier for
 * the whole challenge-flow group.
 *
 * Fixed rather than per-call because a test that completes the flow has to
 * present the matching verifier at the token endpoint, and a helper that
 * generated one internally left no way to. PKCE's security property is that
 * the verifier never leaves the client; a constant in a test file is a client
 * that keeps its secret perfectly well.
 */
const HOSTED_MCP_REDIRECT_URI = "https://client.example/callback";
const consentChallengeVerifier = "vk9Xr2Lt7QpZ3mNb8sYd1FhJ4cWa6TgE0uKiOvRxSzB";

function hostedMcpAuthorizeUrl(asUrl: string, client: RegisteredClient, state: string): URL {
  const url = new URL(`${asUrl}/oauth/authorize`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", client.client_id);
  url.searchParams.set("redirect_uri", HOSTED_MCP_REDIRECT_URI);
  url.searchParams.set("code_challenge", pkceChallenge(consentChallengeVerifier));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("resource", `${asUrl}/mcp`);
  url.searchParams.set("state", state);
  url.searchParams.set("ui_locales", "en-US");
  return url;
}

interface ConsentChallengeModelStream {
  fieldsTotal: number;
  id: string;
  label: string;
  name: string;
  selected: boolean;
  selectionValue: string;
  sentence: string;
  timePhrase?: string;
}

interface ConsentChallengeModelSource {
  account: string | null;
  icon: unknown;
  id: string;
  name: string;
  selectionValue: string;
  streams: ConsentChallengeModelStream[];
}

interface ConsentChallengeModel {
  accessMode: { supported: string[]; value: string };
  challenge: string;
  client: { domain: string; monogram: string; name: string; policyLinks: unknown[]; trust: string };
  grantExpiry: { defaultId: string; options: Array<{ days: number; id: string; label: string }> };
  purpose: { code: string; description: string };
  retention: string;
  reviewDigest: string;
  sources: ConsentChallengeModelSource[];
}

/** Follows the picker branch's 302 and returns the minted challenge id. */
async function startConsentChallenge(asUrl: string, client: RegisteredClient, state: string): Promise<string> {
  const resp = await fetch(hostedMcpAuthorizeUrl(asUrl, client, state), { redirect: "manual" });
  assert.equal(resp.status, 302, "the picker branch hands off to the console");
  const location = new URL(mustExist(resp.headers.get("location"), "must carry a Location header"));
  return mustExist(location.searchParams.get("challenge"), "the redirect must name a challenge");
}

async function fetchConsentChallengeModel(asUrl: string, challenge: string): Promise<ConsentChallengeModel> {
  const { status, body } = await fetchJson(`${asUrl}/oauth/authorize/consent-challenges/${challenge}`);
  assert.equal(status, 200, JSON.stringify(body));
  return body as unknown as ConsentChallengeModel;
}

/**
 * Posts a decision the way the console does. `decision_digest` is the
 * CONSOLE's commitment to what it displayed — the accept route never
 * recomputes it — so it is computed here from the chosen sources exactly as
 * `buildHostedMcpPickerForm` does for the form path.
 */
function consentChallengeAcceptBody({
  model,
  client,
  chosen,
  accessMode = "continuous",
  reviewDigest,
  streamRanges,
}: {
  model: ConsentChallengeModel;
  client: RegisteredClient;
  chosen: Array<{ source: ConsentChallengeModelSource; streams: ConsentChallengeModelStream[] }>;
  accessMode?: string;
  reviewDigest?: string;
  /**
   * Per-stream data time range, keyed by the model's own `stream.id`. This is
   * the DATA range (`StreamGrant.time_constraint`), not grant validity — the
   * two are orthogonal (spec-core.md:889) and `grant_expiry` above carries the
   * other one.
   */
  streamRanges?: Record<string, { since?: string; until?: string }>;
}): Record<string, unknown> {
  return {
    access_mode: accessMode,
    decision_digest: computeHostedMcpDecisionDigest({
      accessMode,
      clientId: client.client_id,
      sources: chosen.map(({ source, streams }) => ({
        sourceKey: source.id,
        streamNames: streams.map((stream) => stream.name).sort(),
      })),
    }),
    grant_expiry: model.grantExpiry.defaultId,
    review_digest: reviewDigest ?? model.reviewDigest,
    source_id: chosen.map(({ source }) => source.id),
    stream: chosen.flatMap(({ streams }) => streams.map((stream) => stream.id)),
    ...(streamRanges ? { stream_range: streamRanges } : {}),
  };
}

/**
 * The `time_constraint` the issued child grant recorded for one stream.
 *
 * Reads the PERSISTED GRANT via `getGrantPackageAccess` — the same record the
 * `/mcp` read path consults — rather than an owner-facing summary endpoint.
 * `time_constraint` is a property of the child grant's resolved stream
 * selection, stamped with the manifest's own `consent_time_field`, and this
 * asserts on what enforcement will actually honor.
 *
 * Returns null when the stream carries no bound, so "the owner chose no range"
 * and "the range was dropped on the way" stay distinguishable by the caller
 * instead of being collapsed here.
 */
async function issuedStreamTimeConstraint(
  grantPackageId: string,
  streamName: string
): Promise<{ field?: string; since?: string; until?: string } | null> {
  const access = await getGrantPackageAccess(grantPackageId);
  assert.ok(access, `package ${grantPackageId} must be readable`);
  const members = (access.members ?? []) as Record<string, unknown>[];
  assert.equal(members.length, 1, `expected exactly one child grant: ${JSON.stringify(members)}`);
  const grant = mustExist(members[0], "package must carry one member").grant as Record<string, unknown>;
  const streams = (grant.streams ?? []) as Record<string, unknown>[];
  const stream = streams.find((entry) => entry.name === streamName);
  assert.ok(stream, `the issued grant must carry stream ${streamName}: ${JSON.stringify(streams)}`);
  return (stream.time_constraint as { field?: string; since?: string; until?: string } | null) ?? null;
}

function postConsentChallenge(
  asUrl: string,
  challenge: string,
  action: "accept" | "reject",
  body: Record<string, unknown>
): Promise<JsonResponse> {
  return fetchJson(`${asUrl}/oauth/authorize/consent-challenges/${challenge}/${action}`, {
    body: JSON.stringify(body),
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    method: "POST",
  });
}

// Locks the handoff itself: the picker branch must stop rendering HTML and
// instead park the request under a `cc_` challenge the console can fetch.
test("GET /oauth/authorize redirects the picker branch to the console consent challenge", async () => {
  const server = await startOpenTestServer();
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    await registerAuthorizedSpotify(asUrl);
    const client = await registerAuthCodeClient(asUrl);

    const resp = await fetch(hostedMcpAuthorizeUrl(asUrl, client, "handoff-state"), { redirect: "manual" });

    assert.equal(resp.status, 302, "the picker branch redirects instead of rendering HTML");
    const location = new URL(mustExist(resp.headers.get("location"), "must carry a Location header"));
    assert.equal(location.host, "localhost:3000", "the owner is sent to the console");
    assert.equal(location.pathname, "/consent", "the console renders the consent screen");
    const challenge = mustExist(location.searchParams.get("challenge"), "the redirect must name a challenge");
    assert.ok(challenge.startsWith("cc_"), `challenge id must be opaque and prefixed: ${challenge}`);
  } finally {
    await closeServer(server);
  }
});

// Locks the render model contract the console draws from: client identity,
// purpose, retention, every eligible source, stable stream ids, and the
// picker's "nothing pre-selected" default.
test("the consent challenge model carries the client, purpose, retention, and every eligible source", async () => {
  const server = await startOpenTestServer();
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    await registerAuthorizedSpotify(asUrl);
    await registerAuthorizedGithub(asUrl);
    const client = await registerAuthCodeClient(asUrl);
    const challenge = await startConsentChallenge(asUrl, client, "model-state");

    const model = await fetchConsentChallengeModel(asUrl, challenge);

    assert.equal(model.challenge, challenge, "the model names the challenge it answers for");
    assert.equal(model.client.name, "Hosted MCP test client", "the registered client_name is displayed");
    assert.equal(model.purpose.code, "https://pdpp.dev/purpose/agent_context");
    assert.equal(typeof model.retention, "string");
    assert.ok(model.retention.length > 0, "retention must be a rendered sentence, not empty");
    assert.ok(
      model.retention.includes(model.client.name),
      `retention must name the client: ${model.retention}`
    );
    assert.ok(model.sources.length >= 2, `both registered sources are eligible: ${model.sources.length}`);

    const streams = model.sources.flatMap((source) => source.streams);
    assert.ok(streams.length >= 2, `vacuity guard: the model must publish streams to check (${streams.length})`);
    for (const source of model.sources) {
      for (const stream of source.streams) {
        assert.equal(stream.selected, false, `the picker pre-selects nothing: ${stream.id}`);
        assert.equal(stream.id, `${source.id}:${stream.name}`, "stream ids are scoped to their source key");
      }
    }
  } finally {
    await closeServer(server);
  }
});

// Locks the mint path: a console decision carrying a correct decision digest
// mints exactly one package and hands the client redirect back as JSON.
test("accepting a consent challenge mints the package and returns the client redirect", async () => {
  const server = await startOpenTestServer();
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    await registerAuthorizedSpotify(asUrl);
    const client = await registerAuthCodeClient(asUrl);
    const challenge = await startConsentChallenge(asUrl, client, "accept-state");
    const model = await fetchConsentChallengeModel(asUrl, challenge);
    const source = mustExist(model.sources[0], "the model must publish a source to approve");
    const stream = mustExist(source.streams[0], "the source must publish a stream to approve");
    const packageCountBefore = await countGrantPackagesForOwner();

    const { status, body } = await postConsentChallenge(
      asUrl,
      challenge,
      "accept",
      consentChallengeAcceptBody({ chosen: [{ source, streams: [stream] }], client, model })
    );

    assert.equal(status, 200, JSON.stringify(body));
    const redirectUrl = stringField(body, "redirect_url");
    assert.ok(redirectUrl.includes("code="), `the client receives an authorization code: ${redirectUrl}`);
    assert.ok(redirectUrl.includes("accept-state"), `the original state is returned: ${redirectUrl}`);
    assert.equal(
      await countGrantPackagesForOwner(),
      packageCountBefore + 1,
      "exactly one package is minted"
    );
  } finally {
    await closeServer(server);
  }
});

// Locks single-use consumption: the challenge is deleted before minting, so a
// replayed accept cannot issue a second grant for one authorize request.
test("a consent challenge is single-use: the second accept 404s and mints nothing", async () => {
  const server = await startOpenTestServer();
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    await registerAuthorizedSpotify(asUrl);
    const client = await registerAuthCodeClient(asUrl);
    const challenge = await startConsentChallenge(asUrl, client, "replay-state");
    const model = await fetchConsentChallengeModel(asUrl, challenge);
    const source = mustExist(model.sources[0], "the model must publish a source to approve");
    const stream = mustExist(source.streams[0], "the source must publish a stream to approve");
    const acceptBody = consentChallengeAcceptBody({ chosen: [{ source, streams: [stream] }], client, model });
    const packageCountBefore = await countGrantPackagesForOwner();

    const first = await postConsentChallenge(asUrl, challenge, "accept", acceptBody);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const packageCountAfterFirst = await countGrantPackagesForOwner();
    assert.equal(packageCountAfterFirst, packageCountBefore + 1, "the first accept mints once");

    const replay = await postConsentChallenge(asUrl, challenge, "accept", acceptBody);

    assert.equal(replay.status, 404, JSON.stringify(replay.body));
    assert.equal(replay.body.error, "not_found", "a consumed challenge is indistinguishable from an unknown one");
    assert.equal(
      await countGrantPackagesForOwner(),
      packageCountAfterFirst,
      "the replay mints nothing"
    );
  } finally {
    await closeServer(server);
  }
});

// Locks the refusal path (RFC 6749 §4.1.2.1): declining must return
// `error=access_denied` and the original state to the client, minting nothing.
test("rejecting a consent challenge denies the client and mints nothing", async () => {
  const server = await startOpenTestServer();
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    await registerAuthorizedSpotify(asUrl);
    const client = await registerAuthCodeClient(asUrl);
    const challenge = await startConsentChallenge(asUrl, client, "reject-state");
    const packageCountBefore = await countGrantPackagesForOwner();

    const { status, body } = await postConsentChallenge(asUrl, challenge, "reject", {});

    assert.equal(status, 200, JSON.stringify(body));
    const redirectUrl = stringField(body, "redirect_url");
    assert.ok(redirectUrl.includes("error=access_denied"), `the client is told the owner declined: ${redirectUrl}`);
    assert.ok(redirectUrl.includes("reject-state"), `the original state is returned: ${redirectUrl}`);
    assert.equal(
      await countGrantPackagesForOwner(),
      packageCountBefore,
      "a refusal mints nothing"
    );
  } finally {
    await closeServer(server);
  }
});

// Locks the translation guarantee: `source_id` is mapped against the model the
// server resolves fresh, so an id the model never published maps to nothing.
// It can only narrow the grant, never widen it — here it narrows to empty,
// which the approval path must refuse.
test("a tampered source_id on a consent challenge cannot widen the grant beyond the model", async () => {
  const server = await startOpenTestServer();
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    await registerAuthorizedSpotify(asUrl);
    const client = await registerAuthCodeClient(asUrl);
    const challenge = await startConsentChallenge(asUrl, client, "tamper-state");
    const model = await fetchConsentChallengeModel(asUrl, challenge);
    const forgedSourceId = "chase:not-a-real-source";
    assert.ok(
      !model.sources.some((source) => source.id === forgedSourceId),
      "the forged id must genuinely be absent from the model"
    );
    const packageCountBefore = await countGrantPackagesForOwner();

    const { status, body } = await postConsentChallenge(asUrl, challenge, "accept", {
      access_mode: "continuous",
      decision_digest: computeHostedMcpDecisionDigest({
        accessMode: "continuous",
        clientId: client.client_id,
        sources: [{ sourceKey: forgedSourceId, streamNames: [] }],
      }),
      grant_expiry: model.grantExpiry.defaultId,
      review_digest: model.reviewDigest,
      source_id: [forgedSourceId],
      stream: [`${forgedSourceId}:anything`],
    });

    assert.equal(status, 400, JSON.stringify(body));
    assert.equal(typeof body.error, "string", "these routes answer in JSON, not HTML");
    assert.equal(typeof body.error_description, "string");
    assert.equal(
      await countGrantPackagesForOwner(),
      packageCountBefore,
      "an unresolvable selection mints nothing"
    );
  } finally {
    await closeServer(server);
  }
});

// Locks the snapshot binding: the console commits to the `review_digest` it
// was served, and the AS recomputes it from a fresh resolve. A stale one means
// what the owner saw is no longer what would be granted.
test("a stale review_digest on a consent challenge is rejected and mints nothing", async () => {
  const server = await startOpenTestServer();
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    await registerAuthorizedSpotify(asUrl);
    const client = await registerAuthCodeClient(asUrl);
    const challenge = await startConsentChallenge(asUrl, client, "stale-state");
    const model = await fetchConsentChallengeModel(asUrl, challenge);
    const source = mustExist(model.sources[0], "the model must publish a source to approve");
    const stream = mustExist(source.streams[0], "the source must publish a stream to approve");
    const packageCountBefore = await countGrantPackagesForOwner();

    const { status, body } = await postConsentChallenge(
      asUrl,
      challenge,
      "accept",
      consentChallengeAcceptBody({
        chosen: [{ source, streams: [stream] }],
        client,
        model,
        reviewDigest: "sha256:stale",
      })
    );

    assert.equal(status, 400, JSON.stringify(body));
    assert.match(
      stringField(body, "error_description"),
      /changed since you loaded/i,
      "the owner is told the request moved under them"
    );
    assert.equal(
      await countGrantPackagesForOwner(),
      packageCountBefore,
      "a stale approval mints nothing"
    );
  } finally {
    await closeServer(server);
  }
});

// The defect this locks: the consent screen's per-stream date controls held
// state and the accept route dropped it, so an owner who narrowed "saved
// tracks" to 2025 got a grant covering every year. The two date axes are
// orthogonal (spec-core.md:889) — `grant_expiry` bounds how long the
// AUTHORIZATION lives, `time_constraint` bounds which RECORDS it reaches — and
// only the first was reaching the grant.
test("accepting a consent challenge carries the owner's per-stream date range onto the issued grant", async () => {
  const server = await startOpenTestServer();
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    const spotify = await registerAuthorizedSpotify(asUrl);
    const client = await registerAuthCodeClient(asUrl);
    const challenge = await startConsentChallenge(asUrl, client, "stream-range-state");
    const model = await fetchConsentChallengeModel(asUrl, challenge);

    const source = mustExist(model.sources[0], "the model must publish a source to approve");
    // Only a stream the manifest gives a time field can carry a range; the
    // model says which by publishing `timePhrase`, and the screen shows the
    // date control on exactly those.
    const stream = mustExist(
      source.streams.find((entry) => entry.timePhrase),
      "the fixture must publish a stream with a data time axis"
    );

    const { status, body } = await postConsentChallenge(
      asUrl,
      challenge,
      "accept",
      consentChallengeAcceptBody({
        chosen: [{ source, streams: [stream] }],
        client,
        model,
        streamRanges: { [stream.id]: { since: "2025-01-01", until: "2025-12-31" } },
      })
    );
    assert.equal(status, 200, JSON.stringify(body));

    // Complete the flow so the child grant exists to inspect.
    const redirectUrl = stringField(body, "redirect_url");
    const code = mustExist(
      new URL(redirectUrl).searchParams.get("code"),
      "the approval must return an authorization code"
    );
    const { body: tokenBody } = await fetchJson(`${asUrl}/oauth/token`, {
      body: new URLSearchParams({
        client_id: client.client_id,
        code,
        code_verifier: consentChallengeVerifier,
        grant_type: "authorization_code",
        redirect_uri: HOSTED_MCP_REDIRECT_URI,
      }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    const grantPackageId = stringField(tokenBody, "grant_package_id");

    const constraint = await issuedStreamTimeConstraint(grantPackageId, stream.name);
    assert.ok(constraint, "the issued grant MUST record the range the owner chose, not drop it");

    // The field is the MANIFEST's own consent_time_field, never a name the
    // request supplied — the request only says which window, the declaration
    // says which column it applies to.
    const declared = mustExist(
      spotify.streams.find((entry) => entry.name === stream.name),
      "the manifest must declare the approved stream"
    ) as Record<string, unknown>;
    assert.equal(
      constraint.field,
      declared.consent_time_field,
      "time_constraint.field MUST come from the manifest declaration"
    );
    // `since` is inclusive and `until` is EXCLUSIVE (spec-core.md:758-759), so
    // an owner who picks "through 2025-12-31" gets an end instant of
    // 2026-01-01T00:00:00Z — the whole last day is covered, and asserting the
    // exclusive form is what stops a future change from quietly truncating it
    // to midnight on the 31st.
    assert.equal(constraint.since, "2025-01-01T00:00:00.000Z");
    assert.equal(
      constraint.until,
      "2026-01-01T00:00:00.000Z",
      "until is exclusive, so the owner's last chosen day must be fully inside the window"
    );
  } finally {
    await closeServer(server);
  }
});

// The default must not regress into an accidental bound: an owner who touched
// no date control grants every record, and that is represented by ABSENCE.
test("accepting with no date range leaves the issued grant unbounded in time", async () => {
  const server = await startOpenTestServer();
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    await registerAuthorizedSpotify(asUrl);
    const client = await registerAuthCodeClient(asUrl);
    const challenge = await startConsentChallenge(asUrl, client, "no-range-state");
    const model = await fetchConsentChallengeModel(asUrl, challenge);
    const source = mustExist(model.sources[0], "the model must publish a source to approve");
    const stream = mustExist(
      source.streams.find((entry) => entry.timePhrase),
      "the fixture must publish a stream with a data time axis"
    );

    const { status, body } = await postConsentChallenge(
      asUrl,
      challenge,
      "accept",
      consentChallengeAcceptBody({ chosen: [{ source, streams: [stream] }], client, model })
    );
    assert.equal(status, 200, JSON.stringify(body));

    const code = mustExist(
      new URL(stringField(body, "redirect_url")).searchParams.get("code"),
      "the approval must return an authorization code"
    );
    const { body: tokenBody } = await fetchJson(`${asUrl}/oauth/token`, {
      body: new URLSearchParams({
        client_id: client.client_id,
        code,
        code_verifier: consentChallengeVerifier,
        grant_type: "authorization_code",
        redirect_uri: HOSTED_MCP_REDIRECT_URI,
      }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    assert.equal(
      await issuedStreamTimeConstraint(stringField(tokenBody, "grant_package_id"), stream.name),
      null,
      "no range chosen means no temporal bound recorded"
    );
  } finally {
    await closeServer(server);
  }
});
