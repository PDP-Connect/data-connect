// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { createPublicKey, verify as verifySignature } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { fetch as undiciFetch } from "undici";
import type { CimdFetchDependencies } from "./cimd.ts";
import {
  createPinnedDispatcher,
  type DnsLookupAll,
  isGlobalUnicastAddress,
  resolveAllowedAddresses,
} from "./ssrf-guard.ts";

export const OAUTH_JWT_BEARER_CLIENT_ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";

const ASSERTION_MAX_BYTES = 16 * 1024;
const ASSERTION_MAX_AGE_SECONDS = 5 * 60;
const CLOCK_SKEW_SECONDS = 60;
const JWKS_MAX_BYTES = 32 * 1024;
const JWKS_TIMEOUT_MS = 5000;
const JWKS_DEFAULT_TTL_MS = 60_000;
const JWKS_MAX_TTL_MS = 10 * 60_000;

interface JsonRecord {
  [key: string]: unknown;
}

interface JwkSet {
  keys: JsonRecord[];
}

interface CachedJwkSet {
  expiresAt: number;
  value: JwkSet;
}

export interface PrivateKeyJwtClientMetadata {
  jwks?: unknown;
  jwks_uri?: unknown;
  token_endpoint_auth_signing_alg?: unknown;
}

const jwksCache = new Map<string, CachedJwkSet>();

