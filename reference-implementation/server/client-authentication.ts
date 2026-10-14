// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Confidential-client authentication for dynamically registered clients.
//
// Off by default. With PDPP_CONFIDENTIAL_CLIENTS=1 the AS additionally
// accepts two RFC 7591 `token_endpoint_auth_method` values at registration
// and authenticates those clients at POST /oauth/token and POST /oauth/par:
//
//   private_key_jwt      RFC 7523 JWT assertion (`client_assertion_type` =
//                        urn:ietf:params:oauth:client-assertion-type:jwt-bearer)
//                        signed by a key in the client's registered `jwks`.
//                        Following the PDPP v0.1 lifecycle text (PR #401,
//                        "Assertions and proofs"): `aud` MUST be the AS
//                        issuer identifier, `jti` MUST be present and
//                        non-empty, and a `jti` already accepted for that
//                        client is rejected while that assertion is valid.
//   client_secret_basic  RFC 6749 Section 2.3.1 HTTP Basic. The AS generates
//                        the secret at registration, returns it once, and
//                        stores only its SHA-256 digest.
//
// Public clients (`none`) are untouched: when the flag is off this module is
// never mounted, and when it is on a request that presents no client
// credentials and names a public client passes through unchanged. Core
// (v0.1.0 review text, PR #374) leaves client authentication to the OAuth
// binding; these are the standard OAuth methods, nothing PDPP-specific.

import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify as cryptoVerify } from "node:crypto";

export const CONFIDENTIAL_CLIENTS_ENV = "PDPP_CONFIDENTIAL_CLIENTS";
export const CLIENT_ASSERTION_TYPE_JWT_BEARER = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
export const CONFIDENTIAL_CLIENT_AUTH_METHODS: readonly string[] = ["private_key_jwt", "client_secret_basic"];
export const CLIENT_ASSERTION_SIGNING_ALGS: readonly string[] = ["ES256", "EdDSA", "RS256"];

const CLIENT_SECRET_DIGEST_PREFIX = "sha256:";
const MAX_JWKS_KEYS = 5;
const CLOCK_SKEW_SECONDS = 60;
// An assertion is single-shot; anything living longer than this is refused so
// the replay cache stays bounded.
const MAX_ASSERTION_LIFETIME_SECONDS = 600;
const BASIC_PREFIX_RE = /^Basic\s+/i;

export function confidentialClientAuthEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env[CONFIDENTIAL_CLIENTS_ENV] || "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

export function isConfidentialClientAuthMethod(method: unknown): boolean {
  return typeof method === "string" && CONFIDENTIAL_CLIENT_AUTH_METHODS.includes(method);
}

export function supportedTokenEndpointAuthMethods(env: NodeJS.ProcessEnv = process.env): string[] {
  return confidentialClientAuthEnabled(env) ? ["none", ...CONFIDENTIAL_CLIENT_AUTH_METHODS] : ["none"];
}

// ─── Registration helpers ────────────────────────────────────────────────────

export interface ClientJwks {
  keys: Record<string, unknown>[];
}

