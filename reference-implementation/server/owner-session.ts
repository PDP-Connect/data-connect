// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
export {
  OWNER_AUTH_COOKIE_NAME,
  OWNER_AUTH_DEFAULT_SESSION_TTL_SECONDS,
  OWNER_AUTH_DEFAULT_SUBJECT_ID,
  OWNER_SESSION_COOKIE_NAME,
  OWNER_SESSION_DEFAULT_SUBJECT_ID,
  OWNER_SESSION_DEFAULT_TTL_SECONDS,
} from "./owner-session-constants.ts";
import {
  OWNER_SESSION_COOKIE_NAME,
  OWNER_SESSION_DEFAULT_SUBJECT_ID,
  OWNER_SESSION_DEFAULT_TTL_SECONDS,
} from "./owner-session-constants.ts";

export type OwnerSessionSecret = string | Uint8Array;

export interface OwnerSessionPayload {
  readonly exp: number;
  readonly iat: number;
  readonly sub: string;
}

export interface OwnerSessionRecord extends OwnerSessionPayload {
  readonly idHash: string;
  readonly publicId: string;
  readonly label: string | null;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  readonly deviceKey: string | null;
  readonly lastSeenAt: number;
  readonly revokedAt: number | null;
}

export interface OwnerSessionSummary {
  readonly id: string;
  readonly label: string;
  readonly createdAt: number;
  readonly lastSeenAt: number;
  readonly ipAddress: string | null;
  readonly current: boolean;
}

export interface OwnerBearerSummary {
  readonly id: string;
  readonly label: string;
  readonly createdAt: string;
  readonly expiresAt: string | null;
}

type MaybePromise<T> = T | Promise<T>;

export interface OwnerSessionStore {
  createSession: (record: OwnerSessionRecord, expectedCredentialRevision?: string) => MaybePromise<boolean | void>;
  readSession: (idHash: string, nowSeconds: number) => MaybePromise<OwnerSessionRecord | null>;
  revokeSession: (idHash: string, nowSeconds: number) => MaybePromise<void>;
  touchSession: (idHash: string, nowSeconds: number) => MaybePromise<void>;
  listSessions: (subjectId: string, nowSeconds: number) => MaybePromise<readonly OwnerSessionRecord[]>;
  revokeOtherSessions: (subjectId: string, keepIdHash: string, nowSeconds: number) => MaybePromise<void>;
  revokeAllSessions: (subjectId: string, nowSeconds: number) => MaybePromise<void>;
  revokeByPublicId: (subjectId: string, publicId: string, nowSeconds: number) => MaybePromise<boolean>;
  listOwnerBearers: (subjectId: string, nowSeconds: number) => MaybePromise<readonly OwnerBearerSummary[]>;
  revokeOwnerBearer: (subjectId: string, publicId: string, nowSeconds: number) => MaybePromise<boolean>;
}

export interface OwnerSessionIssueMetadata {
  readonly credentialRevision?: string;
  readonly deviceKey?: string | null;
  readonly ipAddress?: string | null;
  readonly label?: string | null;
  readonly userAgent?: string | null;
}

export type OwnerSessionSameSite = "lax" | "strict";

export interface OwnerSessionControllerOptions {
  readonly enabled?: boolean;
  readonly forceSecureCookies?: boolean;
  readonly password?: string | null;
  readonly sameSite?: OwnerSessionSameSite;
  readonly sessionStore: OwnerSessionStore;
  readonly sessionTtlSeconds?: number;
  readonly subjectId?: string | null;
}

export interface OwnerSessionCookieOptions {
  readonly sameSite?: OwnerSessionSameSite;
  readonly secure?: boolean;
}

export interface OwnerSessionSetCookieOptions extends OwnerSessionCookieOptions {
  readonly maxAgeSeconds?: number;
}