function invalidClient(): Error & { code: string } {
  return Object.assign(new Error("Client authentication failed"), { code: "invalid_client" });
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeJwtSegment(segment: string): JsonRecord | null {
  if (!segment || !/^[A-Za-z0-9_-]+$/.test(segment)) {
    return null;
  }
  try {
    const decoded: unknown = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
    return isRecord(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

function splitAssertion(assertion: unknown): [string, string, string] | null {
  if (typeof assertion !== "string" || Buffer.byteLength(assertion) > ASSERTION_MAX_BYTES) {
    return null;
  }
  const parts = assertion.split(".");
  if (parts.length !== 3 || parts.some((part) => !part || !/^[A-Za-z0-9_-]+$/.test(part))) {
    return null;
  }
  const [header, payload, signature] = parts;
  return header && payload && signature ? [header, payload, signature] : null;
}

/** Read the unverified issuer only to discover which client document to verify. */
export function clientAssertionIssuer(assertion: unknown): string | null {
  const parts = splitAssertion(assertion);
  if (!parts) {
    return null;
  }
  const claims = decodeJwtSegment(parts[1]);
  return typeof claims?.iss === "string" && claims.iss.length > 0 ? claims.iss : null;
}

function remoteJwksUrl(value: unknown): URL {
  if (typeof value !== "string") {
    throw invalidClient();
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidClient();
  }
  const hasDotSegment = url.pathname.split("/").some((segment) => {
    const decoded = segment.replace(/%2e/gi, ".");
    return decoded === "." || decoded === "..";
  });
  if (url.protocol !== "https:" || url.username || url.password || url.hash || !url.pathname || hasDotSegment) {
    throw invalidClient();
  }
  return url;
}

function parseJwkSet(value: unknown): JwkSet {
  if (!isRecord(value) || !Array.isArray(value.keys) || value.keys.length === 0 || value.keys.length > 32) {
    throw invalidClient();
  }
  const keys = value.keys.filter(isRecord);
  if (
    keys.length !== value.keys.length ||
    keys.some((key) => ["d", "p", "q", "dp", "dq", "qi", "oth"].some((field) => key[field] !== undefined))
  ) {
    throw invalidClient();
  }
  return { keys };
}

function parseMaxAge(headers: Headers): number {
  const match = (headers.get("cache-control") || "").match(/max-age\s*=\s*(\d+)/i);
  if (!match?.[1]) {
    return JWKS_DEFAULT_TTL_MS;
  }
  return Math.min(Number.parseInt(match[1], 10) * 1000, JWKS_MAX_TTL_MS);
}

async function responseJsonWithinLimit(response: Pick<Response, "body" | "text">): Promise<unknown> {
  const reader = response.body?.getReader();
  let body = "";
  let bytesRead = 0;
  if (reader) {
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      bytesRead += value.byteLength;
      if (bytesRead > JWKS_MAX_BYTES) {
        await reader.cancel();
        throw invalidClient();
      }
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
  } else {
    body = await response.text();
    bytesRead = Buffer.byteLength(body);
    if (bytesRead > JWKS_MAX_BYTES) {
      throw invalidClient();
    }
  }
  try {
    return JSON.parse(body);
  } catch {
    throw invalidClient();
  }
}

async function fetchRemoteJwkSet(
  uri: string,
  dependencies: CimdFetchDependencies,
  refresh = false
): Promise<JwkSet> {
  const cached = jwksCache.get(uri);
  const nowMs = dependencies.nowMs ?? Date.now();
  if (!refresh && cached && cached.expiresAt > nowMs) {
    return cached.value;
  }

  const url = remoteJwksUrl(uri);
  const dnsLookupImpl: DnsLookupAll =
    dependencies.dnsLookupImpl ?? ((hostname, options) => dnsLookup(hostname, options));
  const resolved = await resolveAllowedAddresses(url.hostname, {
    dnsLookupImpl,
    isGlobalUnicastAddressImpl: dependencies.isGlobalUnicastAddressImpl ?? isGlobalUnicastAddress,
  });
  if (!resolved.ok) {
    throw invalidClient();
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), JWKS_TIMEOUT_MS);
  const dispatcher = createPinnedDispatcher(resolved.addresses);
  try {
    const fetchImpl = dependencies.fetchImpl ?? undiciFetch;
    const response = await fetchImpl(uri, {
      dispatcher,
      headers: { Accept: "application/json" },
      redirect: "manual",
      signal: controller.signal,
    });
    if (!response.ok || (response.status >= 300 && response.status < 400)) {
      throw invalidClient();
    }
    const value = parseJwkSet(await responseJsonWithinLimit(response));
    jwksCache.set(uri, { expiresAt: nowMs + parseMaxAge(response.headers), value });
    return value;
  } catch {
    throw invalidClient();
  } finally {
    clearTimeout(timeoutId);
    dispatcher.close().catch(() => undefined);
  }
}

async function readJwkSet(
  metadata: PrivateKeyJwtClientMetadata,
  dependencies: CimdFetchDependencies,
  refreshRemote = false
): Promise<JwkSet> {
  if (metadata.jwks !== undefined) {
    return parseJwkSet(metadata.jwks);
  }
  if (typeof metadata.jwks_uri !== "string") {
    throw invalidClient();
  }
  return await fetchRemoteJwkSet(metadata.jwks_uri, dependencies, refreshRemote);
}

function matchingRsaKeys(jwks: JwkSet, kid: unknown): JsonRecord[] {
  return jwks.keys.filter((key) => {
    if (
      key.kty !== "RSA" ||
      typeof key.n !== "string" ||
      typeof key.e !== "string" ||
      (key.use !== undefined && key.use !== "sig") ||
      (key.alg !== undefined && key.alg !== "RS256") ||
      (key.key_ops !== undefined && (!Array.isArray(key.key_ops) || !key.key_ops.includes("verify")))
    ) {
      return false;
    }
    return kid === undefined || key.kid === kid;
  });
}

function assertionSignatureIsValid(
  encodedInput: string,
  encodedSignature: string,
  jwks: JwkSet,
  kid: unknown
): boolean {
  const candidates = matchingRsaKeys(jwks, kid);
  if (candidates.length !== 1) {
    return false;
  }
  try {
    const publicKey = createPublicKey({
      key: candidates[0] as import("node:crypto").webcrypto.JsonWebKey,
      format: "jwk",
    });
    if (
      publicKey.asymmetricKeyType !== "rsa" ||
      (publicKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
    ) {
      return false;
    }
    return verifySignature(
      "RSA-SHA256",
      Buffer.from(encodedInput),
      publicKey,
      Buffer.from(encodedSignature, "base64url")
    );
  } catch {
    return false;
  }
}

function claimsAreValid(claims: JsonRecord, clientId: string, tokenEndpoint: string, nowSeconds: number): boolean {
  const audienceMatches =
    claims.aud === tokenEndpoint || (Array.isArray(claims.aud) && claims.aud.includes(tokenEndpoint));
  if (claims.iss !== clientId || claims.sub !== clientId || !audienceMatches || typeof claims.exp !== "number") {
    return false;
  }
  if (!Number.isFinite(claims.exp) || claims.exp <= nowSeconds - CLOCK_SKEW_SECONDS) {
    return false;
  }
  if (claims.exp > nowSeconds + ASSERTION_MAX_AGE_SECONDS + CLOCK_SKEW_SECONDS) {
    return false;
  }
  if (claims.iat !== undefined) {
    if (
      typeof claims.iat !== "number" ||
      !Number.isFinite(claims.iat) ||
      claims.iat > nowSeconds + CLOCK_SKEW_SECONDS ||
      claims.iat < nowSeconds - ASSERTION_MAX_AGE_SECONDS - CLOCK_SKEW_SECONDS ||
      claims.exp <= claims.iat
    ) {
      return false;
    }
  }
  return (
    claims.nbf === undefined ||
    (typeof claims.nbf === "number" && Number.isFinite(claims.nbf) && claims.nbf <= nowSeconds + CLOCK_SKEW_SECONDS)
  );
}

export async function verifyPrivateKeyJwtClientAssertion({
  assertion,
  clientId,
  metadata,
  tokenEndpoint,
  dependencies = {},
  nowSeconds = Math.floor(Date.now() / 1000),
}: {
  assertion: unknown;
  clientId: string;
  metadata: PrivateKeyJwtClientMetadata;
  tokenEndpoint: string;
  dependencies?: CimdFetchDependencies;
  nowSeconds?: number;
}): Promise<void> {
  if (metadata.token_endpoint_auth_signing_alg !== undefined && metadata.token_endpoint_auth_signing_alg !== "RS256") {
    throw invalidClient();
  }
  const parts = splitAssertion(assertion);
  if (!parts) {
    throw invalidClient();
  }
  const [encodedHeader, encodedClaims, encodedSignature] = parts;
  const header = decodeJwtSegment(encodedHeader);
  const claims = decodeJwtSegment(encodedClaims);
  if (
    !header ||
    !claims ||
    header.alg !== "RS256" ||
    (header.typ !== undefined && header.typ !== "JWT") ||
    (header.b64 !== undefined && header.b64 !== true) ||
    (header.crit !== undefined && (!Array.isArray(header.crit) || header.crit.length > 0)) ||
    (header.kid !== undefined && typeof header.kid !== "string") ||
    !claimsAreValid(claims, clientId, tokenEndpoint, nowSeconds)
  ) {
    throw invalidClient();
  }

  const signingInput = `${encodedHeader}.${encodedClaims}`;
  const jwks = await readJwkSet(metadata, dependencies);
  if (assertionSignatureIsValid(signingInput, encodedSignature, jwks, header.kid)) {
    return;
  }
  if (typeof metadata.jwks_uri === "string" && metadata.jwks === undefined) {
    const refreshedJwks = await readJwkSet(metadata, dependencies, true);
    if (assertionSignatureIsValid(signingInput, encodedSignature, refreshedJwks, header.kid)) {
      return;
    }
  }
  throw invalidClient();
}