function metadataError(message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = "invalid_client_metadata";
  return err;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Validates an inline RFC 7591 `jwks` value: 1-5 public signing keys. */
export function normalizeClientJwks(value: unknown): ClientJwks {
  if (!(isPlainObject(value) && Array.isArray(value.keys))) {
    throw metadataError("jwks must be an object with a keys array");
  }
  const keys = value.keys;
  if (keys.length === 0 || keys.length > MAX_JWKS_KEYS) {
    throw metadataError(`jwks must contain between 1 and ${MAX_JWKS_KEYS} keys`);
  }
  const normalized = keys.map((key, index) => {
    if (!isPlainObject(key)) {
      throw metadataError(`jwks.keys[${index}] must be an object`);
    }
    if ("d" in key || "p" in key || "q" in key || "k" in key) {
      throw metadataError(`jwks.keys[${index}] must be a public key`);
    }
    if (key.use !== undefined && key.use !== "sig") {
      throw metadataError(`jwks.keys[${index}].use must be sig`);
    }
    const supported =
      (key.kty === "EC" && key.crv === "P-256") || (key.kty === "OKP" && key.crv === "Ed25519") || key.kty === "RSA";
    if (!supported) {
      throw metadataError(`jwks.keys[${index}] must be an EC P-256, OKP Ed25519, or RSA key`);
    }
    try {
      createPublicKey({ format: "jwk", key: key as never });
    } catch {
      throw metadataError(`jwks.keys[${index}] is not a valid public key`);
    }
    return { ...key };
  });
  return { keys: normalized };
}

export function digestClientSecret(secret: string): string {
  return `${CLIENT_SECRET_DIGEST_PREFIX}${createHash("sha256").update(secret, "utf8").digest("base64url")}`;
}

/** Generates a client secret; persist only `storedDigest`. */
export function generateClientSecret(): { secret: string; storedDigest: string } {
  const secret = `cs_${randomBytes(32).toString("base64url")}`;
  return { secret, storedDigest: digestClientSecret(secret) };
}

function verifyClientSecret(presented: string, storedDigest: string | null | undefined): boolean {
  if (!(storedDigest && storedDigest.startsWith(CLIENT_SECRET_DIGEST_PREFIX))) {
    return false;
  }
  const a = Buffer.from(digestClientSecret(presented));
  const b = Buffer.from(storedDigest);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ─── Request authentication ──────────────────────────────────────────────────

export interface AuthenticatableClient {
  client_id: string;
  client_secret: string | null;
  metadata: { jwks?: ClientJwks | undefined };
  token_endpoint_auth_method: string;
}

export type ClientLookup = (clientId: string) => Promise<AuthenticatableClient | null>;

export type ClientAuthOutcome =
  | { kind: "confidential"; clientId: string; method: string }
  | { kind: "public" }
  | { kind: "failure"; error: "invalid_client" | "invalid_request"; description: string; basicChallenge: boolean };

/** Replay cache for assertion `jti` values, keyed per client. */
export interface JtiReplayCache {
  /** Returns false when (clientId, jti) was already accepted and has not expired. */
  claim: (clientId: string, jti: string, expiresAtSeconds: number, nowSeconds: number) => boolean;
}

export function createJtiReplayCache(maxEntries = 100_000): JtiReplayCache {
  const seen = new Map<string, number>();
  return {
    claim(clientId, jti, expiresAtSeconds, nowSeconds) {
      const key = `${clientId}\u0000${jti}`;
      const prior = seen.get(key);
      if (prior !== undefined && prior > nowSeconds) {
        return false;
      }
      if (seen.size >= maxEntries) {
        for (const [k, exp] of seen) {
          if (exp <= nowSeconds) {
            seen.delete(k);
          }
        }
        if (seen.size >= maxEntries) {
          // Still full of live assertions: fail closed rather than forget one.
          return false;
        }
      }
      seen.set(key, expiresAtSeconds);
      return true;
    },
  };
}

function failure(description: string, basicChallenge = false): ClientAuthOutcome {
  return { basicChallenge, description, error: "invalid_client", kind: "failure" };
}

function parseBasicCredentials(header: string | undefined): { clientId: string; secret: string } | null | "malformed" {
  if (typeof header !== "string" || !BASIC_PREFIX_RE.test(header)) {
    return null;
  }
  const decoded = Buffer.from(header.replace(BASIC_PREFIX_RE, "").trim(), "base64").toString("utf8");
  const sep = decoded.indexOf(":");
  if (sep <= 0) {
    return "malformed";
  }
  try {
    // RFC 6749 Section 2.3.1: both parts are form-urlencoded before encoding.
    return {
      clientId: decodeURIComponent(decoded.slice(0, sep).replace(/\+/g, " ")),
      secret: decodeURIComponent(decoded.slice(sep + 1).replace(/\+/g, " ")),
    };
  } catch {
    return "malformed";
  }
}

function decodeJsonSegment(segment: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as unknown;
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function verifyJwsSignature(alg: string, jwk: Record<string, unknown>, signingInput: string, signature: Buffer): boolean {
  let key: ReturnType<typeof createPublicKey>;
  try {
    key = createPublicKey({ format: "jwk", key: jwk as never });
  } catch {
    return false;
  }
  const data = Buffer.from(signingInput, "ascii");
  try {
    if (alg === "ES256") {
      if (!(jwk.kty === "EC" && jwk.crv === "P-256")) {
        return false;
      }
      return cryptoVerify("sha256", data, { dsaEncoding: "ieee-p1363", key }, signature);
    }
    if (alg === "EdDSA") {
      if (!(jwk.kty === "OKP" && jwk.crv === "Ed25519")) {
        return false;
      }
      return cryptoVerify(null, data, key, signature);
    }
    if (alg === "RS256") {
      if (jwk.kty !== "RSA") {
        return false;
      }
      return cryptoVerify("sha256", data, key, signature);
    }
  } catch {
    return false;
  }
  return false;
}

function audienceMatches(aud: unknown, expected: readonly string[]): boolean {
  const values = Array.isArray(aud) ? aud : [aud];
  return values.some((value) => typeof value === "string" && expected.includes(value));
}

async function authenticateAssertion(args: {
  assertion: unknown;
  bodyClientId: string | null;
  expectedAudiences: readonly string[];
  jtiCache: JtiReplayCache;
  lookupClient: ClientLookup;
  nowSeconds: number;
}): Promise<ClientAuthOutcome> {
  const { assertion, bodyClientId, expectedAudiences, jtiCache, lookupClient, nowSeconds } = args;
  if (typeof assertion !== "string") {
    return failure("client_assertion must be a compact JWT");
  }
  const parts = assertion.split(".");
  if (parts.length !== 3) {
    return failure("client_assertion must be a compact JWT");
  }
  const [headerSegment, payloadSegment, signatureSegment] = parts as [string, string, string];
  const header = decodeJsonSegment(headerSegment);
  const claims = decodeJsonSegment(payloadSegment);
  if (!(header && claims)) {
    return failure("client_assertion is not a valid JWT");
  }
  const alg = typeof header.alg === "string" ? header.alg : "";
  if (!CLIENT_ASSERTION_SIGNING_ALGS.includes(alg)) {
    return failure("client_assertion alg is not supported");
  }
  const clientId = typeof claims.iss === "string" ? claims.iss : "";
  if (!clientId || claims.sub !== clientId) {
    return failure("client_assertion iss and sub must both equal the client_id");
  }
  if (bodyClientId && bodyClientId !== clientId) {
    return failure("client_id does not match the client_assertion");
  }
  const client = await lookupClient(clientId);
  if (!client || client.token_endpoint_auth_method !== "private_key_jwt") {
    return failure("client is not registered for private_key_jwt");
  }
  const keys = client.metadata.jwks?.keys ?? [];
  const kid = typeof header.kid === "string" ? header.kid : null;
  const candidates = kid ? keys.filter((k) => k.kid === kid) : keys;
  const signature = Buffer.from(signatureSegment, "base64url");
  const signingInput = `${headerSegment}.${payloadSegment}`;
  if (!candidates.some((jwk) => verifyJwsSignature(alg, jwk, signingInput, signature))) {
    return failure("client_assertion signature does not verify against the registered jwks");
  }
  if (!audienceMatches(claims.aud, expectedAudiences)) {
    return failure("client_assertion aud must be the authorization server issuer identifier");
  }
  const exp = typeof claims.exp === "number" ? claims.exp : null;
  if (exp === null || exp + CLOCK_SKEW_SECONDS <= nowSeconds) {
    return failure("client_assertion is expired or has no exp");
  }
  if (exp - nowSeconds > MAX_ASSERTION_LIFETIME_SECONDS) {
    return failure("client_assertion lifetime is too long");
  }
  if (typeof claims.nbf === "number" && claims.nbf - CLOCK_SKEW_SECONDS > nowSeconds) {
    return failure("client_assertion is not yet valid");
  }
  const jti = typeof claims.jti === "string" ? claims.jti : "";
  if (!jti) {
    return failure("client_assertion must carry a non-empty jti");
  }
  if (!jtiCache.claim(clientId, jti, exp + CLOCK_SKEW_SECONDS, nowSeconds)) {
    return failure("client_assertion jti was already used");
  }
  return { clientId, kind: "confidential", method: "private_key_jwt" };
}

/**
 * Authenticates the client on a token-endpoint-style request. Returns
 * `public` when no client credentials are presented and the named client (if
 * any) is a public client; the caller then proceeds exactly as before.
 */
export async function authenticateClientRequest(args: {
  authorizationHeader: string | undefined;
  body: Record<string, unknown> | null | undefined;
  expectedAudiences: readonly string[];
  jtiCache: JtiReplayCache;
  lookupClient: ClientLookup;
  nowSeconds?: number;
}): Promise<ClientAuthOutcome> {
  const body = args.body ?? {};
  const nowSeconds = args.nowSeconds ?? Math.floor(Date.now() / 1000);
  const bodyClientId = typeof body.client_id === "string" && body.client_id ? body.client_id : null;
  const basic = parseBasicCredentials(args.authorizationHeader);
  const hasAssertion = body.client_assertion !== undefined || body.client_assertion_type !== undefined;

  if (body.client_secret !== undefined) {
    return failure("client_secret_post is not supported; use client_secret_basic or private_key_jwt");
  }
  if (basic && hasAssertion) {
    return { basicChallenge: false, description: "use exactly one client authentication method", error: "invalid_request", kind: "failure" };
  }
  if (hasAssertion) {
    if (body.client_assertion_type !== CLIENT_ASSERTION_TYPE_JWT_BEARER) {
      return failure("unsupported client_assertion_type");
    }
    return await authenticateAssertion({
      assertion: body.client_assertion,
      bodyClientId,
      expectedAudiences: args.expectedAudiences,
      jtiCache: args.jtiCache,
      lookupClient: args.lookupClient,
      nowSeconds,
    });
  }
  if (basic === "malformed") {
    return failure("malformed Basic client credentials", true);
  }
  if (basic) {
    if (bodyClientId && bodyClientId !== basic.clientId) {
      return failure("client_id does not match the Basic credentials", true);
    }
    const client = await args.lookupClient(basic.clientId);
    if (!client || client.token_endpoint_auth_method !== "client_secret_basic") {
      return failure("client is not registered for client_secret_basic", true);
    }
    if (!verifyClientSecret(basic.secret, client.client_secret)) {
      return failure("client authentication failed", true);
    }
    return { clientId: basic.clientId, kind: "confidential", method: "client_secret_basic" };
  }
  if (bodyClientId) {
    const client = await args.lookupClient(bodyClientId);
    if (client && isConfidentialClientAuthMethod(client.token_endpoint_auth_method)) {
      return failure(
        `client must authenticate with ${client.token_endpoint_auth_method}`,
        client.token_endpoint_auth_method === "client_secret_basic"
      );
    }
  }
  return { kind: "public" };
}

// ─── Route middleware ────────────────────────────────────────────────────────

interface MiddlewareRequest {
  body?: Record<string, unknown> | null;
  get: (name: string) => string | undefined;
}

interface MiddlewareResponse {
  json: (body: unknown) => unknown;
  setHeader: (name: string, value: string) => unknown;
  status: (code: number) => MiddlewareResponse;
}

export type ClientAuthMiddleware = (req: MiddlewareRequest, res: MiddlewareResponse, next: () => void) => Promise<void>;

/**
 * Route middleware for POST /oauth/token and POST /oauth/par. On success for a
 * confidential client it pins `body.client_id` to the authenticated client and
 * strips the assertion fields, so the existing handlers run unchanged.
 */
export function buildClientAuthMiddleware(deps: {
  jtiCache?: JtiReplayCache;
  lookupClient: ClientLookup;
  now?: () => number;
  resolveIssuer: (req: MiddlewareRequest) => string;
}): ClientAuthMiddleware {
  const jtiCache = deps.jtiCache ?? createJtiReplayCache();
  return async (req, res, next) => {
    const outcome = await authenticateClientRequest({
      authorizationHeader: req.get("Authorization"),
      body: req.body,
      expectedAudiences: [deps.resolveIssuer(req)],
      jtiCache,
      lookupClient: deps.lookupClient,
      ...(deps.now ? { nowSeconds: Math.floor(deps.now() / 1000) } : {}),
    });
    if (outcome.kind === "public") {
      next();
      return;
    }
    if (outcome.kind === "failure") {
      res.setHeader("Cache-Control", "no-store");
      if (outcome.basicChallenge) {
        res.setHeader("WWW-Authenticate", 'Basic realm="pdpp-token"');
      }
      res.status(outcome.error === "invalid_client" ? 401 : 400).json({
        error: outcome.error,
        error_description: outcome.description,
      });
      return;
    }
    const body = req.body && typeof req.body === "object" ? req.body : {};
    body.client_id = outcome.clientId;
    Reflect.deleteProperty(body, "client_assertion");
    Reflect.deleteProperty(body, "client_assertion_type");
    req.body = body;
    next();
  };
}
