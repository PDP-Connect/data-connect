// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Confidential-client authentication (server/client-authentication.ts):
// private_key_jwt and client_secret_basic at POST /oauth/token and
// POST /oauth/par behind PDPP_CONFIDENTIAL_CLIENTS, with public clients
// unchanged.

import assert from "node:assert/strict";
import { generateKeyPairSync, type KeyObject, randomUUID, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  type AuthenticatableClient,
  authenticateClientRequest,
  CLIENT_ASSERTION_TYPE_JWT_BEARER,
  createJtiReplayCache,
  digestClientSecret,
} from "../server/client-authentication.ts";
import { closeDb } from "../server/db.ts";
import { startServer } from "../server/index.ts";
import { TEST_RS_INTROSPECTION_CREDENTIALS } from "./helpers/introspection-test-credentials.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ISSUER = "https://as.example";

function makeEs256Key(kid: string): { jwk: Record<string, unknown>; privateKey: KeyObject } {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return { jwk: { ...publicKey.export({ format: "jwk" }), alg: "ES256", kid, use: "sig" }, privateKey };
}

function signAssertion(
  privateKey: KeyObject,
  kid: string,
  claims: Record<string, unknown>,
  alg = "ES256"
): string {
  const header = Buffer.from(JSON.stringify({ alg, kid, typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = sign("sha256", Buffer.from(`${header}.${payload}`), { dsaEncoding: "ieee-p1363", key: privateKey });
  return `${header}.${payload}.${signature.toString("base64url")}`;
}

function claimsFor(clientId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return { aud: ISSUER, exp: now + 120, iat: now, iss: clientId, jti: randomUUID(), sub: clientId, ...overrides };
}

// ─── Unit: authenticateClientRequest ─────────────────────────────────────────

const key = makeEs256Key("k1");
const otherKey = makeEs256Key("k1");
const clients = new Map<string, AuthenticatableClient>([
  [
    "cli_jwt",
    {
      client_id: "cli_jwt",
      client_secret: null,
      metadata: { jwks: { keys: [key.jwk] } },
      token_endpoint_auth_method: "private_key_jwt",
    },
  ],
  [
    "cli_basic",
    {
      client_id: "cli_basic",
      client_secret: digestClientSecret("s3cret"),
      metadata: {},
      token_endpoint_auth_method: "client_secret_basic",
    },
  ],
  ["cli_public", { client_id: "cli_public", client_secret: null, metadata: {}, token_endpoint_auth_method: "none" }],
]);
const lookupClient = async (id: string) => clients.get(id) ?? null;

async function authWith(body: Record<string, unknown>, authorizationHeader?: string) {
  return await authenticateClientRequest({
    authorizationHeader,
    body,
    expectedAudiences: [ISSUER],
    jtiCache: unitJtiCache,
    lookupClient,
  });
}
const unitJtiCache = createJtiReplayCache();

function assertionBody(assertion: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { client_assertion: assertion, client_assertion_type: CLIENT_ASSERTION_TYPE_JWT_BEARER, ...extra };
}

test("private_key_jwt: a valid assertion authenticates the client", async () => {
  const outcome = await authWith(assertionBody(signAssertion(key.privateKey, "k1", claimsFor("cli_jwt"))));
  assert.deepEqual(outcome, { clientId: "cli_jwt", kind: "confidential", method: "private_key_jwt" });
});

test("private_key_jwt: wrong key, wrong aud, expired, missing jti, replayed jti, iss/sub mismatch are rejected", async () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["wrong key", assertionBody(signAssertion(otherKey.privateKey, "k1", claimsFor("cli_jwt")))],
    ["token endpoint aud", assertionBody(signAssertion(key.privateKey, "k1", claimsFor("cli_jwt", { aud: `${ISSUER}/oauth/token` })))],
    ["expired", assertionBody(signAssertion(key.privateKey, "k1", claimsFor("cli_jwt", { exp: Math.floor(Date.now() / 1000) - 3600 })))],
    ["no jti", assertionBody(signAssertion(key.privateKey, "k1", claimsFor("cli_jwt", { jti: "" })))],
    ["sub mismatch", assertionBody(signAssertion(key.privateKey, "k1", claimsFor("cli_jwt", { sub: "cli_other" })))],
    ["body client_id mismatch", assertionBody(signAssertion(key.privateKey, "k1", claimsFor("cli_jwt")), { client_id: "cli_public" })],
    ["public client asserting", assertionBody(signAssertion(key.privateKey, "k1", claimsFor("cli_public")))],
    ["wrong assertion type", { client_assertion: signAssertion(key.privateKey, "k1", claimsFor("cli_jwt")), client_assertion_type: "x" }],
  ];
  for (const [name, body] of cases) {
    const outcome = await authWith(body);
    assert.equal(outcome.kind, "failure", name);
  }
  const replayed = signAssertion(key.privateKey, "k1", claimsFor("cli_jwt"));
  assert.equal((await authWith(assertionBody(replayed))).kind, "confidential");
  const second = await authWith(assertionBody(replayed));
  assert.equal(second.kind, "failure");
  assert.match(second.kind === "failure" ? second.description : "", /jti/);
});

test("client_secret_basic: correct secret accepted, wrong secret and wrong method rejected", async () => {
  const basic = (id: string, secret: string) => `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`;
  assert.deepEqual(await authWith({}, basic("cli_basic", "s3cret")), {
    clientId: "cli_basic",
    kind: "confidential",
    method: "client_secret_basic",
  });
  assert.equal((await authWith({}, basic("cli_basic", "nope"))).kind, "failure");
  assert.equal((await authWith({}, basic("cli_jwt", "s3cret"))).kind, "failure");
  assert.equal((await authWith({ client_id: "cli_basic", client_secret: "s3cret" })).kind, "failure", "no client_secret_post");
});

test("a confidential client cannot fall back to public (client_id only); public clients pass through", async () => {
  assert.equal((await authWith({ client_id: "cli_jwt" })).kind, "failure");
  assert.equal((await authWith({ client_id: "cli_basic" })).kind, "failure");
  assert.deepEqual(await authWith({ client_id: "cli_public" }), { kind: "public" });
  assert.deepEqual(await authWith({ client_id: "cli_unknown" }), { kind: "public" }, "unknown ids keep today's errors");
});

// ─── HTTP: real AS, flag on and off ──────────────────────────────────────────

interface Started {
  asPort: number;
  asServer: { close: (cb: () => void) => unknown; closeAllConnections?: () => void };
  rsServer: { close: (cb: () => void) => unknown; closeAllConnections?: () => void };
}

async function postJson(url: string, body: unknown, headers: Record<string, string> = {}) {
  const resp = await fetch(url, {
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json", ...headers },
    method: "POST",
  });
  const text = await resp.text();
  return { body: text ? (JSON.parse(text) as Record<string, unknown>) : {}, status: resp.status };
}

async function postForm(url: string, fields: Record<string, string>, headers: Record<string, string> = {}) {
  const resp = await fetch(url, {
    body: new URLSearchParams(fields).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
    method: "POST",
  });
  const text = await resp.text();
  return { body: text ? (JSON.parse(text) as Record<string, unknown>) : {}, status: resp.status };
}

const REDIRECT = "https://reminders.example/callback";

test("HTTP: confidential clients authenticate at /oauth/par and /oauth/token; public unchanged", async (t) => {
  const previousFlag = process.env.PDPP_CONFIDENTIAL_CLIENTS;
  process.env.PDPP_CONFIDENTIAL_CLIENTS = "1";
  const server = (await startServer({
    asIssuer: ISSUER,
    asPort: 0,
    dbPath: ":memory:",
    introspectionCallerCredentials: TEST_RS_INTROSPECTION_CREDENTIALS,
    ownerAuthPassword: "",
    quiet: true,
    reconcilePolyfillManifests: false,
    rsPort: 0,
  } as Parameters<typeof startServer>[0])) as unknown as Started;
  t.after(async () => {
    server.asServer.closeAllConnections?.();
    server.rsServer.closeAllConnections?.();
    await Promise.allSettled([
      new Promise((resolve) => server.asServer.close(() => resolve(undefined))),
      new Promise((resolve) => server.rsServer.close(() => resolve(undefined))),
    ]);
    closeDb();
    if (previousFlag === undefined) {
      Reflect.deleteProperty(process.env, "PDPP_CONFIDENTIAL_CLIENTS");
    } else {
      process.env.PDPP_CONFIDENTIAL_CLIENTS = previousFlag;
    }
  });
  const asUrl = `http://127.0.0.1:${server.asPort}`;

  const manifest = JSON.parse(readFileSync(join(__dirname, "../fixtures/seed-manifests/spotify.json"), "utf8"));
  const connector = await postJson(`${asUrl}/connectors`, manifest);
  assert.equal(connector.status, 201, JSON.stringify(connector.body));
  const authorizationDetails = [
    {
      access_mode: "continuous",
      purpose_code: "https://pdpp.dev/purpose/personal_ai_assistant",
      purpose_description: "confidential client test",
      source: { id: manifest.connector_id, kind: "connector" },
      streams: [{ name: "*" }],
      type: "https://pdpp.dev/data-access",
    },
  ];

  const metadata = (await fetch(`${asUrl}/.well-known/oauth-authorization-server`).then((r) => r.json())) as Record<string, unknown>;
  assert.deepEqual(metadata.token_endpoint_auth_methods_supported, ["none", "private_key_jwt", "client_secret_basic"]);

  const jwtKey = makeEs256Key("reminder-1");
  const jwtClient = await postJson(`${asUrl}/oauth/register`, {
    client_name: "Reminder (private_key_jwt)",
    grant_types: ["authorization_code", "refresh_token"],
    jwks: { keys: [jwtKey.jwk] },
    redirect_uris: [REDIRECT],
    response_types: ["code"],
    token_endpoint_auth_method: "private_key_jwt",
  });
  assert.equal(jwtClient.status, 201, JSON.stringify(jwtClient.body));
  assert.equal(jwtClient.body.token_endpoint_auth_method, "private_key_jwt");
  assert.equal(jwtClient.body.client_secret, undefined);
  const jwtClientId = String(jwtClient.body.client_id);

  const rejectedPrivate = await postJson(`${asUrl}/oauth/register`, {
    jwks: { keys: [{ ...jwtKey.jwk, d: "AAAA" }] },
    redirect_uris: [REDIRECT],
    token_endpoint_auth_method: "private_key_jwt",
  });
  assert.equal(rejectedPrivate.status, 400, "private keys in jwks are refused");

  const basicClient = await postJson(`${asUrl}/oauth/register`, {
    grant_types: ["authorization_code", "refresh_token"],
    redirect_uris: [REDIRECT],
    response_types: ["code"],
    token_endpoint_auth_method: "client_secret_basic",
  });
  assert.equal(basicClient.status, 201, JSON.stringify(basicClient.body));
  assert.equal(typeof basicClient.body.client_secret, "string");
  assert.equal(basicClient.body.client_secret_expires_at, 0);

  const publicClient = await postJson(`${asUrl}/oauth/register`, {
    grant_types: ["authorization_code"],
    redirect_uris: [REDIRECT],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  });
  assert.equal(publicClient.status, 201);

  // PAR: private_key_jwt accepted, missing or forged assertion refused.
  const parOk = await postJson(`${asUrl}/oauth/par`, {
    authorization_details: authorizationDetails,
    client_assertion: signAssertion(jwtKey.privateKey, "reminder-1", claimsFor(jwtClientId)),
    client_assertion_type: CLIENT_ASSERTION_TYPE_JWT_BEARER,
    client_id: jwtClientId,
  });
  assert.equal(parOk.status, 201, JSON.stringify(parOk.body));
  assert.equal(typeof parOk.body.request_uri, "string");

  const parNoAuth = await postJson(`${asUrl}/oauth/par`, {
    authorization_details: authorizationDetails,
    client_id: jwtClientId,
  });
  assert.equal(parNoAuth.status, 401);
  assert.equal(parNoAuth.body.error, "invalid_client");

  const parForged = await postJson(`${asUrl}/oauth/par`, {
    authorization_details: authorizationDetails,
    client_assertion: signAssertion(makeEs256Key("reminder-1").privateKey, "reminder-1", claimsFor(jwtClientId)),
    client_assertion_type: CLIENT_ASSERTION_TYPE_JWT_BEARER,
  });
  assert.equal(parForged.status, 401);

  // PAR: public client unchanged.
  const parPublic = await postJson(`${asUrl}/oauth/par`, {
    authorization_details: authorizationDetails,
    client_id: String(publicClient.body.client_id),
  });
  assert.equal(parPublic.status, 201, JSON.stringify(parPublic.body));

  // Token endpoint: authentication happens before grant logic. An
  // authenticated client with a bogus code reaches the grant check
  // (400 invalid_grant); an unauthenticated one stops at 401 invalid_client.
  const tokenAuthed = await postForm(`${asUrl}/oauth/token`, {
    client_assertion: signAssertion(jwtKey.privateKey, "reminder-1", claimsFor(jwtClientId)),
    client_assertion_type: CLIENT_ASSERTION_TYPE_JWT_BEARER,
    code: "bogus",
    code_verifier: "v".repeat(43),
    grant_type: "authorization_code",
    redirect_uri: REDIRECT,
  });
  assert.equal(tokenAuthed.status, 400, JSON.stringify(tokenAuthed.body));
  assert.notEqual(tokenAuthed.body.error, "invalid_client");

  const tokenUnauthed = await postForm(`${asUrl}/oauth/token`, {
    client_id: jwtClientId,
    grant_type: "refresh_token",
    refresh_token: "bogus",
  });
  assert.equal(tokenUnauthed.status, 401);
  assert.equal(tokenUnauthed.body.error, "invalid_client");

  const basicHeader = (secret: string) =>
    `Basic ${Buffer.from(`${basicClient.body.client_id}:${secret}`).toString("base64")}`;
  const basicOk = await postForm(
    `${asUrl}/oauth/token`,
    { grant_type: "refresh_token", refresh_token: "bogus" },
    { Authorization: basicHeader(String(basicClient.body.client_secret)) }
  );
  assert.equal(basicOk.status, 400, JSON.stringify(basicOk.body));
  assert.equal(basicOk.body.error, "invalid_grant");
  const basicBad = await postForm(
    `${asUrl}/oauth/token`,
    { grant_type: "refresh_token", refresh_token: "bogus" },
    { Authorization: basicHeader("wrong") }
  );
  assert.equal(basicBad.status, 401);

  const publicToken = await postForm(`${asUrl}/oauth/token`, {
    client_id: String(publicClient.body.client_id),
    code: "bogus",
    code_verifier: "v".repeat(43),
    grant_type: "authorization_code",
    redirect_uri: REDIRECT,
  });
  assert.equal(publicToken.status, 400, "public client still reaches the grant check without credentials");

  // Flag off: registration and metadata fall back to public-only.
  Reflect.deleteProperty(process.env, "PDPP_CONFIDENTIAL_CLIENTS");
  const offMetadata = (await fetch(`${asUrl}/.well-known/oauth-authorization-server`).then((r) => r.json())) as Record<
    string,
    unknown
  >;
  assert.deepEqual(offMetadata.token_endpoint_auth_methods_supported, ["none"]);
  const offRegister = await postJson(`${asUrl}/oauth/register`, {
    jwks: { keys: [jwtKey.jwk] },
    redirect_uris: [REDIRECT],
    token_endpoint_auth_method: "private_key_jwt",
  });
  assert.equal(offRegister.status, 400);
});
