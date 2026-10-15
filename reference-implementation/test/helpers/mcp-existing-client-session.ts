// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomBytes } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import { startServer } from "../../server/index.ts"
import { buildPendingConsentRequestUri } from "../../server/auth.ts"
import { getDb } from "../../server/db.ts"
import { computeHostedMcpDecisionDigest } from "../../server/hosted-mcp-decision-digest.ts"
import { ingestRecord } from "../../server/records.ts"
import { runSearchIndexDirtyReconcileRound } from "../../server/search-index-reconcile.ts"
import { createSqliteConnectorInstanceStore } from "../../server/stores/connector-instance-store.ts"

const CONNECTIONS = ["cin_mcp_contract_a", "cin_mcp_contract_b"]
const LONG_TEXT = `Contract pasta order 1 and Contract pasta order 2. Café 🍝 data must survive hosted MCP fetch and bounded field reads. A hosted MCP connector must preserve the full record text across search, fetch, and bounded field reads. ${"Compatibility fixture. ".repeat(90)}`

type JsonObject = Record<string, unknown>
type Tool = { name: string; inputSchema: JsonObject; annotations?: JsonObject }

async function json(
  url: string,
  init: RequestInit = {}
): Promise<{ status: number; body: JsonObject; headers: Headers }> {
  const response = await fetch(url, init)
  const text = await response.text()
  return {
    status: response.status,
    body: text ? (JSON.parse(text) as JsonObject) : {},
    headers: response.headers,
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function object(value: unknown): JsonObject {
  return value && typeof value === "object" ? (value as JsonObject) : {}
}

function requiredString(obj: JsonObject, key: string): string {
  const value = obj[key]
  assert(
    typeof value === "string" && value.length > 0,
    `${key} must be a non-empty string`
  )
  return value
}

function makeManifest(): JsonObject {
  const props = {
    id: { type: "string" },
    received_at: { format: "date-time", type: "string" },
    subject: { type: "string" },
    text: { type: "string" },
    title: { type: "string" },
  }
  const stream = {
    consent_time_field: "received_at",
    cursor_field: "received_at",
    name: "documents",
    primary_key: ["id"],
    query: {
      aggregations: { count: true },
      search: { lexical_fields: ["subject", "text", "title"] },
    },
    schema: {
      properties: props,
      required: ["id", "subject", "received_at"],
      type: "object",
    },
    selection: { fields: true, resources: true },
    semantics: "mutable_state",
  }
  return {
    capabilities: { human_interaction: [] },
    connector_id: "mcp-contract-fixture",
    display_name: "MCP Existing Client Contract Fixture",
    protocol_version: "0.1.0",
    source_declaration: {
      declaration_version: "hosted-mcp.contract-fixture.v1",
      display: { name: "MCP Existing Client Contract Fixture" },
      protocol_version: "0.1.0",
      publisher: { id: "https://pdpp.dev/reference-implementation/tests" },
      source: {
        id: "https://registry.pdpp.dev/connectors/mcp-contract-fixture",
        kind: "connector",
      },
      streams: [stream],
    },
    streams: [stream],
    version: "1.0.0",
  }
}

async function makeClient(asUrl: string): Promise<string> {
  const response = await json(`${asUrl}/oauth/register`, {
    body: JSON.stringify({
      application_type: "web",
      client_name: "Existing ChatGPT-style MCP client fixture",
      grant_types: ["authorization_code", "refresh_token"],
      redirect_uris: ["https://client.example/callback"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    method: "POST",
  })
  assert(
    response.status === 201,
    `OAuth test client registration failed: ${JSON.stringify(response.body)}`
  )
  return requiredString(response.body, "client_id")
}

async function seedFixture(asUrl: string): Promise<void> {
  const manifest = makeManifest()
  const response = await json(`${asUrl}/connectors`, {
    body: JSON.stringify(manifest),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  })
  assert(
    response.status === 201,
    `MCP fixture registration failed: ${JSON.stringify(response.body)}`
  )
  const store = createSqliteConnectorInstanceStore()
  for (const [index, connectionId] of CONNECTIONS.entries()) {
    const now = new Date().toISOString()
    await store.upsert({
      connectorId: "mcp-contract-fixture",
      connectorInstanceId: connectionId,
      createdAt: now,
      displayName: `MCP contract source ${index + 1}`,
      ownerSubjectId: "owner_local",
      sourceBinding: { fixture: connectionId },
      sourceBindingKey: connectionId,
      sourceKind: "account",
      status: "active",
      updatedAt: now,
    })
    for (const [recordIndex, suffix] of ["", "-page"].entries()) {
      const recordId = `record-${index + 1}${suffix}`
      await ingestRecord(
        {
          connector_id: "mcp-contract-fixture",
          connector_instance_id: connectionId,
        },
        {
          data: {
            id: recordId,
            received_at: `2026-05-18T12:0${index + recordIndex}:00.000Z`,
            subject: `Contract pasta order ${index + 1}`,
            text: LONG_TEXT,
            title: `Contract pasta order ${index + 1}`,
          },
          emitted_at: `2026-05-18T12:0${index + recordIndex}:00.000Z`,
          key: recordId,
          stream: "documents",
        }
      )
    }
  }
  await runSearchIndexDirtyReconcileRound()
}

async function createTokens(
  asUrl: string,
  rsUrl: string,
  clientId: string
): Promise<{ client: string; package: string }> {
  const clientDetails = [
    {
      access_mode: "continuous",
      purpose_code: "https://pdpp.dev/purpose/personal_ai_assistant",
      purpose_description:
        "Use approved records through the hosted MCP connector.",
      source: {
        id: "https://registry.pdpp.dev/connectors/mcp-contract-fixture",
        kind: "connector",
      },
      streams: [{ instance_ids: [CONNECTIONS[0]], name: "documents" }],
      type: "https://pdpp.dev/data-access",
    },
  ]
  const deviceResponse = await json(`${asUrl}/oauth/device_authorization`, {
    body: new URLSearchParams({
      authorization_details: JSON.stringify(clientDetails),
      client_id: clientId,
      resource: `${rsUrl}/mcp`,
    }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  })
  assert(
    deviceResponse.status === 200,
    `hosted MCP device authorization failed: ${JSON.stringify(deviceResponse.body)}`
  )
  const deviceCode = requiredString(deviceResponse.body, "device_code")
  const requestUri = buildPendingConsentRequestUri(deviceCode)
  const reviewResponse = await json(`${asUrl}/consent/review`, {
    body: JSON.stringify({
      request_uri: requestUri,
      subject_id: "owner_local",
    }),
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    method: "POST",
  })
  assert(
    reviewResponse.status === 200,
    `single-source consent review failed: ${JSON.stringify(reviewResponse.body)}`
  )
  const approveResponse = await fetch(`${asUrl}/consent/approve`, {
    body: new URLSearchParams({
      approval_review_revision: requiredString(
        reviewResponse.body,
        "approval_review_revision"
      ),
      request_uri: requestUri,
    }).toString(),
    headers: {
      Accept: "text/html",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    method: "POST",
  })
  assert(
    approveResponse.status === 200,
    `single-source consent approval failed: HTTP ${approveResponse.status}`
  )
  const clientResponse = await json(`${asUrl}/oauth/token`, {
    body: new URLSearchParams({
      client_id: clientId,
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  })
  assert(
    clientResponse.status === 200,
    `hosted MCP client token exchange failed: ${JSON.stringify(clientResponse.body)}`
  )

  const verifier = randomBytes(32).toString("base64url")
  const state = "mcp-existing-client-package-state"
  const challenge = createHash("sha256").update(verifier).digest("base64url")
  const authorizeUrl = new URL(`${asUrl}/oauth/authorize`)
  authorizeUrl.searchParams.set("client_id", clientId)
  authorizeUrl.searchParams.set(
    "redirect_uri",
    "https://client.example/callback"
  )
  authorizeUrl.searchParams.set("response_type", "code")
  authorizeUrl.searchParams.set("state", state)
  authorizeUrl.searchParams.set("code_challenge", challenge)
  authorizeUrl.searchParams.set("code_challenge_method", "S256")
  authorizeUrl.searchParams.set("resource", `${rsUrl}/mcp`)
  const authorizeResponse = await fetch(authorizeUrl, { redirect: "manual" })
  assert(
    authorizeResponse.status === 302,
    `package picker did not hand off consent: HTTP ${authorizeResponse.status}`
  )
  const handoff = new URL(
    requiredString(
      { location: authorizeResponse.headers.get("location") },
      "location"
    ),
    asUrl
  )
  const challengeId = requiredString(
    { challenge: handoff.searchParams.get("challenge") },
    "challenge"
  )
  const modelResponse = await json(
    `${asUrl}/oauth/authorize/consent-challenges/${challengeId}`
  )
  assert(
    modelResponse.status === 200,
    `package consent picker model failed: ${JSON.stringify(modelResponse.body)}`
  )
  const model = modelResponse.body
  const sources = model.sources as Array<{
    id: string
    streams: Array<{ id: string; name: string }>
  }>
  assert(
    Array.isArray(sources) && sources.length >= 2,
    `package picker must offer both fixture connections, got ${sources?.length ?? 0}`
  )
  const selected = sources.map(source => ({ source, streams: source.streams }))
  const decisionDigest = computeHostedMcpDecisionDigest({
    accessMode: "continuous",
    clientId,
    grantExpiry: requiredString(model.grantExpiry as JsonObject, "defaultId"),
    sources: selected.map(({ source, streams }) => ({
      sourceKey: source.id,
      streamNames: streams.map(stream => stream.name).sort(),
    })),
  })
  const acceptBody = {
    access_mode: "continuous",
    decision_digest: decisionDigest,
    grant_expiry: requiredString(model.grantExpiry as JsonObject, "defaultId"),
    review_digest: requiredString(model, "reviewDigest"),
    source_id: selected.map(({ source }) => source.id),
    stream: selected.flatMap(({ streams }) => streams.map(stream => stream.id)),
  }
  const accepted = await json(
    `${asUrl}/oauth/authorize/consent-challenges/${challengeId}/accept`,
    {
      body: JSON.stringify(acceptBody),
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      method: "POST",
    }
  )
  assert(
    accepted.status === 200,
    `package picker approval failed: ${JSON.stringify(accepted.body)}`
  )
  const callback = new URL(requiredString(accepted.body, "redirect_url"))
  assert(
    callback.searchParams.get("state") === state,
    "package approval redirect must preserve OAuth state"
  )
  const code = callback.searchParams.get("code")
  assert(code, "package approval redirect must carry an authorization code")
  const packageResponse = await json(`${asUrl}/oauth/token`, {
    body: new URLSearchParams({
      client_id: clientId,
      code,
      code_verifier: verifier,
      grant_type: "authorization_code",
      redirect_uri: "https://client.example/callback",
    }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  })
  assert(
    packageResponse.status === 200,
    `hosted MCP package token exchange failed: ${JSON.stringify(packageResponse.body)}`
  )
  return {
    client: requiredString(clientResponse.body, "access_token"),
    package: requiredString(packageResponse.body, "access_token"),
  }
}

async function createUnscopedCodeToken(
  asUrl: string,
  clientId: string
): Promise<string> {
  const verifier = randomBytes(32).toString("base64url")
  const challenge = createHash("sha256").update(verifier).digest("base64url")
  const state = randomBytes(12).toString("hex")
  const authorizeUrl = new URL(`${asUrl}/oauth/authorize`)
  authorizeUrl.searchParams.set("client_id", clientId)
  authorizeUrl.searchParams.set(
    "redirect_uri",
    "https://client.example/callback"
  )
  authorizeUrl.searchParams.set("response_type", "code")
  authorizeUrl.searchParams.set("state", state)
  authorizeUrl.searchParams.set("code_challenge", challenge)
  authorizeUrl.searchParams.set("code_challenge_method", "S256")
  authorizeUrl.searchParams.set(
    "authorization_details",
    JSON.stringify([
      {
        access_mode: "continuous",
        purpose_code: "https://pdpp.dev/purpose/personal_ai_assistant",
        purpose_description:
          "Use approved records through the hosted MCP connector.",
        source: {
          id: "https://registry.pdpp.dev/connectors/mcp-contract-fixture",
          kind: "connector",
        },
        streams: [{ instance_ids: [CONNECTIONS[0]], name: "documents" }],
        type: "https://pdpp.dev/data-access",
      },
    ])
  )
  const authorize = await fetch(authorizeUrl, { redirect: "manual" })
  assert(
    authorize.status === 302,
    `unscoped authorize failed: HTTP ${authorize.status}`
  )
  const consent = new URL(
    requiredString({ location: authorize.headers.get("location") }, "location"),
    asUrl
  )
  const requestUri = requiredString(
    { requestUri: consent.searchParams.get("request_uri") },
    "requestUri"
  )
  const review = await json(`${asUrl}/consent/review`, {
    body: JSON.stringify({
      request_uri: requestUri,
      subject_id: "owner_local",
    }),
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    method: "POST",
  })
  assert(
    review.status === 200,
    `unscoped consent review failed: ${JSON.stringify(review.body)}`
  )
  const approval = await fetch(`${asUrl}/consent/approve`, {
    body: new URLSearchParams({
      approval_review_revision: requiredString(
        review.body,
        "approval_review_revision"
      ),
      request_uri: requestUri,
    }).toString(),
    headers: {
      Accept: "text/html",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    method: "POST",
    redirect: "manual",
  })
  assert(
    approval.status === 302,
    `unscoped approval failed: HTTP ${approval.status}`
  )
  const callback = new URL(
    requiredString({ location: approval.headers.get("location") }, "location")
  )
  assert(
    callback.searchParams.get("state") === state,
    "unscoped approval must preserve OAuth state"
  )
  const token = await json(`${asUrl}/oauth/token`, {
    body: new URLSearchParams({
      client_id: clientId,
      code: requiredString({ code: callback.searchParams.get("code") }, "code"),
      code_verifier: verifier,
      grant_type: "authorization_code",
      redirect_uri: "https://client.example/callback",
    }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  })
  assert(
    token.status === 200,
    `unscoped token exchange failed: ${JSON.stringify(token.body)}`
  )
  return requiredString(token.body, "access_token")
}

export interface PermanentAudienceFixture {
  asUrl: string
  rsUrl: string
  client: string
  package: string
  packageId: string
  internalChildren: string[]
  undecidable: string
  close: () => Promise<void>
}

function makePermanent(tokenIds: string[]): void {
  const db = getDb()
  const families = db
    .prepare(
      `SELECT DISTINCT refresh_family_id AS family_id FROM tokens
        WHERE token_id IN (${tokenIds.map(() => "?").join(",")})
          AND refresh_family_id IS NOT NULL`
    )
    .all(...tokenIds) as Array<{ family_id: string }>
  db.prepare(
    `UPDATE tokens SET expires_at = NULL, refresh_family_id = NULL
      WHERE token_id IN (${tokenIds.map(() => "?").join(",")})`
  ).run(...tokenIds)
  if (families.length) {
    db.prepare(
      `DELETE FROM oauth_refresh_tokens
        WHERE family_id IN (${families.map(() => "?").join(",")})`
    ).run(...families.map(({ family_id }) => family_id))
  }
}

function createInternalChildTokens(packageToken: string): string[] {
  const db = getDb()
  const owner = db
    .prepare("SELECT subject_id, client_id FROM tokens WHERE token_id = ?")
    .get(packageToken) as { client_id: string; subject_id: string } | undefined
  assert(owner, "package bearer must be persisted")
  const children = db
    .prepare(
      `SELECT grant_id FROM grant_package_members
        WHERE package_id = (SELECT package_id FROM tokens WHERE token_id = ?)
          AND status = 'active' ORDER BY grant_id`
    )
    .all(packageToken) as Array<{ grant_id: string }>
  assert(
    children.length >= 2,
    "fixture package must have at least two children"
  )
  const insert = db.prepare(
    `INSERT INTO tokens
      (token_id, grant_id, package_id, refresh_family_id, subject_id, client_id,
       token_kind, expires_at, revoked)
     VALUES (?, ?, NULL, NULL, ?, ?, 'client', NULL, 0)`
  )
  return children.map(({ grant_id }) => {
    const tokenId = randomBytes(32).toString("base64url")
    insert.run(tokenId, grant_id, owner.subject_id, owner.client_id)
    return tokenId
  })
}

export async function startPermanentAudienceFixture(
  dbPath = ":memory:"
): Promise<PermanentAudienceFixture> {
  const server = await startServer({
    asPort: 0,
    dbPath,
    ownerAuthPassword: "",
    quiet: true,
    rsPort: 0,
  })
  const asUrl = `http://localhost:${server.asPort}`
  const rsUrl = `http://localhost:${server.rsPort}`
  const close = async (): Promise<void> => {
    server.schedulerManager?.stop?.()
    server.asServer.closeAllConnections?.()
    server.rsServer.closeAllConnections?.()
    await Promise.allSettled([
      new Promise<void>(resolve => server.asServer.close(() => resolve())),
      new Promise<void>(resolve => server.rsServer.close(() => resolve())),
    ])
  }
  try {
    await seedFixture(asUrl)
    const clientId = await makeClient(asUrl)
    const issued = await createTokens(asUrl, rsUrl, clientId)
    const undecidable = await createUnscopedCodeToken(asUrl, clientId)
    const packageIdRow = getDb()
      .prepare("SELECT package_id FROM tokens WHERE token_id = ?")
      .get(issued.package) as { package_id: string | null } | undefined
    assert(packageIdRow?.package_id, "package token must identify its package")
    const internalChildren = createInternalChildTokens(issued.package)
    makePermanent([
      issued.client,
      issued.package,
      undecidable,
      ...internalChildren,
    ])
    return {
      asUrl,
      rsUrl,
      client: issued.client,
      package: issued.package,
      packageId: packageIdRow.package_id,
      internalChildren,
      undecidable,
      close,
    }
  } catch (error) {
    await close()
    throw error
  }
}

async function rpc(
  baseUrl: string,
  token: string,
  message: JsonObject,
  sessionId?: string
): Promise<{ body: JsonObject; sessionId?: string }> {
  const response = await fetch(`${baseUrl}/mcp`, {
    body: JSON.stringify(message),
    headers: {
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    method: "POST",
  })
  const text = await response.text()
  const body = text ? (JSON.parse(text) as JsonObject) : {}
  assert(
    response.status >= 200 && response.status < 300,
    `MCP ${String(message.method)} returned HTTP ${response.status}: ${text}`
  )
  const result = response.headers.get("mcp-session-id") ?? sessionId
  return { body, ...(result ? { sessionId: result } : {}) }
}

function resultOf(response: JsonObject): JsonObject {
  const result = response.result
  assert(
    result && typeof result === "object",
    `MCP response omitted result: ${JSON.stringify(response)}`
  )
  return result as JsonObject
}

function typeOf(value: unknown): string {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  return typeof value
}

function valueShape(value: unknown): unknown {
  if (value === null) return "null"
  if (Array.isArray(value)) {
    const shapes = new Map<string, unknown>()
    for (const item of value) {
      const shape = valueShape(item)
      shapes.set(JSON.stringify(shape), shape)
    }
    return {
      type: "array",
      elements: [...shapes.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([, shape]) => shape),
    }
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as JsonObject).sort(([a], [b]) =>
      a.localeCompare(b)
    )
    return {
      type: "object",
      properties: Object.fromEntries(
        entries.map(([key, child]) => [key, valueShape(child)])
      ),
    }
  }
  return typeof value
}

function stableValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.entries(value as JsonObject)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableValue(child)}`)
      .join(",")}}`
  }
  return JSON.stringify(value)
}

function contentTexts(result: JsonObject): string[] {
  return Array.isArray(result.content)
    ? (result.content as JsonObject[]).flatMap(part =>
        typeof part.text === "string" ? [part.text] : []
      )
    : []
}

function contentTextMode(result: JsonObject): string {
  const texts = contentTexts(result)
  assert(
    texts.length > 0 && texts.every(text => text.trim().length > 0),
    "tools/call must return non-empty content[] text"
  )
  const structured = result.structuredContent
  for (const text of texts) {
    try {
      const parsed = JSON.parse(text) as unknown
      if (stableValue(parsed) === stableValue(structured))
        return "json-equals-structuredContent"
      const structuredObject = object(structured)
      if (structuredObject.content_ladder !== undefined) {
        const withoutLadder = Object.fromEntries(
          Object.entries(structuredObject).filter(
            ([key]) => key !== "content_ladder"
          )
        )
        if (stableValue(parsed) === stableValue(withoutLadder))
          return "json-equals-structuredContent-except-content_ladder"
      }
    } catch {
      /* MCP human-readable summaries are not JSON. */
    }
  }
  assert(
    !texts.every(text => text.trim() === "{}"),
    "tools/call content text was replaced with an empty JSON object"
  )
  return "non-empty-model-visible-text"
}

function connectionIdForRecordHandle(handle: string): string | undefined {
  if (handle.startsWith("pdpp://record/")) {
    const value = decodeURIComponent(handle.slice("pdpp://record/".length))
    try {
      const payload = JSON.parse(
        Buffer.from(value, "base64url").toString("utf8")
      ) as JsonObject
      if (typeof payload.connection_id === "string")
        return payload.connection_id
    } catch {
      return connectionIdForRecordHandle(value)
    }
    return connectionIdForRecordHandle(value)
  }
  const separator = handle.indexOf("/")
  return separator > 0 ? handle.slice(0, separator) : undefined
}

function connectionIdForResourceUri(uri: string): string | undefined {
  const match = /^pdpp:\/\/(?:record|field-window)\/(.+)$/.exec(uri)
  if (!match) return undefined
  const handle = decodeURIComponent(match[1]!)
  try {
    const payload = JSON.parse(
      Buffer.from(handle, "base64url").toString("utf8")
    ) as JsonObject
    return typeof payload.connection_id === "string"
      ? payload.connection_id
      : undefined
  } catch {
    return connectionIdForRecordHandle(handle)
  }
}

function outputContract(result: JsonObject): JsonObject {
  const structured =
    result.structuredContent && typeof result.structuredContent === "object"
      ? (result.structuredContent as JsonObject)
      : {}
  return {
    contentTextMode: contentTextMode(result),
    content: Array.isArray(result.content)
      ? (result.content as JsonObject[]).map(item => ({
          keys: Object.keys(item).sort(),
          types: Object.fromEntries(
            Object.entries(item).map(([key, value]) => [key, typeOf(value)])
          ),
        }))
      : typeOf(result.content),
    resultShape: valueShape(result),
    structuredShape: valueShape(structured),
  }
}

export async function replay(
  baseUrl: string,
  token: string,
  tokenKind: "client" | "package",
  storedIds?: JsonObject
): Promise<JsonObject> {
  let init: { body: JsonObject; sessionId?: string }
  try {
    init = await rpc(baseUrl, token, {
      id: 1,
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        capabilities: {},
        clientInfo: { name: "ChatGPT deep-research connector", version: "1.0" },
        protocolVersion: "2025-06-18",
      },
    })
  } catch (error) {
    throw new Error(
      `${tokenKind} token session failed during MCP initialize: ${String(error)}`,
      { cause: error }
    )
  }
  let sessionId = init.sessionId
  const initResult = resultOf(init.body)
  assert(
    initResult.protocolVersion,
    "MCP initialize response must include protocolVersion"
  )
  assert(
    ["2025-06-18", "2025-03-26", "2024-11-05"].includes(
      String(initResult.protocolVersion)
    ),
    `MCP initialize returned unsupported protocolVersion '${String(initResult.protocolVersion)}'`
  )
  assert(
    Object.keys(object(initResult.capabilities)).length > 0,
    "MCP initialize capabilities must be non-empty"
  )
  assert(
    typeof initResult.instructions === "string" &&
      initResult.instructions.trim().length > 0,
    "MCP initialize instructions must be present and non-empty"
  )
  const olderInit = resultOf(
    (
      await rpc(baseUrl, token, {
        id: 3,
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          capabilities: {},
          clientInfo: {
            name: "ChatGPT deep-research older-version fixture",
            version: "1.0",
          },
          protocolVersion: "2025-03-26",
        },
      })
    ).body
  )
  await rpc(
    baseUrl,
    token,
    { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
    sessionId
  )
  const list = resultOf(
    (
      await rpc(
        baseUrl,
        token,
        { id: 2, jsonrpc: "2.0", method: "tools/list", params: {} },
        sessionId
      )
    ).body
  )
  const tools = list.tools as Tool[]
  assert(Array.isArray(tools), "tools/list did not return tools")
  for (const tool of tools) {
    assert(
      tool.annotations && typeof tool.annotations === "object",
      `tool '${tool.name}' must include annotations`
    )
    for (const value of Object.values(tool.annotations))
      assert(
        typeof value === "boolean",
        `tool '${tool.name}' annotation values must be boolean`
      )
  }
  const byName = new Map(tools.map(tool => [tool.name, tool]))
  const call = async (
    name: string,
    args: JsonObject,
    allowError = false
  ): Promise<JsonObject> => {
    const response = await rpc(
      baseUrl,
      token,
      {
        id: randomBytes(4).readUInt32BE(0),
        jsonrpc: "2.0",
        method: "tools/call",
        params: { arguments: args, name },
      },
      sessionId
    )
    sessionId = response.sessionId
    const result = resultOf(response.body)
    if (!allowError)
      assert(
        result.isError !== true,
        `${tokenKind} token call '${name}' failed: ${JSON.stringify(result)}`
      )
    return result
  }

  let discoveryGrantIds: string[] = []
  let grantIdByConnection = new Map<string, string>()
  let grantIdsByConnection = new Map<string, string[]>()
  if (tokenKind === "package") {
    const schemas = tools.filter(tool => tool.name !== "list_package_children")
    const packageRequiresGrantId = schemas.some(tool =>
      ((tool.inputSchema.required as string[] | undefined) ?? []).includes(
        "grant_id"
      )
    )
    if (packageRequiresGrantId) {
      assert(
        byName.has("list_package_children"),
        "package tokens require grant_id but no discovery tool is offered"
      )
      const discovery = await call("list_package_children", {})
      const ids = new Set<string>()
      const walk = (value: unknown): void => {
        if (Array.isArray(value)) {
          value.forEach(walk)
          return
        }
        if (!value || typeof value !== "object") return
        for (const [key, child] of Object.entries(value as JsonObject)) {
          if (key === "grant_id" && typeof child === "string") ids.add(child)
          walk(child)
        }
      }
      walk(discovery.structuredContent)
      discoveryGrantIds = [...ids]
      assert(
        discoveryGrantIds.length >= 2,
        "list_package_children must provide at least two valid grant ids"
      )
      const byConnection = new Map<string, string>()
      const byConnectionAll = new Map<string, string[]>()
      const collect = (value: unknown): void => {
        if (Array.isArray(value)) {
          value.forEach(collect)
          return
        }
        if (!value || typeof value !== "object") return
        const row = value as JsonObject
        const source = object(row.source)
        const streams = Array.isArray(row.streams)
          ? (row.streams as JsonObject[])
          : []
        const instanceId = streams
          .flatMap(stream =>
            Array.isArray(stream.instance_ids)
              ? (stream.instance_ids as unknown[])
              : []
          )
          .find((id): id is string => typeof id === "string")
        const connectionId =
          (typeof row.connection_id === "string" && row.connection_id) ||
          (typeof source.connection_id === "string" && source.connection_id) ||
          instanceId
        if (typeof row.grant_id === "string" && connectionId) {
          byConnection.set(connectionId, row.grant_id)
          byConnectionAll.set(connectionId, [
            ...(byConnectionAll.get(connectionId) ?? []),
            row.grant_id,
          ])
        }
        Object.values(row).forEach(collect)
      }
      collect(discovery.structuredContent)
      grantIdByConnection = byConnection
      grantIdsByConnection = byConnectionAll
      assert(
        grantIdByConnection.size >= 2,
        "list_package_children must map at least two grant ids to legacy connection_id handles"
      )
      for (const grantId of discoveryGrantIds)
        await call("schema", { grant_id: grantId })
    }
  }

  const schemaArgs: JsonObject = {}
  if (tokenKind === "package" && discoveryGrantIds.length)
    schemaArgs.grant_id = discoveryGrantIds[0]
  const schema = await call("schema", schemaArgs)
  const schemaData = schema.structuredContent as JsonObject
  assert(
    contentTexts(schema).some(text => text.includes("documents")),
    "schema summary text must name the discovered stream"
  )
  const stream = "documents"
  const capturedConnectionIds = Array.isArray(storedIds?.connectionIds)
    ? (storedIds.connectionIds as string[])
    : []
  const scopedConnection = capturedConnectionIds[0] ?? CONNECTIONS[0]
  assert(scopedConnection, "fixture session requires a scoped connection")
  const firstGrantId = discoveryGrantIds[0]
  const packageArgs = (connectionId = scopedConnection): JsonObject =>
    tokenKind === "package" && discoveryGrantIds.length
      ? { grant_id: grantIdByConnection.get(connectionId) ?? firstGrantId }
      : {}
  const searchArgs = object(storedIds?.searchArgs)
  const search = await call("search", {
    ...packageArgs(),
    ...searchArgs,
    limit: 1,
    q: typeof searchArgs.q === "string" ? searchArgs.q : "pasta",
  })
  const structuredSearch = search.structuredContent as JsonObject
  const hits = structuredSearch.results as JsonObject[]
  assert(
    Array.isArray(hits) && hits.length > 0,
    `search returned no results for fixture query 'pasta': ${JSON.stringify(search)}`
  )
  const hit =
    hits.find(item => item.id === storedIds?.searchResultId) ?? hits[0]
  assert(
    hit && typeof hit.id === "string",
    "search result has no id fetch handle"
  )
  const excerpts = Array.isArray(hit.evidence_excerpts)
    ? (hit.evidence_excerpts as JsonObject[])
    : []
  const evidenceText = excerpts.find(
    item =>
      typeof item.preview_text === "string" &&
      item.preview_text.trim().length > 0
  )?.preview_text
  assert(
    typeof evidenceText === "string",
    "search result must include non-empty evidence text"
  )
  assert(
    contentTexts(search).some(text => text.toLowerCase().includes("pasta")),
    "search evidence must be visible in content[] text"
  )
  const searchCursor =
    object(structuredSearch.data).next_cursor ?? structuredSearch.next_cursor
  assert(
    typeof searchCursor === "string" && searchCursor.length > 0,
    "search result must include a pagination cursor"
  )
  const nextSearch = await call("search", {
    ...packageArgs(),
    q: "pasta",
    limit: 1,
    cursor: searchCursor,
  })
  const nextSearchResults = object(nextSearch.structuredContent).results
  assert(
    Array.isArray(nextSearchResults) && nextSearchResults.length > 0,
    "search follow-up page must return results"
  )
  const resultConnectionId =
    typeof hit.connection_id === "string" ? hit.connection_id : scopedConnection
  const recordUri = `pdpp://record/${Buffer.from(
    JSON.stringify({
      connection_id: resultConnectionId,
      kind: "record",
      record_id: String(hit.record_key ?? String(hit.id).split(":").at(-1)),
      stream,
      v: 1,
    }),
    "utf8"
  ).toString("base64url")}`
  const resourceRead = resultOf(
    (
      await rpc(
        baseUrl,
        token,
        {
          id: 4,
          jsonrpc: "2.0",
          method: "resources/read",
          params: { uri: recordUri },
        },
        sessionId
      )
    ).body
  )
  const resourceContents = resourceRead.contents as JsonObject[]
  assert(
    Array.isArray(resourceContents) &&
      resourceContents.some(
        part =>
          typeof part.text === "string" && String(part.text).includes(LONG_TEXT)
      ),
    "resources/read must resolve a real pdpp://record handle to the seeded record"
  )
  const searchRecordUris = new Set<string>(
    Array.isArray(storedIds?.recordUris)
      ? (storedIds.recordUris as string[])
      : []
  )
  searchRecordUris.add(recordUri)
  const collectSearchUris = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(collectSearchUris)
      return
    }
    if (!value || typeof value !== "object") return
    for (const child of Object.values(value as JsonObject)) {
      if (typeof child === "string" && child.startsWith("pdpp://record/"))
        searchRecordUris.add(child)
      collectSearchUris(child)
    }
  }
  collectSearchUris(structuredSearch)
  for (const uri of searchRecordUris) {
    const replayed = resultOf(
      (
        await rpc(
          baseUrl,
          token,
          {
            id: randomBytes(4).readUInt32BE(0),
            jsonrpc: "2.0",
            method: "resources/read",
            params: { uri },
          },
          sessionId
        )
      ).body
    )
    assert(
      Array.isArray(replayed.contents) &&
        (replayed.contents as JsonObject[]).some(
          part => typeof part.text === "string" && part.text.trim().length > 0
        ),
      `stored record resource URI did not resolve: ${uri}`
    )
  }
  const candidateHandles = [
    ...hits.flatMap(item => (typeof item.id === "string" ? [item.id] : [])),
    ...searchRecordUris,
  ]
  const fetchIds = Array.isArray(storedIds?.fetchIds)
    ? [
        ...new Set([
          ...(storedIds.fetchIds as string[]),
          ...((storedIds.recordUris as string[] | undefined) ?? []),
        ]),
      ]
    : candidateHandles
  assert(fetchIds.length > 0, "search returned no stored record handles")
  const fetchId =
    typeof storedIds?.fetchId === "string" ? storedIds.fetchId : hit.id
  assert(
    fetchIds.includes(fetchId),
    "captured fetch id was not present in search results"
  )
  const fetchedResults = await Promise.all(
    fetchIds.map(id =>
      call("fetch", {
        ...packageArgs(connectionIdForRecordHandle(id) ?? scopedConnection),
        id,
      })
    )
  )
  const fetched = fetchedResults[0]
  assert(fetched, "fetch replay returned no results")
  const fetchedData = object(fetched.structuredContent)
  assert(
    fetchedData.id === hit.id,
    "fetch must return the same self-contained id selected by search"
  )
  assert(
    object(fetchedData.metadata).id === hit.record_key,
    "fetch metadata id must match the search result record key"
  )
  const recordNumber = String(hit.record_key).match(/^record-(\d+)(-page)?$/)
  assert(recordNumber, "search result record key must match the seeded fixture")
  assert(
    fetchedData.title === `Contract pasta order ${recordNumber[1]}`,
    "fetch title must match the seeded record"
  )
  assert(
    typeof evidenceText === "string" &&
      String(fetchedData.text).includes(evidenceText.replace(/<\/?mark>/g, "")),
    "fetch document text must contain the search evidence"
  )
  assert(
    typeof fetchedData.text === "string" &&
      fetchedData.text.includes(LONG_TEXT),
    "fetch text must include the seeded long document"
  )
  assert(
    typeof object(fetchedData.metadata).connector_key === "string",
    "fetch metadata must include connector_key"
  )
  const queryConnectionIds = [
    ...new Set([...capturedConnectionIds, resultConnectionId]),
  ]
  const queriedResults = await Promise.all(
    queryConnectionIds.map(connectionId =>
      call("query_records", {
        ...packageArgs(connectionId),
        connection_id: connectionId,
        limit: 1,
        stream,
      })
    )
  )
  const queried = queriedResults[0]
  assert(queried, "query_records replay returned no results")
  const queryData = queried.structuredContent as JsonObject
  const queryEnvelope = object(queryData.data)
  const queryCursor = queryEnvelope.next_cursor ?? queryData.next_cursor
  assert(
    typeof queryCursor === "string" && queryCursor.length > 0,
    "query_records must include a pagination cursor"
  )
  const nextQuery = await call("query_records", {
    ...packageArgs(),
    connection_id: scopedConnection,
    cursor: queryCursor,
    limit: 1,
    stream,
  })
  const nextQueryEnvelope = object(object(nextQuery.structuredContent).data)
  const nextQueryRecords = nextQueryEnvelope.data ?? nextQueryEnvelope.records
  assert(
    Array.isArray(nextQueryRecords) && nextQueryRecords.length > 0,
    "query_records follow-up page must return records"
  )
  const queryBody = queryData.data as JsonObject | undefined
  const records = (
    Array.isArray(queryBody?.data)
      ? queryBody.data
      : (queryBody?.records ?? queryData.records)
  ) as JsonObject[] | undefined
  assert(
    Array.isArray(records) && records.length > 0,
    `query_records returned no fixture records: ${JSON.stringify(queried)}`
  )
  assert(
    contentTexts(queried).some(
      text => text.includes("documents") && text.includes("record-")
    ),
    "query_records text must summarize its fixture records"
  )
  const readArgs = object(storedIds?.readArgs)
  const readIds = Array.isArray(storedIds?.readIds)
    ? [
        ...new Set([
          ...(storedIds.readIds as string[]),
          ...((storedIds.recordUris as string[] | undefined) ?? []),
        ]),
      ]
    : fetchIds
  const readResults = await Promise.all(
    readIds.map(id =>
      call("read_record_field", {
        ...packageArgs(connectionIdForRecordHandle(id) ?? scopedConnection),
        ...readArgs,
        field_path: "text",
        id,
        limit_chars:
          typeof readArgs.limit_chars === "number" ? readArgs.limit_chars : 240,
      })
    )
  )
  const read = readResults[0]
  assert(read, "read_record_field replay returned no results")
  const readData = object(read.structuredContent)
  const readWindowText = object(readData.window).text
  assert(
    typeof readWindowText === "string" &&
      readWindowText.length > 0 &&
      readWindowText.length <= 241,
    "read_record_field must return non-empty text bounded by limit_chars"
  )
  assert(
    contentTexts(read).some(text => text.includes(readWindowText)),
    "read_record_field content[] text must include its bounded window"
  )
  const readCursor = object(readData.window).next_cursor
  assert(
    typeof readCursor === "string" && readCursor.length > 0,
    "read_record_field must provide a continuation cursor for the long fixture"
  )
  const cursorRead = await call("read_record_field", {
    ...packageArgs(),
    field_path: "text",
    id: fetchId,
    cursor: readCursor,
    limit_chars: 240,
  })
  assert(
    typeof object(object(cursorRead.structuredContent).window).text ===
      "string" &&
      String(object(object(cursorRead.structuredContent).window).text).length >
        0,
    "bounded field continuation must resolve"
  )
  assert(
    String(readWindowText).includes("🍝"),
    "bounded Unicode field read must preserve the seeded character"
  )
  assert(
    LONG_TEXT.length > 2_000 && String(readWindowText).length <= 241,
    "large field result must be bounded"
  )

  const unknownStream = await call(
    "query_records",
    {
      ...packageArgs(),
      connection_id: scopedConnection,
      limit: 1,
      stream: "__unknown_stream__",
    },
    true
  )
  assert(
    unknownStream.isError === true,
    "unknown stream must return an MCP error result"
  )
  const unknownFetch = await call(
    "fetch",
    {
      ...packageArgs(),
      id: `${scopedConnection}/documents:__unknown_record__`,
    },
    true
  )
  assert(
    unknownFetch.isError === true,
    "unknown fetch id must return an MCP error result"
  )
  const badArguments = await call("search", {}, true)
  assert(
    badArguments.isError === true,
    "bad tool arguments must return an MCP error result"
  )
  const emptySearch = await call("search", {
    ...packageArgs(),
    q: "no-result-token-8a21",
  })
  assert(
    Array.isArray(object(emptySearch.structuredContent).results) &&
      (object(emptySearch.structuredContent).results as unknown[]).length === 0,
    "empty search must succeed with an empty results array"
  )
  assert(
    contentTexts(emptySearch).some(text => /0\s+hit/i.test(text)),
    "empty search text must summarize the empty result"
  )
  const aggregate = await call("aggregate", {
    ...packageArgs(),
    connection_id: scopedConnection,
    metric: "count",
    stream,
  })
  assert(
    contentTexts(aggregate).some(text => /count/i.test(text)),
    "aggregate content text must expose the count metric"
  )
  const currentWindowArgs: JsonObject[] = []
  const collectWindowArgs = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(collectWindowArgs)
      return
    }
    if (!value || typeof value !== "object") return
    const entry = value as JsonObject
    const read = object(entry.read)
    const args = object(read.args)
    if (typeof args.id === "string" && args.field_path === "text")
      currentWindowArgs.push(args)
    Object.values(entry).forEach(collectWindowArgs)
  }
  for (const output of [
    search.structuredContent,
    fetched.structuredContent,
    queried.structuredContent,
    read.structuredContent,
  ])
    collectWindowArgs(output)
  if (!storedIds)
    assert(
      currentWindowArgs.length > 0,
      "base capture produced zero real text-window arguments from the content ladder"
    )
  const windowArgs = Array.isArray(storedIds?.readArgsList)
    ? (storedIds.readArgsList as JsonObject[])
    : currentWindowArgs
  if (windowArgs.length === 0) {
    windowArgs.push({
      cursor: readCursor,
      field_path: "text",
      id: fetchId,
      limit_chars: 240,
    })
  }
  assert(
    windowArgs.length > 0,
    "base capture produced zero saved read_record_field window args"
  )
  assert(
    searchRecordUris.size > 0,
    "base capture produced zero pdpp://record handles"
  )
  const searchResultIds = hits.flatMap(item =>
    typeof item.id === "string" ? [item.id] : []
  )
  assert(
    searchResultIds.length > 0,
    "base capture produced zero search result ids"
  )
  assert(fetchIds.length > 0, "base capture produced zero fetch ids")
  const windowReadResults = await Promise.all(
    windowArgs.map(args => {
      const id = typeof args.id === "string" ? args.id : scopedConnection
      return call("read_record_field", {
        ...packageArgs(connectionIdForRecordHandle(id) ?? scopedConnection),
        ...args,
      })
    })
  )

  const connectionIds = new Set<string>()
  const recordUris = new Set<string>(searchRecordUris)
  const collectStoredIds = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(collectStoredIds)
      return
    }
    if (!value || typeof value !== "object") return
    for (const [key, child] of Object.entries(value as JsonObject)) {
      if (key === "connection_id" && typeof child === "string")
        connectionIds.add(child)
      if (typeof child === "string" && child.startsWith("pdpp://record/"))
        recordUris.add(child)
      collectStoredIds(child)
    }
  }
  collectStoredIds(schema.structuredContent)
  collectStoredIds(search.structuredContent)
  collectStoredIds(fetched.structuredContent)
  collectStoredIds(queried.structuredContent)
  collectStoredIds(read.structuredContent)
  for (const result of [
    ...fetchedResults,
    ...queriedResults,
    ...readResults,
    ...windowReadResults,
  ])
    collectStoredIds(result.structuredContent)
  assert(
    connectionIds.size > 0,
    "base capture produced zero connection_id output handles"
  )

  const outputs: JsonObject = {
    aggregate: outputContract(aggregate),
    bad_arguments: outputContract(badArguments),
    empty_search: outputContract(emptySearch),
    fetch: outputContract(fetched),
    query_records: outputContract(queried),
    read_record_field: outputContract(read),
    schema: outputContract(schema),
    search: outputContract(search),
    read_record_field_cursor: outputContract(cursorRead),
    unknown_fetch: outputContract(unknownFetch),
    unknown_stream: outputContract(unknownStream),
  }
  if (discoveryGrantIds.length)
    outputs.list_package_children = outputContract(
      await call("list_package_children", {})
    )
  const resourcesList = resultOf(
    (
      await rpc(
        baseUrl,
        token,
        { id: 900, jsonrpc: "2.0", method: "resources/list", params: {} },
        sessionId
      )
    ).body
  )
  const resourceTemplatesList = resultOf(
    (
      await rpc(
        baseUrl,
        token,
        {
          id: 901,
          jsonrpc: "2.0",
          method: "resources/templates/list",
          params: {},
        },
        sessionId
      )
    ).body
  )
  const resourceTemplates = Array.isArray(
    resourceTemplatesList.resourceTemplates
  )
    ? (resourceTemplatesList.resourceTemplates as JsonObject[])
    : []
  const recordTemplate = resourceTemplates.find(
    template => template.name === "pdpp-record"
  )
  const fieldWindowTemplate = resourceTemplates.find(
    template => template.name === "pdpp-field-window"
  )
  const readArgsForResource = (
    Array.isArray(storedIds?.readArgsList)
      ? (storedIds.readArgsList as JsonObject[])
      : windowArgs
  )[0]
  const fieldWindowUri =
    fieldWindowTemplate && readArgsForResource
      ? `pdpp://field-window/${Buffer.from(
          JSON.stringify({
            connection_id:
              connectionIdForRecordHandle(String(readArgsForResource.id)) ??
              resultConnectionId,
            field_path: readArgsForResource.field_path ?? "text",
            kind: "field-window",
            limit_chars: readArgsForResource.limit_chars ?? 240,
            offset_chars: readArgsForResource.offset_chars ?? 0,
            record_id: String(readArgsForResource.id).split(":").at(-1),
            stream,
            v: 1,
          }),
          "utf8"
        ).toString("base64url")}`
      : undefined
  const storedRecordUris = new Set<string>(
    Array.isArray(storedIds?.recordUris)
      ? (storedIds.recordUris as string[])
      : []
  )
  storedRecordUris.add(recordUri)
  const recordedUris = [...storedRecordUris].sort()
  const fieldWindowUris = new Set<string>(
    Array.isArray(storedIds?.fieldWindowUris)
      ? (storedIds.fieldWindowUris as string[])
      : []
  )
  if (fieldWindowUri) fieldWindowUris.add(fieldWindowUri)
  const resourceUris = [
    ...new Set([...recordedUris, ...fieldWindowUris]),
  ].sort()
  const resourceReadUris = new Set(resourceUris)
  if (tokenKind === "package" && discoveryGrantIds.length) {
    for (const oldUri of resourceUris) {
      const connectionId = connectionIdForResourceUri(oldUri)
      const grantId = connectionId
        ? grantIdByConnection.get(connectionId)
        : null
      const grantIds = connectionId
        ? (grantIdsByConnection.get(connectionId) ?? [])
        : []
      const template = oldUri.startsWith("pdpp://field-window/")
        ? fieldWindowTemplate
        : recordTemplate
      assert(
        connectionId && grantIds.length > 0 && grantId,
        `package resource URI has no unique discovered child: ${oldUri}`
      )
      assert(
        template && typeof template.uriTemplate === "string",
        `package resource URI has no advertised template: ${oldUri}`
      )
      const templateUri = String(template.uriTemplate)
      assert(
        templateUri.includes("{grant_id}/"),
        `package resource template '${String(template.name)}' does not advertise grant_id selection`
      )
      const oldHandle = oldUri.slice(oldUri.indexOf("/", "pdpp://".length) + 1)
      for (const candidateGrantId of grantIds) {
        const uri = templateUri
          .replace("{grant_id}", encodeURIComponent(candidateGrantId))
          .replace("{handle}", oldHandle)
        resourceReadUris.add(uri)
      }
    }
  }
  const readStoredResource = async (uri: string): Promise<JsonObject> => {
    const rpcResponse = (
      await rpc(
        baseUrl,
        token,
        {
          id: randomBytes(4).readUInt32BE(0),
          jsonrpc: "2.0",
          method: "resources/read",
          params: { uri },
        },
        sessionId
      )
    ).body
    if (rpcResponse.error) {
      const errorText = JSON.stringify(rpcResponse.error)
      assert(false, `resources/read failed for stored URI ${uri}: ${errorText}`)
    }
    const response = resultOf(rpcResponse)
    if (response.isError === true) {
      const error = object(response.structuredContent).error
      const errorCode = object(error).code
      const connectionId = connectionIdForResourceUri(uri)
      const matchingGrantIds = connectionId
        ? (grantIdsByConnection.get(connectionId) ?? [])
        : []
      assert(
        typeof errorCode === "string" &&
          errorCode === "ambiguous_legacy_resource_uri" &&
          uri.startsWith("pdpp://record/") &&
          matchingGrantIds.length > 1,
        `resources/read refused stored URI without genuine ambiguity; code=${String(errorCode)}, matchingChildren=${matchingGrantIds.length}: ${uri}`
      )
      return { uri, ambiguous: true, errorCode }
    }
    const contents = Array.isArray(response.contents)
      ? (response.contents as JsonObject[])
      : []
    assert(
      contents.some(
        part => typeof part.text === "string" && part.text.trim().length > 0
      ),
      `resources/read returned no text for stored URI: ${uri}`
    )
    return { uri, contents }
  }
  const resourceReads = await Promise.all(
    [...resourceReadUris].map(readStoredResource)
  )
  assert(
    recordedUris.length > 0,
    "package resource capture produced zero stored record URIs"
  )
  if (fieldWindowTemplate) {
    assert(
      fieldWindowUris.size > 0,
      "package resource capture produced zero field-window URIs"
    )
  }
  return {
    discoveryGrantIds,
    outputs,
    session: {
      initialize: {
        protocolVersion: initResult.protocolVersion,
        capabilities: valueShape(initResult.capabilities),
        instructionsPresent:
          typeof initResult.instructions === "string" &&
          initResult.instructions.trim().length > 0,
        olderProtocolVersion: olderInit.protocolVersion,
      },
      annotations: Object.fromEntries(
        tools.map(tool => [tool.name, tool.annotations])
      ),
      capabilities: valueShape(initResult.capabilities),
      resourcesList: valueShape(resourcesList),
      resourceTemplatesList: valueShape(resourceTemplatesList),
      resourceDiscovery: {
        resources: resourcesList.resources ?? [],
        resourceTemplates,
      },
      resourceReads,
      fetchId,
      fetchMetadataConnectionId: (
        ((fetched.structuredContent as JsonObject).metadata ?? {}) as JsonObject
      ).connection_id,
      queryRecordConnectionId:
        records[0]?.connection_id ??
        (records[0]?.source as JsonObject | undefined)?.connection_id ??
        null,
      schemaKeys: Object.keys(schemaData).sort(),
      searchResultKeys: Object.keys(hit).sort(),
      searchedFetchId: hit.id,
      storedIds: {
        connectionIds: [
          ...new Set([...capturedConnectionIds, ...connectionIds]),
        ].sort(),
        fetchId,
        fetchIds: [...new Set([...fetchIds, ...recordUris])],
        readArgs: { field_path: "text", id: fetchId, limit_chars: 240 },
        readArgsList: windowArgs,
        readIds: [...new Set([...readIds, ...recordUris])],
        recordUris: recordedUris,
        fieldWindowUris: [...fieldWindowUris].sort(),
        searchResultIds,
        searchArgs: { q: "pasta" },
        searchResultId: hit.id,
        queryArgs: { connection_id: resultConnectionId, limit: 10, stream },
      },
      observedConnectionIds: [...connectionIds].sort(),
      observedRecordUris: [...recordUris].sort(),
      toolNames: tools.map(tool => tool.name).sort(),
    },
    toolSchemas: Object.fromEntries(
      tools.map(tool => [
        tool.name,
        {
          properties: Object.fromEntries(
            Object.entries(
              (tool.inputSchema.properties ?? {}) as JsonObject
            ).map(([key, property]) => [
              key,
              (property as JsonObject).type ?? "unknown",
            ])
          ),
          required: [
            ...((tool.inputSchema.required as string[] | undefined) ?? []),
          ].sort(),
        },
      ])
    ),
  }
}

export async function captureExistingClientContract(
  tokenKind?: "client" | "package",
  storedIds?: JsonObject
): Promise<JsonObject> {
  const server = await startServer({
    asPort: 0,
    dbPath: ":memory:",
    ownerAuthPassword: "",
    quiet: true,
    rsPort: 0,
  })
  const asUrl = `http://localhost:${server.asPort}`
  const rsUrl = `http://localhost:${server.rsPort}`
  try {
    await seedFixture(asUrl)
    const clientId = await makeClient(asUrl)
    const tokens = await createTokens(asUrl, rsUrl, clientId)
    return {
      generatedFrom: "3282ac2f5e4687419bf391c2294d2118dd63fd7c",
      ...(tokenKind !== "package"
        ? { client: await replay(rsUrl, tokens.client, "client", storedIds) }
        : {}),
      ...(tokenKind !== "client"
        ? {
            package: await replay(
              rsUrl,
              tokens.package,
              "package",
              storedIds ?? undefined
            ),
          }
        : {}),
      fixture: {
        longTextChars: LONG_TEXT.length,
        recordsPerChild: 2,
        packageChildren: 2,
      },
    }
  } finally {
    server.schedulerManager?.stop?.()
    server.asServer.closeAllConnections?.()
    server.rsServer.closeAllConnections?.()
    await Promise.allSettled([
      new Promise<void>(resolve => server.asServer.close(() => resolve())),
      new Promise<void>(resolve => server.rsServer.close(() => resolve())),
    ])
  }
}

export async function capturePackageResourceSession(
  storedIds: JsonObject
): Promise<JsonObject> {
  const server = await startServer({
    asPort: 0,
    dbPath: ":memory:",
    ownerAuthPassword: "",
    quiet: true,
    rsPort: 0,
  })
  const asUrl = `http://localhost:${server.asPort}`
  const rsUrl = `http://localhost:${server.rsPort}`
  try {
    await seedFixture(asUrl)
    const clientId = await makeClient(asUrl)
    const tokens = await createTokens(asUrl, rsUrl, clientId)
    const init = await rpc(rsUrl, tokens.package, {
      id: 101,
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        capabilities: {},
        clientInfo: {
          name: "ChatGPT package resource fixture",
          version: "1.0",
        },
        protocolVersion: "2025-06-18",
      },
    })
    const sessionId = init.sessionId
    resultOf(init.body)
    await rpc(
      rsUrl,
      tokens.package,
      { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
      sessionId
    )
    const toolList = resultOf(
      (
        await rpc(
          rsUrl,
          tokens.package,
          { id: 102, jsonrpc: "2.0", method: "tools/list", params: {} },
          sessionId
        )
      ).body
    )
    const tools = (toolList.tools ?? []) as Tool[]
    const resourceListResponse = await rpc(
      rsUrl,
      tokens.package,
      { id: 103, jsonrpc: "2.0", method: "resources/list", params: {} },
      sessionId
    )
    const templateListResponse = await rpc(
      rsUrl,
      tokens.package,
      {
        id: 104,
        jsonrpc: "2.0",
        method: "resources/templates/list",
        params: {},
      },
      sessionId
    )
    const resourceList = resourceListResponse.body.result
      ? object(resourceListResponse.body.result)
      : {}
    const templateList = templateListResponse.body.result
      ? object(templateListResponse.body.result)
      : {}
    const resourceTemplates = Array.isArray(templateList.resourceTemplates)
      ? (templateList.resourceTemplates as JsonObject[])
      : []
    const grantsByConnection = new Map<string, string[]>()
    const discoveryTool = tools.find(
      tool => tool.name === "list_package_children"
    )
    if (discoveryTool) {
      const discovery = resultOf(
        (
          await rpc(
            rsUrl,
            tokens.package,
            {
              id: 105,
              jsonrpc: "2.0",
              method: "tools/call",
              params: { name: "list_package_children", arguments: {} },
            },
            sessionId
          )
        ).body
      )
      const collect = (value: unknown): void => {
        if (Array.isArray(value)) return value.forEach(collect)
        if (!value || typeof value !== "object") return
        const row = value as JsonObject
        const source = object(row.source)
        const streams = Array.isArray(row.streams)
          ? (row.streams as JsonObject[])
          : []
        const instanceId = streams
          .flatMap(stream =>
            Array.isArray(stream.instance_ids)
              ? (stream.instance_ids as unknown[])
              : []
          )
          .find((id): id is string => typeof id === "string")
        const connectionId =
          (typeof row.connection_id === "string" && row.connection_id) ||
          (typeof source.connection_id === "string" && source.connection_id) ||
          instanceId
        if (typeof row.grant_id === "string" && connectionId) {
          grantsByConnection.set(connectionId, [
            ...(grantsByConnection.get(connectionId) ?? []),
            row.grant_id,
          ])
        }
        Object.values(row).forEach(collect)
      }
      collect(discovery.structuredContent)
    }
    const oldUris = [
      ...new Set([
        ...((storedIds.recordUris as string[] | undefined) ?? []),
        ...((storedIds.fieldWindowUris as string[] | undefined) ?? []),
      ]),
    ]
    assert(
      oldUris.length > 0,
      "base package fixture has no stored resource URIs"
    )
    const urisToRead = new Set(oldUris)
    const ambiguousLegacyUris: string[] = []
    if (grantsByConnection.size > 0) {
      for (const oldUri of oldUris) {
        const connectionId = connectionIdForResourceUri(oldUri)
        const grants = connectionId
          ? (grantsByConnection.get(connectionId) ?? [])
          : []
        const templateName = oldUri.startsWith("pdpp://field-window/")
          ? "pdpp-field-window"
          : "pdpp-record"
        const template = resourceTemplates.find(
          entry => entry.name === templateName
        )
        assert(
          grants.length > 0,
          `package resource URI has no discovered child: ${oldUri}`
        )
        if (grants.length > 1) ambiguousLegacyUris.push(oldUri)
        if (!template || typeof template.uriTemplate !== "string") continue
        const handle = oldUri.slice(oldUri.lastIndexOf("/") + 1)
        for (const grantId of grants) {
          urisToRead.add(
            String(template.uriTemplate)
              .replace("{grant_id}", encodeURIComponent(grantId))
              .replace("{handle}", handle)
          )
        }
      }
    }
    const resourceReads = await Promise.all(
      [...urisToRead].map(async uri => {
        const response = (
          await rpc(
            rsUrl,
            tokens.package,
            {
              id: randomBytes(4).readUInt32BE(0),
              jsonrpc: "2.0",
              method: "resources/read",
              params: { uri },
            },
            sessionId
          )
        ).body
        const result = response.result ? object(response.result) : {}
        const error = response.error
        const contents = Array.isArray(result.contents)
          ? (result.contents as JsonObject[])
          : []
        return {
          uri,
          error,
          isError: result.isError === true,
          errorCode: object(object(result.structuredContent).error).code,
          contents: contents.map(content => ({
            mimeType: content.mimeType,
            text: content.text,
          })),
        }
      })
    )
    return {
      discoveryGrantIds: [...new Set([...grantsByConnection.values()].flat())],
      resourceDiscovery: {
        resources: resourceList.resources ?? [],
        resourceTemplates,
        ...([
          resourceListResponse.body.error,
          templateListResponse.body.error,
        ].some(Boolean)
          ? {
              errors: [
                resourceListResponse.body.error,
                templateListResponse.body.error,
              ].filter(Boolean),
            }
          : {}),
      },
      resourceReads,
      ambiguousLegacyUris,
      toolNames: tools.map(tool => tool.name),
    }
  } finally {
    server.schedulerManager?.stop?.()
    server.asServer.closeAllConnections?.()
    server.rsServer.closeAllConnections?.()
    await Promise.allSettled([
      new Promise<void>(resolve => server.asServer.close(() => resolve())),
      new Promise<void>(resolve => server.rsServer.close(() => resolve())),
    ])
  }
}

export function writeContract(path: string, contract: JsonObject): void {
  writeFileSync(path, `${JSON.stringify(contract, null, 2)}\n`)
}

export function readContract(path: string): JsonObject {
  return JSON.parse(readFileSync(path, "utf8")) as JsonObject
}