export interface OwnerSessionController {
  clearSessionCookieHeader: (opts?: OwnerSessionCookieOptions) => string;
  readonly enabled: boolean;
  issueSessionCookieHeader: (opts?: OwnerSessionCookieOptions, metadata?: OwnerSessionIssueMetadata) => Promise<string | null>;
  readSessionFromCookieValue: (raw?: string | null) => Promise<OwnerSessionPayload | null>;
  readSessionFromCookieHeader: (header?: string | null) => Promise<OwnerSessionPayload | null>;
  readSessionRecordFromCookieHeader: (header?: string | null) => Promise<OwnerSessionRecord | null>;
  revokeSessionFromCookieHeader: (header?: string | null) => Promise<boolean>;
  revokeSessionFromCookieValue: (raw?: string | null) => Promise<boolean>;
  revokeSessionByPublicId: (subjectId: string, publicId: string) => Promise<boolean>;
  revokeOtherSessions: (header: string | null | undefined, subjectId: string) => Promise<void>;
  revokeAllSessions: (subjectId: string) => Promise<void>;
  listSessions: (subjectId: string, header?: string | null) => Promise<readonly OwnerSessionSummary[]>;
  listOwnerBearers: (subjectId: string) => Promise<readonly OwnerBearerSummary[]>;
  revokeOwnerBearer: (subjectId: string, publicId: string) => Promise<boolean>;
  readonly subjectId: string;
}

function base64UrlEncode(input: string): string {
  return Buffer.from(input).toString("base64url");
}

function base64UrlDecodeToString(input: string): string {
  return Buffer.from(String(input), "base64url").toString("utf8");
}

function timingSafeEqualString(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function signPayload(payload: string, secret: OwnerSessionSecret): string {
  return crypto.createHmac("sha256", secret).update(payload).digest("base64url");
}

function coerceOwnerSessionPayload(value: unknown): OwnerSessionPayload | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.exp !== "number") {
    return null;
  }
  const sub = typeof candidate.sub === "string" ? candidate.sub : "";
  const iat = typeof candidate.iat === "number" ? candidate.iat : 0;
  return { exp: candidate.exp, iat, sub };
}

export function encodeOwnerSession(payload: OwnerSessionPayload, secret: OwnerSessionSecret): string {
  const body = base64UrlEncode(JSON.stringify(payload));
  const sig = signPayload(body, secret);
  return `${body}.${sig}`;
}

export function decodeOwnerSession(
  token: string,
  secret: OwnerSessionSecret,
  { nowSeconds = Math.floor(Date.now() / 1000) }: { nowSeconds?: number } = {}
): OwnerSessionPayload | null {
  if (typeof token !== "string" || !token.includes(".")) {
    return null;
  }
  const [body, sig] = token.split(".", 2);
  if (!(body && sig)) {
    return null;
  }
  const expectedSig = signPayload(body, secret);
  if (!timingSafeEqualString(sig, expectedSig)) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(base64UrlDecodeToString(body));
  } catch {
    return null;
  }
  const payload = coerceOwnerSessionPayload(parsed);
  if (!payload) {
    return null;
  }
  if (payload.exp <= nowSeconds) {
    return null;
  }
  return payload;
}

/**
 * Derive the HMAC signing secret for the legacy signed-session helpers.
 *
 * Previously this was a single-round SHA-256 hash, which is GPU-fast and
 * offline-brute-forceable if a session cookie leaks. Replaced with scrypt at
 * the same cost parameters used by credential-encryption.ts (N=16384, r=8,
 * p=1) to match the ~100 000× work factor increase.
 *
 * The domain string "pdpp-owner-session-kdf-v1" acts as a fixed application
 * salt that defeats cross-context rainbow tables. The password itself is the
 * per-server variable, so no additional random salt storage is required for
 * this placeholder auth implementation.
 *
 * Migration note: existing signed pdpp_owner_session cookies issued under the old
 * SHA-256 derivation will fail HMAC verification and be silently rejected —
 * the owner must log in again after deploying this change. This is acceptable
 * for the placeholder single-owner auth model.
 */
export function deriveOwnerSessionSecret(password: string): Buffer {
  const domainSalt = Buffer.from("pdpp-owner-session-kdf-v1", "utf8");
  return crypto.scryptSync(password, domainSalt, 32, { maxmem: 64 * 1024 * 1024, N: 16_384, p: 1, r: 8 });
}

export function parseCookieHeader(header?: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header || typeof header !== "string") {
    return out;
  }
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) {
      continue;
    }
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!name) {
      continue;
    }
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

function hashOwnerSessionId(sessionId: string): string {
  return crypto.createHash("sha256").update(sessionId).digest("base64url");
}

function generateOwnerSessionId(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export function createMemoryOwnerSessionStore(): OwnerSessionStore {
  const sessions = new Map<string, OwnerSessionRecord>();
  return {
    createSession(record: OwnerSessionRecord): void {
      const reusable = record.deviceKey
        ? [...sessions.entries()].find(([, existing]) => existing.sub === record.sub && existing.deviceKey === record.deviceKey)
        : undefined;
      if (reusable) {
        sessions.delete(reusable[0]);
        sessions.set(record.idHash, { ...record, publicId: reusable[1].publicId });
        return;
      }
      sessions.set(record.idHash, record);
    },
    readSession(idHash: string, nowSeconds: number): OwnerSessionRecord | null {
      const record = sessions.get(idHash) ?? null;
      if (!record || record.revokedAt !== null || record.exp <= nowSeconds) {
        return null;
      }
      return record;
    },
    revokeSession(idHash: string, nowSeconds: number): void {
      const record = sessions.get(idHash);
      if (!record || record.revokedAt !== null) {
        return;
      }
      sessions.set(idHash, { ...record, revokedAt: nowSeconds });
    },
    touchSession(idHash: string, nowSeconds: number): void {
      const record = sessions.get(idHash);
      if (!record || record.revokedAt !== null || record.exp <= nowSeconds) {
        return;
      }
      sessions.set(idHash, { ...record, lastSeenAt: nowSeconds });
    },
    listSessions(subjectId: string, nowSeconds: number): readonly OwnerSessionRecord[] {
      return [...sessions.values()].filter((record) => record.sub === subjectId && record.revokedAt === null && record.exp > nowSeconds);
    },
    revokeOtherSessions(subjectId: string, keepIdHash: string, nowSeconds: number): void {
      for (const [idHash, record] of sessions) {
        if (record.sub === subjectId && idHash !== keepIdHash && record.revokedAt === null) {
          sessions.set(idHash, { ...record, revokedAt: nowSeconds });
        }
      }
    },
    revokeAllSessions(subjectId: string, nowSeconds: number): void {
      for (const [idHash, record] of sessions) {
        if (record.sub === subjectId && record.revokedAt === null) {
          sessions.set(idHash, { ...record, revokedAt: nowSeconds });
        }
      }
    },
    revokeByPublicId(subjectId: string, publicId: string, nowSeconds: number): boolean {
      for (const [idHash, record] of sessions) {
        if (record.sub === subjectId && record.publicId === publicId && record.revokedAt === null) {
          sessions.set(idHash, { ...record, revokedAt: nowSeconds });
          return true;
        }
      }
      return false;
    },
    listOwnerBearers(): readonly OwnerBearerSummary[] {
      return [];
    },
    revokeOwnerBearer(): boolean {
      return false;
    },
  };
}

export function readOwnerSessionFromCookieValue(
  raw: string | null | undefined,
  secret: OwnerSessionSecret | null | undefined
): OwnerSessionPayload | null {
  if (!secret || typeof raw !== "string" || !raw) {
    return null;
  }
  return decodeOwnerSession(raw, secret);
}

export function readOwnerSessionFromCookieHeader(
  header: string | null | undefined,
  secret: OwnerSessionSecret | null | undefined
): OwnerSessionPayload | null {
  const cookies = parseCookieHeader(header);
  const raw = cookies[OWNER_SESSION_COOKIE_NAME];
  return readOwnerSessionFromCookieValue(raw ?? null, secret);
}

function sameSiteAttribute(mode: OwnerSessionSameSite | undefined): string {
  return mode === "strict" ? "SameSite=Strict" : "SameSite=Lax";
}

export function buildOwnerSessionSetCookie(
  value: string,
  { maxAgeSeconds, sameSite = "lax", secure = false }: OwnerSessionSetCookieOptions = {}
): string {
  const parts = [`${OWNER_SESSION_COOKIE_NAME}=${value}`];
  parts.push("HttpOnly");
  parts.push(sameSiteAttribute(sameSite));
  parts.push("Path=/");
  if (secure) {
    parts.push("Secure");
  }
  if (typeof maxAgeSeconds === "number") {
    parts.push(`Max-Age=${maxAgeSeconds}`);
  }
  return parts.join("; ");
}

export function buildOwnerSessionClearCookie({
  sameSite = "lax",
  secure = false,
}: OwnerSessionCookieOptions = {}): string {
  const parts = [`${OWNER_SESSION_COOKIE_NAME}=`];
  parts.push("HttpOnly");
  parts.push(sameSiteAttribute(sameSite));
  parts.push("Path=/");
  if (secure) {
    parts.push("Secure");
  }
  parts.push("Max-Age=0");
  return parts.join("; ");
}

export function createOwnerSessionController({
  enabled: enabledOverride,
  password,
  subjectId,
  sessionStore,
  sessionTtlSeconds = OWNER_SESSION_DEFAULT_TTL_SECONDS,
  sameSite = "lax",
  forceSecureCookies = false,
}: OwnerSessionControllerOptions): OwnerSessionController {
  const enabled = enabledOverride ?? (typeof password === "string" && password.length > 0);
  const resolvedSubjectId = typeof subjectId === "string" && subjectId ? subjectId : OWNER_SESSION_DEFAULT_SUBJECT_ID;
  const store = sessionStore;

  function resolveCookieFlags({ secure, sameSite: callerSameSite }: OwnerSessionCookieOptions): {
    secure: boolean;
    sameSite: OwnerSessionSameSite;
  } {
    return {
      sameSite: callerSameSite ?? sameSite,
      secure: forceSecureCookies || Boolean(secure),
    };
  }

  async function readSessionRecordFromCookieValue(raw?: string | null): Promise<OwnerSessionRecord | null> {
    if (!enabled) {
      return null;
    }
    if (typeof raw !== "string" || !raw) {
      return null;
  }
    const nowSeconds = Math.floor(Date.now() / 1000);
    const record = await store.readSession(hashOwnerSessionId(raw), nowSeconds);
    if (!record) {
      return null;
    }
    await store.touchSession(record.idHash, nowSeconds);
    return { ...record, lastSeenAt: nowSeconds };
  }

  async function readSessionRecordFromCookieHeader(header?: string | null): Promise<OwnerSessionRecord | null> {
    const cookies = parseCookieHeader(header);
    return readSessionRecordFromCookieValue(cookies[OWNER_SESSION_COOKIE_NAME] ?? null);
  }

  async function readSessionFromCookieHeader(header?: string | null): Promise<OwnerSessionPayload | null> {
    const record = await readSessionRecordFromCookieHeader(header);
    return record ? { exp: record.exp, iat: record.iat, sub: record.sub } : null;
  }

  async function readSessionFromCookieValue(raw?: string | null): Promise<OwnerSessionPayload | null> {
    const record = await readSessionRecordFromCookieValue(raw);
    return record ? { exp: record.exp, iat: record.iat, sub: record.sub } : null;
  }

  async function issueSessionCookieHeader(
    opts: OwnerSessionCookieOptions = {},
    metadata: OwnerSessionIssueMetadata = {}
  ): Promise<string | null> {
    if (!enabled) {
      return null;
    }
    const now = Math.floor(Date.now() / 1000);
    const sessionId = generateOwnerSessionId();
    const idHash = hashOwnerSessionId(sessionId);
    const created = await store.createSession({
      exp: now + sessionTtlSeconds,
      idHash,
      iat: now,
      publicId: crypto.randomBytes(12).toString("base64url"),
      label: metadata.label?.trim().slice(0, 80) || "Unknown device",
      ipAddress: metadata.ipAddress?.slice(0, 64) || null,
      userAgent: metadata.userAgent?.slice(0, 512) || null,
      deviceKey: metadata.deviceKey?.slice(0, 80) || null,
      lastSeenAt: now,
      revokedAt: null,
      sub: resolvedSubjectId,
    }, metadata.credentialRevision);
    if (created === false) return null;
    const flags = resolveCookieFlags(opts);
    return buildOwnerSessionSetCookie(sessionId, {
      maxAgeSeconds: sessionTtlSeconds,
      sameSite: flags.sameSite,
      secure: flags.secure,
    });
  }

  async function revokeSessionFromCookieValue(raw?: string | null): Promise<boolean> {
    if (!enabled || typeof raw !== "string" || !raw) {
      return false;
    }
    const now = Math.floor(Date.now() / 1000);
    const idHash = hashOwnerSessionId(raw);
    const record = await store.readSession(idHash, now);
    await store.revokeSession(idHash, now);
    return record !== null;
  }

  async function revokeSessionFromCookieHeader(header?: string | null): Promise<boolean> {
    const cookies = parseCookieHeader(header);
    return await revokeSessionFromCookieValue(cookies[OWNER_SESSION_COOKIE_NAME] ?? null);
  }

  async function listSessions(subjectId: string, header?: string | null): Promise<readonly OwnerSessionSummary[]> {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const currentCookie = parseCookieHeader(header)[OWNER_SESSION_COOKIE_NAME];
    const currentIdHash = currentCookie ? hashOwnerSessionId(currentCookie) : null;
    return (await store.listSessions(subjectId, nowSeconds)).map((record) => ({
      id: record.publicId,
      label: record.label ?? "Unknown device",
      createdAt: record.iat,
      lastSeenAt: record.lastSeenAt,
      ipAddress: record.ipAddress,
      current: record.idHash === currentIdHash,
    }));
  }

  async function revokeSessionByPublicId(subjectId: string, publicId: string): Promise<boolean> {
    return await store.revokeByPublicId(subjectId, publicId, Math.floor(Date.now() / 1000));
  }

  async function revokeOtherSessions(header: string | null | undefined, subjectId: string): Promise<void> {
    const cookies = parseCookieHeader(header);
    const raw = cookies[OWNER_SESSION_COOKIE_NAME];
    if (!raw) {
      return;
    }
    await store.revokeOtherSessions(subjectId, hashOwnerSessionId(raw), Math.floor(Date.now() / 1000));
  }

  async function revokeAllSessions(subjectId: string): Promise<void> {
    await store.revokeAllSessions(subjectId, Math.floor(Date.now() / 1000));
  }

  async function listOwnerBearers(subjectId: string): Promise<readonly OwnerBearerSummary[]> {
    return await store.listOwnerBearers(subjectId, Math.floor(Date.now() / 1000));
  }

  async function revokeOwnerBearer(subjectId: string, publicId: string): Promise<boolean> {
    return await store.revokeOwnerBearer(subjectId, publicId, Math.floor(Date.now() / 1000));
  }

  function clearSessionCookieHeader(opts: OwnerSessionCookieOptions = {}): string {
    const flags = resolveCookieFlags(opts);
    return buildOwnerSessionClearCookie({ sameSite: flags.sameSite, secure: flags.secure });
  }

  return {
    clearSessionCookieHeader,
    enabled,
    listSessions,
    listOwnerBearers,
    issueSessionCookieHeader,
    readSessionFromCookieValue,
    readSessionFromCookieHeader,
    readSessionRecordFromCookieHeader,
    revokeSessionFromCookieHeader,
    revokeSessionFromCookieValue,
    revokeSessionByPublicId,
    revokeOtherSessions,
    revokeAllSessions,
    revokeOwnerBearer,
    subjectId: resolvedSubjectId,
  };
}
